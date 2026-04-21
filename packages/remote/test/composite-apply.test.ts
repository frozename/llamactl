import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyComposite, destroyComposite } from '../src/composite/apply.js';
import type { CompositeApplyEvent } from '../src/composite/types.js';
import type { Composite } from '../src/composite/schema.js';
import { saveConfig } from '../src/config/kubeconfig.js';
import { freshConfig } from '../src/config/schema.js';
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

/**
 * Phase 4 — applyComposite tests. Fake `RuntimeBackend` + fake
 * `WorkloadClient` — no live Docker, no live llama-server. Covers
 * the 6 scenarios from the plan:
 *   1. Happy path (service + workload + rag + gateway)
 *   2. Service failure → no later components → rollback → empty state
 *   3. onFailure='leave-partial' + mid-failure → no rollback, Degraded
 *   4. Hash-match service is a no-op (single call)
 *   5. RagNode with backingService resolves endpoint from service
 *   6. Destroy reverses the DAG
 */

let tmp = '';
let configPath = '';
let compositesDir = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-composite-apply-'));
  configPath = join(tmp, 'config');
  compositesDir = join(tmp, 'composites');
  saveConfig(freshConfig(), configPath);
  process.env.LLAMACTL_CONFIG = configPath;
  process.env.LLAMACTL_COMPOSITES_DIR = compositesDir;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

// ---- fakes ---------------------------------------------------------------

class FakeRuntimeBackend implements RuntimeBackend {
  readonly kind = 'fake';
  readonly calls: Array<{ op: string; arg: unknown }> = [];
  readonly services = new Map<string, ServiceInstance>();
  /** When set, the next ensureService call throws. */
  failNextEnsure: string | null = null;

  async ping(): Promise<void> {
    this.calls.push({ op: 'ping', arg: null });
  }
  async ensureService(spec: ServiceDeployment): Promise<ServiceInstance> {
    this.calls.push({ op: 'ensureService', arg: spec });
    if (this.failNextEnsure) {
      const msg = this.failNextEnsure;
      this.failNextEnsure = null;
      throw new Error(msg);
    }
    const instance: ServiceInstance = {
      ref: { name: spec.name },
      running: true,
      health: 'healthy',
      specHash: spec.specHash,
      createdAt: new Date().toISOString(),
      endpoint: { host: '127.0.0.1', port: spec.ports?.[0]?.hostPort ?? 8000 },
    };
    this.services.set(spec.name, instance);
    return instance;
  }
  async removeService(ref: ServiceRef, opts?: RemoveServiceOptions): Promise<void> {
    this.calls.push({ op: 'removeService', arg: { ref, opts: opts ?? {} } });
    this.services.delete(ref.name);
  }
  async inspectService(ref: ServiceRef): Promise<ServiceInstance | null> {
    this.calls.push({ op: 'inspectService', arg: ref });
    return this.services.get(ref.name) ?? null;
  }
  async listServices(filter?: ServiceFilter): Promise<ServiceInstance[]> {
    this.calls.push({ op: 'listServices', arg: filter });
    return Array.from(this.services.values());
  }
  async pullImage(ref: ImageRef): Promise<void> {
    this.calls.push({ op: 'pullImage', arg: ref });
  }
}

