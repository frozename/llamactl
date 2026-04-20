import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyComposite, destroyComposite } from '../src/composite/apply.js';
import type { Composite } from '../src/composite/schema.js';
import { saveConfig } from '../src/config/kubeconfig.js';
import { freshConfig } from '../src/config/schema.js';
import { createDockerBackend } from '../src/runtime/docker/backend.js';
import type { WorkloadClient } from '../src/workload/apply.js';

/**
 * Phase 8 — composite E2E smoke. Opt-in; CI skips by default.
 *
 * Two gates, both must be true to run:
 *   1. `LLAMACTL_COMPOSITE_E2E=1` in the environment.
 *   2. The Docker daemon must be reachable (we ping at boot).
 *
 * When it runs, the test:
 *   - Applies a minimal composite containing one `chromadb/chroma`
 *     container.
 *   - Asserts the container is running + healthy via the backend's
 *     inspectService.
 *   - Destroys the composite and asserts the container is gone.
 *
 * Workload + gateway slices are NOT exercised here — they require a
 * live llama-server binary which isn't in scope for this E2E.
 * Phase 4's composite-apply.test.ts covers workload + gateway paths
 * via fakes; this test complements that with a real docker round-trip
 * of the service + runtime surface.
 */

const RUN_GATE = process.env.LLAMACTL_COMPOSITE_E2E === '1';

// Defer the Docker ping to a beforeAll so the skipIf check below is
// fast. If RUN_GATE is false we never ping.
let dockerReachable = false;

let tmp = '';
let configPath = '';
let compositesDir = '';
const originalEnv = { ...process.env };

beforeAll(async () => {
  if (!RUN_GATE) return;
  try {
    const backend = createDockerBackend();
    await backend.ping();
    dockerReachable = true;
  } catch {
    dockerReachable = false;
  }
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-composite-e2e-'));
  configPath = join(tmp, 'config');
  compositesDir = join(tmp, 'composites');
  saveConfig(freshConfig(), configPath);
  process.env.LLAMACTL_CONFIG = configPath;
  process.env.LLAMACTL_COMPOSITES_DIR = compositesDir;
});

afterAll(() => {
  if (!RUN_GATE) return;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

const SHOULD_RUN = RUN_GATE;

function failingWorkloadClient(): WorkloadClient {
  // The minimal E2E composite has no workloads, so this client is
  // never actually called. We supply it anyway to satisfy the
  // applier's signature.
  const err = (): never => {
    throw new Error('workload client should not be called in the service-only composite E2E');
  };
  return {
    serverStatus: { query: err as never },
    serverStop: { mutate: err as never },
    serverStart: { subscribe: err as never },
    rpcServerStart: { subscribe: err as never },
    rpcServerStop: { mutate: err as never },
    rpcServerDoctor: { query: err as never },
  };
}

describe.skipIf(!SHOULD_RUN)('Composite E2E — docker round-trip', () => {
  test(
    'apply + inspect + destroy against a real chroma container',
    async () => {
      if (!dockerReachable) {
        console.warn('[composite-e2e] skipping: docker daemon unreachable');
        return;
      }
      const backend = createDockerBackend();
      const manifest: Composite = {
        apiVersion: 'llamactl/v1',
        kind: 'Composite',
        metadata: { name: 'composite-e2e-smoke' },
        spec: {
          services: [
            {
              kind: 'chroma',
              name: 'chroma-smoke',
              node: 'local',
              runtime: 'docker',
              port: 18001, // non-default to dodge any local chroma
              image: { repository: 'chromadb/chroma', tag: '1.5.8' },
            },
          ],
          workloads: [],
          ragNodes: [],
          gateways: [],
          dependencies: [],
          onFailure: 'rollback',
        },
      };

      const applyResult = await applyComposite({
        manifest,
        backend,
        getWorkloadClient: () => failingWorkloadClient(),
        configPath,
        compositesDir,
      });
      expect(applyResult.ok).toBe(true);
      expect(applyResult.status.phase).toBe('Ready');

      // Container must be live + labelled.
      const instance = await backend.inspectService({
        name: 'llamactl-chroma-composite-e2e-smoke-chroma-smoke',
      });
      expect(instance).not.toBeNull();
      expect(instance?.running).toBe(true);

      const destroyResult = await destroyComposite({
        manifest,
        backend,
        getWorkloadClient: () => failingWorkloadClient(),
        configPath,
        compositesDir,
      });
      expect(destroyResult.ok).toBe(true);

      const afterDestroy = await backend.inspectService({
        name: 'llamactl-chroma-composite-e2e-smoke-chroma-smoke',
      });
      expect(afterDestroy).toBeNull();
    },
    // Pulling chromadb/chroma on a cold machine can take a while.
    5 * 60_000,
  );
});
