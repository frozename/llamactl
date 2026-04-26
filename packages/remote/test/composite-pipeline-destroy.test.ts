/**
 * Composite destroy — pipeline-component dispatch (T7).
 *
 * Verifies the ref-counted teardown path: a single composite's destroy
 * removes its pipeline; co-owned pipelines stay until the last
 * composite goes away. Backed by the same tmpdir scaffolding the
 * apply test uses.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyComposite, destroyComposite } from '../src/composite/apply.js';
import type { Composite } from '../src/composite/schema.js';
import { saveConfig } from '../src/config/kubeconfig.js';
import { freshConfig } from '../src/config/schema.js';
import { loadPipeline } from '../src/rag/pipeline/store.js';
import type {
  ImageRef,
  RemoveServiceOptions,
  RuntimeBackend,
  ServiceDeployment,
  ServiceFilter,
  ServiceInstance,
  ServiceRef,
} from '../src/runtime/backend.js';
import type { WorkloadClient } from '../src/workload/apply.js';

let tmp = '';
let configPath = '';
let compositesDir = '';
let pipelinesRoot = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-composite-pipeline-destroy-'));
  configPath = join(tmp, 'config');
  compositesDir = join(tmp, 'composites');
  pipelinesRoot = join(tmp, 'pipelines');
  saveConfig(freshConfig(), configPath);
  process.env.LLAMACTL_CONFIG = configPath;
  process.env.LLAMACTL_COMPOSITES_DIR = compositesDir;
  process.env.LLAMACTL_RAG_PIPELINES_DIR = pipelinesRoot;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

class FakeRuntimeBackend implements RuntimeBackend {
  readonly kind = 'fake';
  async ping(): Promise<void> {}
  async ensureService(spec: ServiceDeployment): Promise<ServiceInstance> {
    return {
      ref: { name: spec.name },
      running: true,
      health: 'healthy',
      specHash: spec.specHash,
      createdAt: new Date().toISOString(),
      endpoint: { host: '127.0.0.1', port: 8000 },
    };
  }
  async removeService(_ref: ServiceRef, _opts?: RemoveServiceOptions): Promise<void> {}
  async inspectService(_ref: ServiceRef): Promise<ServiceInstance | null> {
    return null;
  }
  async listServices(_filter?: ServiceFilter): Promise<ServiceInstance[]> {
    return [];
  }
  async pullImage(_ref: ImageRef): Promise<void> {}
}

const stubClient: WorkloadClient = {
  serverStatus: { async query() {
    return { state: 'stopped', rel: null, extraArgs: [], pid: null, endpoint: '' };
  } },
  serverStop: { async mutate() { return {}; } },
  serverStart: {
    subscribe(_input, callbacks) {
      queueMicrotask(() => callbacks.onComplete?.());
      return { unsubscribe: () => {} };
    },
  },
  rpcServerStart: { subscribe() { return { unsubscribe: () => {} }; } },
  rpcServerStop: { async mutate() { return {}; } },
  rpcServerDoctor: { async query() { return { ok: true, path: '/fake', llamaCppBin: '/fake' }; } },
};

const baseSpec = {
  destination: { ragNode: 'kb', collection: 'd' },
  sources: [{ kind: 'filesystem' as const, root: '/tmp/docs', glob: '**/*' }],
  transforms: [],
  concurrency: 4,
  on_duplicate: 'skip' as const,
};

function baseManifest(name: string): Composite {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'Composite',
    metadata: { name },
    spec: {
      services: [],
      workloads: [],
      ragNodes: [],
      gateways: [],
      pipelines: [{ name: 'docs-ingest', spec: baseSpec }],
      dependencies: [],
      onFailure: 'rollback',
    },
  };
}

describe('compositeDestroy with pipelines', () => {
  test('single-owner: destroying the composite deletes the pipeline', async () => {
    const backend = new FakeRuntimeBackend();
    await applyComposite({
      manifest: baseManifest('mc'),
      backend,
      getWorkloadClient: () => stubClient,
      configPath,
      compositesDir,
    });
    expect(loadPipeline('docs-ingest')).not.toBeNull();
    await destroyComposite({
      manifest: baseManifest('mc'),
      backend,
      getWorkloadClient: () => stubClient,
      configPath,
      compositesDir,
    });
    expect(loadPipeline('docs-ingest')).toBeNull();
  });

  test('co-owned: destroying one composite leaves the pipeline; destroying both removes it', async () => {
    const backend = new FakeRuntimeBackend();
    await applyComposite({
      manifest: baseManifest('mc-a'),
      backend,
      getWorkloadClient: () => stubClient,
      configPath,
      compositesDir,
    });
    await applyComposite({
      manifest: baseManifest('mc-b'),
      backend,
      getWorkloadClient: () => stubClient,
      configPath,
      compositesDir,
    });
    await destroyComposite({
      manifest: baseManifest('mc-a'),
      backend,
      getWorkloadClient: () => stubClient,
      configPath,
      compositesDir,
    });
    let stored = loadPipeline('docs-ingest');
    expect(stored?.ownership?.compositeNames).toEqual(['mc-b']);

    await destroyComposite({
      manifest: baseManifest('mc-b'),
      backend,
      getWorkloadClient: () => stubClient,
      configPath,
      compositesDir,
    });
    stored = loadPipeline('docs-ingest');
    expect(stored).toBeNull();
  });
});