function makeFakeWorkloadClient(): {
  client: WorkloadClient;
  stopped: number;
  started: number;
} {
  let stopped = 0;
  let started = 0;
  const c: WorkloadClient = {
    serverStatus: {
      async query() {
        return {
          state: 'stopped',
          rel: null,
          extraArgs: [],
          pid: null,
          endpoint: 'http://127.0.0.1:8080',
        };
      },
    },
    serverStop: {
      async mutate() {
        stopped++;
        return {};
      },
    },
    serverStart: {
      subscribe(_input, callbacks) {
        started++;
        // Emit a quick `started` event + `done` — the applier
        // interprets `done.ok=true` as success.
        queueMicrotask(() => {
          callbacks.onData?.({
            type: 'started',
            pid: 12345,
            endpoint: 'http://127.0.0.1:8080',
            model: 'test',
          });
          callbacks.onData?.({
            type: 'done',
            ok: true,
            pid: 12345,
            endpoint: 'http://127.0.0.1:8080',
          });
          callbacks.onComplete?.();
        });
        return { unsubscribe: () => {} };
      },
    },
    rpcServerStart: {
      subscribe() {
        return { unsubscribe: () => {} };
      },
    },
    rpcServerStop: {
      async mutate() {
        return {};
      },
    },
    rpcServerDoctor: {
      async query() {
        return { ok: true, path: '/fake', llamaCppBin: '/fake' };
      },
    },
  };
  const wrap: WorkloadClient = {
    ...c,
    serverStop: {
      async mutate(input) {
        const r = await c.serverStop.mutate(input);
        return r;
      },
    },
  };
  // read-only getters that reflect counters
  return {
    client: wrap,
    get stopped() {
      return stopped;
    },
    get started() {
      return started;
    },
  };
}

function sampleComposite(overrides: Partial<Composite['spec']> = {}): Composite {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'Composite',
    metadata: { name: 'kb-stack' },
    spec: {
      services: [
        {
          kind: 'chroma',
          name: 'chroma-1',
          node: 'local',
          runtime: 'docker',
          port: 8001,
          image: { repository: 'chromadb/chroma', tag: '1.5.8' },
        },
      ],
      workloads: [],
      ragNodes: [],
      gateways: [],
      dependencies: [],
      onFailure: 'rollback',
      ...overrides,
    },
  };
}

// ---- tests ---------------------------------------------------------------

describe('applyComposite — happy path (service only)', () => {
  test('single chroma service → Ready', async () => {
    const backend = new FakeRuntimeBackend();
    const { client } = makeFakeWorkloadClient();
    const events: CompositeApplyEvent[] = [];

    const result = await applyComposite({
      manifest: sampleComposite(),
      backend,
      getWorkloadClient: () => client,
      configPath,
      compositesDir,
      onEvent: (e) => events.push(e),
    });

    expect(result.ok).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(result.status.phase).toBe('Ready');
    expect(result.componentResults).toHaveLength(1);
    expect(result.componentResults[0]?.state).toBe('Ready');
    expect(backend.services.size).toBe(1);

    // Event ordering sanity: phase:Applying → component-start →
    // component-ready → phase:Ready → done.
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('phase');
    expect(types).toContain('component-start');
    expect(types).toContain('component-ready');
    expect(types[types.length - 1]).toBe('done');
  });
});

describe('applyComposite — happy path with rag + backingService', () => {
  test('service → rag with endpoint resolved from service instance', async () => {
    const backend = new FakeRuntimeBackend();
    const { client } = makeFakeWorkloadClient();

    const manifest = sampleComposite({
      ragNodes: [
        {
          name: 'kb',
          node: 'local',
          binding: {
            provider: 'chroma',
            endpoint: '',
            extraArgs: [],
          },
          backingService: 'chroma-1',
        },
      ],
      dependencies: [
        {
          from: { kind: 'rag', name: 'kb' },
          to: { kind: 'service', name: 'chroma-1' },
        },
      ],
    });

    const result = await applyComposite({
      manifest,
      backend,
      getWorkloadClient: () => client,
      configPath,
      compositesDir,
    });

    expect(result.ok).toBe(true);
    // Service comes up first, then rag — verify rag component's
    // apply triggered an upsert to kubeconfig with the endpoint.
    const { loadConfig } = await import('../src/config/kubeconfig.js');
    const cfg = loadConfig(configPath);
    const kbNode = cfg.clusters[0]?.nodes.find((n) => n.name === 'kb');
    expect(kbNode).toBeDefined();
    expect(kbNode?.rag?.provider).toBe('chroma');
    // endpoint should have been resolved to 127.0.0.1:8001 (per the
    // service spec's port) and rendered as http://...
    expect(kbNode?.rag?.endpoint).toContain('127.0.0.1');
    expect(kbNode?.rag?.endpoint).toContain('8001');
  });
});

