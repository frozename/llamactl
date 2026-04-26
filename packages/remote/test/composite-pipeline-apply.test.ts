/**
 * Composite applier — pipeline-component dispatch (T7).
 *
 * Exercises the new `case 'pipeline'` path through the public
 * `applyComposite` entrypoint. Pipelines persist via the standard
 * `LLAMACTL_RAG_PIPELINES_DIR` store; the test pins it to a tmpdir
 * so each scenario starts with a clean slate. The first-run trigger
 * inside the handler is fire-and-forget (.catch swallow), so the
 * background `ragPipelineRun` promise can fail silently against the
 * unconfigured ragNode without affecting the assertions here.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyComposite } from '../src/composite/apply.js';
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
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-composite-pipeline-apply-'));
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
      queueMicrotask(() => {
        callbacks.onComplete?.();
      });
      return { unsubscribe: () => {} };
    },
  },
  rpcServerStart: { subscribe() { return { unsubscribe: () => {} }; } },
  rpcServerStop: { async mutate() { return {}; } },
  rpcServerDoctor: { async query() { return { ok: true, path: '/fake', llamaCppBin: '/fake' }; } },
};

function pipelineComposite(
  name: string,
  pipelineSpec: Composite['spec']['pipelines'][number]['spec'],
): Composite {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'Composite',
    metadata: { name },
    spec: {
      services: [],
      workloads: [],
      ragNodes: [],
      gateways: [],
      pipelines: [
        {
          name: 'docs-ingest',
          spec: pipelineSpec,
        },
      ],
      dependencies: [],
      onFailure: 'rollback',
    },
  };
}

const baseSpec = {
  destination: { ragNode: 'kb', collection: 'd' },
  sources: [{ kind: 'filesystem' as const, root: '/tmp/docs', glob: '**/*' }],
  transforms: [],
  concurrency: 4,
  on_duplicate: 'skip' as const,
};

describe('composite apply with pipelines', () => {
  test('a composite with one pipeline applies and registers it with ownership', async () => {
    const backend = new FakeRuntimeBackend();
    const result = await applyComposite({
      manifest: pipelineComposite('mc', baseSpec),
      backend,
      getWorkloadClient: () => stubClient,
      configPath,
      compositesDir,
    });
    expect(result.ok).toBe(true);
    const pipelineComp = result.status.components.find((c) => c.ref.kind === 'pipeline');
    expect(pipelineComp?.state).toBe('Ready');
    const stored = loadPipeline('docs-ingest');
    expect(stored?.ownership?.compositeNames).toEqual(['mc']);
  });

  test('idempotent re-apply: second apply produces no new write', async () => {
    const backend = new FakeRuntimeBackend();
    await applyComposite({
      manifest: pipelineComposite('mc', baseSpec),
      backend,
      getWorkloadClient: () => stubClient,
      configPath,
      compositesDir,
    });
    const before = loadPipeline('docs-ingest');
    await applyComposite({
      manifest: pipelineComposite('mc', baseSpec),
      backend,
      getWorkloadClient: () => stubClient,
      configPath,
      compositesDir,
    });
    const after = loadPipeline('docs-ingest');
    expect(after).toEqual(before);
  });

  test('shape conflict between two composites surfaces as Pending', async () => {
    const backend = new FakeRuntimeBackend();
    await applyComposite({
      manifest: pipelineComposite('mc-a', baseSpec),
      backend,
      getWorkloadClient: () => stubClient,
      configPath,
      compositesDir,
    });
    const result = await applyComposite({
      manifest: pipelineComposite('mc-b', { ...baseSpec, concurrency: 8 }),
      backend,
      getWorkloadClient: () => stubClient,
      configPath,
      compositesDir,
    });
    const comp = result.status.components.find((c) => c.ref.kind === 'pipeline');
    expect(comp?.state).toBe('Pending');
    expect(comp?.message).toContain('PipelineShapeMismatch');
  });
});