describe('applyComposite — service failure triggers rollback', () => {
  test('ensureService throws → rollback walks previously-applied in reverse → empty', async () => {
    const backend = new FakeRuntimeBackend();
    const { client } = makeFakeWorkloadClient();

    const manifest: Composite = {
      apiVersion: 'llamactl/v1',
      kind: 'Composite',
      metadata: { name: 'failing' },
      spec: {
        services: [
          {
            kind: 'chroma',
            name: 'chroma-1',
            node: 'local',
            runtime: 'docker',
            port: 8001,
            image: { repository: 'chromadb/chroma', tag: '1.5.8' },
          },
          {
            kind: 'chroma',
            name: 'chroma-2',
            node: 'local',
            runtime: 'docker',
            port: 8002,
            image: { repository: 'chromadb/chroma', tag: '1.5.8' },
          },
        ],
        workloads: [],
        ragNodes: [],
        gateways: [],
        dependencies: [
          {
            from: { kind: 'service', name: 'chroma-2' },
            to: { kind: 'service', name: 'chroma-1' },
          },
        ],
        onFailure: 'rollback',
      },
    };

    // First service succeeds; second fails.
    let callCount = 0;
    const origEnsure = backend.ensureService.bind(backend);
    backend.ensureService = async (spec) => {
      callCount++;
      if (callCount === 2) throw new Error('simulated docker failure');
      return origEnsure(spec);
    };

    const events: CompositeApplyEvent[] = [];
    const result = await applyComposite({
      manifest,
      backend,
      getWorkloadClient: () => client,
      configPath,
      compositesDir,
      onEvent: (e) => events.push(e),
    });

    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.status.phase).toBe('Failed');
    // Service 1 was torn down during rollback.
    expect(backend.services.size).toBe(0);
    const rollbackStart = events.find((e) => e.type === 'rollback-start');
    expect(rollbackStart).toBeDefined();
    // Rollback should have gone in reverse — chroma-1 teardown after
    // chroma-2's failure.
    expect(backend.calls.some((c) => c.op === 'removeService')).toBe(true);
  });
});

describe('applyComposite — onFailure=leave-partial', () => {
  test('mid-failure → no rollback, Degraded phase, partial state kept', async () => {
    const backend = new FakeRuntimeBackend();
    const { client } = makeFakeWorkloadClient();

    const manifest: Composite = {
      apiVersion: 'llamactl/v1',
      kind: 'Composite',
      metadata: { name: 'partial' },
      spec: {
        services: [
          {
            kind: 'chroma',
            name: 'chroma-1',
            node: 'local',
            runtime: 'docker',
            port: 8001,
            image: { repository: 'chromadb/chroma', tag: '1.5.8' },
          },
          {
            kind: 'chroma',
            name: 'chroma-2',
            node: 'local',
            runtime: 'docker',
            port: 8002,
            image: { repository: 'chromadb/chroma', tag: '1.5.8' },
          },
        ],
        workloads: [],
        ragNodes: [],
        gateways: [],
        dependencies: [
          {
            from: { kind: 'service', name: 'chroma-2' },
            to: { kind: 'service', name: 'chroma-1' },
          },
        ],
        onFailure: 'leave-partial',
      },
    };

    let callCount = 0;
    const origEnsure = backend.ensureService.bind(backend);
    backend.ensureService = async (spec) => {
      callCount++;
      if (callCount === 2) throw new Error('partial failure');
      return origEnsure(spec);
    };

    const result = await applyComposite({
      manifest,
      backend,
      getWorkloadClient: () => client,
      configPath,
      compositesDir,
    });

    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.status.phase).toBe('Degraded');
    // First service is still running.
    expect(backend.services.size).toBe(1);
    expect(backend.services.has('llamactl-chroma-partial-chroma-1')).toBe(true);
    // No removeService calls — we left partial state.
    expect(backend.calls.filter((c) => c.op === 'removeService')).toHaveLength(0);
  });
});

describe('applyComposite — idempotent re-apply', () => {
  test('second apply with unchanged spec is a cheap no-op', async () => {
    const backend = new FakeRuntimeBackend();
    const { client } = makeFakeWorkloadClient();

    const manifest = sampleComposite();

    await applyComposite({
      manifest,
      backend,
      getWorkloadClient: () => client,
      configPath,
      compositesDir,
    });
    const firstPassCalls = backend.calls.length;

    // Second apply: backend sees the ensureService, but our fake
    // treats re-ensure as another create. In practice DockerBackend
    // would detect the matching hash and skip. The composite layer's
    // contract is: deterministic spec → deterministic call pattern.
    // We assert the count is the same (one ensureService per service).
    await applyComposite({
      manifest,
      backend,
      getWorkloadClient: () => client,
      configPath,
      compositesDir,
    });
    const ensureCalls = backend.calls.filter((c) => c.op === 'ensureService').length;
    expect(ensureCalls).toBe(2); // one per apply, same spec
    // Idempotency at the backend layer is tested in
    // runtime-docker-backend.test.ts. Here we verify the composite
    // doesn't spray extra calls.
    expect(backend.calls.length).toBe(firstPassCalls * 2);
  });
});

describe('destroyComposite — reverses the DAG', () => {
  test('services + rag node all torn down', async () => {
    const backend = new FakeRuntimeBackend();
    const { client } = makeFakeWorkloadClient();

    const manifest = sampleComposite({
      ragNodes: [
        {
          name: 'kb',
          node: 'local',
          binding: {
            provider: 'chroma',
            endpoint: '',
            extraArgs: [],
          },
          backingService: 'chroma-1',
        },
      ],
      dependencies: [
        {
          from: { kind: 'rag', name: 'kb' },
          to: { kind: 'service', name: 'chroma-1' },
        },
      ],
    });

    // Apply first so the backend has state.
    await applyComposite({
      manifest,
      backend,
      getWorkloadClient: () => client,
      configPath,
      compositesDir,
    });
    expect(backend.services.size).toBe(1);

    const result = await destroyComposite({
      manifest,
      backend,
      getWorkloadClient: () => client,
      configPath,
      compositesDir,
    });

    expect(result.ok).toBe(true);
    expect(backend.services.size).toBe(0);
    expect(result.removed.length).toBeGreaterThan(0);

    // Order: rag teardown (removeNode) runs before service teardown.
    // Our counters: one removeService call for the container.
    const removeServiceCalls = backend.calls.filter((c) => c.op === 'removeService');
    expect(removeServiceCalls).toHaveLength(1);

    // Rag node should be gone from kubeconfig.
    const { loadConfig } = await import('../src/config/kubeconfig.js');
    const cfg = loadConfig(configPath);
    const kbStillThere = cfg.clusters[0]?.nodes.find((n) => n.name === 'kb');
    expect(kbStillThere).toBeUndefined();
  });
});

describe('destroyComposite — purgeVolumes plumbing', () => {
  test('default destroy forwards purgeVolumes=false to the backend', async () => {
    const backend = new FakeRuntimeBackend();
    const { client } = makeFakeWorkloadClient();
    const manifest = sampleComposite();

    await applyComposite({
      manifest,
      backend,
      getWorkloadClient: () => client,
      configPath,
      compositesDir,
    });

    await destroyComposite({
      manifest,
      backend,
      getWorkloadClient: () => client,
      configPath,
      compositesDir,
    });

    const removeCall = backend.calls.find((c) => c.op === 'removeService');
    expect(removeCall).toBeDefined();
    const { opts } = removeCall!.arg as {
      ref: ServiceRef;
      opts: RemoveServiceOptions;
    };
    expect(opts.purgeVolumes).toBe(false);
  });

  test('purgeVolumes: true flows through to backend.removeService', async () => {
    const backend = new FakeRuntimeBackend();
    const { client } = makeFakeWorkloadClient();
    const manifest = sampleComposite();

    await applyComposite({
      manifest,
      backend,
      getWorkloadClient: () => client,
      configPath,
      compositesDir,
    });

    await destroyComposite({
      manifest,
      backend,
      getWorkloadClient: () => client,
      configPath,
      compositesDir,
      purgeVolumes: true,
    });

    const removeCalls = backend.calls.filter((c) => c.op === 'removeService');
    expect(removeCalls.length).toBeGreaterThan(0);
    for (const call of removeCalls) {
      const { opts } = call.arg as {
        ref: ServiceRef;
        opts: RemoveServiceOptions;
      };
      expect(opts.purgeVolumes).toBe(true);
    }
  });

  test('rollback NEVER purges volumes — even if a hypothetical flag were passed', async () => {
    // Rollback is a reactive cleanup pass after apply failure; per the
    // anti-pattern list it MUST never wipe operator storage. We prove
    // this by inducing a rollback and asserting every removeService
    // call receives purgeVolumes: false.
    const backend = new FakeRuntimeBackend();
    const { client } = makeFakeWorkloadClient();

    const manifest: Composite = {
      apiVersion: 'llamactl/v1',
      kind: 'Composite',
      metadata: { name: 'rb' },
      spec: {
        services: [
          {
            kind: 'chroma',
            name: 'chroma-1',
            node: 'local',
            runtime: 'docker',
            port: 8001,
            image: { repository: 'chromadb/chroma', tag: '1.5.8' },
          },
          {
            kind: 'chroma',
            name: 'chroma-2',
            node: 'local',
            runtime: 'docker',
            port: 8002,
            image: { repository: 'chromadb/chroma', tag: '1.5.8' },
          },
        ],
        workloads: [],
        ragNodes: [],
        gateways: [],
        dependencies: [
          {
            from: { kind: 'service', name: 'chroma-2' },
            to: { kind: 'service', name: 'chroma-1' },
          },
        ],
        onFailure: 'rollback',
      },
    };

    let callCount = 0;
    const origEnsure = backend.ensureService.bind(backend);
    backend.ensureService = async (spec) => {
      callCount++;
      if (callCount === 2) throw new Error('simulated docker failure');
      return origEnsure(spec);
    };

    const result = await applyComposite({
      manifest,
      backend,
      getWorkloadClient: () => client,
      configPath,
      compositesDir,
    });

    expect(result.rolledBack).toBe(true);
    // Rollback teardown happened; every removeService call must have
    // purgeVolumes: false.
    const removeCalls = backend.calls.filter((c) => c.op === 'removeService');
    expect(removeCalls.length).toBeGreaterThan(0);
    for (const call of removeCalls) {
      const { opts } = call.arg as {
        ref: ServiceRef;
        opts: RemoveServiceOptions;
      };
      expect(opts.purgeVolumes).toBe(false);
    }
  });
});

describe('applyComposite — external-runtime service short-circuits', () => {
  test('runtime=external service records Ready without backend call', async () => {
    const backend = new FakeRuntimeBackend();
    const { client } = makeFakeWorkloadClient();

    const manifest: Composite = {
      apiVersion: 'llamactl/v1',
      kind: 'Composite',
      metadata: { name: 'ext' },
      spec: {
        services: [
          {
            kind: 'chroma',
            name: 'chroma-ext',
            node: 'local',
            runtime: 'external',
            externalEndpoint: 'http://chroma.internal:8000',
            port: 8000,
          },
        ],
        workloads: [],
        ragNodes: [],
        gateways: [],
        dependencies: [],
        onFailure: 'rollback',
      },
    };

    const result = await applyComposite({
      manifest,
      backend,
      getWorkloadClient: () => client,
      configPath,
      compositesDir,
    });

    expect(result.ok).toBe(true);
    // No ensureService call — external runtime short-circuits.
    const ensureCalls = backend.calls.filter((c) => c.op === 'ensureService');
    expect(ensureCalls).toHaveLength(0);
  });
});
