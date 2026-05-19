import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runInit } from '../src/commands/init.js';
import { runComposite } from '../src/commands/composite.js';
import { runApply } from '../src/commands/workload.js';
import { runGet } from '../src/commands/workload.js';

/**
 * Opt-in E2E covering the full onboarding round-trip:
 *   `llamactl init --apply → composite list → composite destroy`
 *
 * Gate: `LLAMACTL_INIT_E2E=1`. Hits the real Docker daemon through
 * the router's in-proc caller — the CLI tests we run in CI skip this
 * entirely; developers opt in locally to confirm the onboarding path
 * still works end-to-end after runtime-backend refactors.
 *
 * Why opt-in: the test pulls the `chromadb/chroma` image (can be slow
 * on a cold machine), binds port 18002, and leaves no residue on
 * failure beyond whatever the composite-destroy cleanup missed.
 */

const SHOULD_RUN = process.env.LLAMACTL_INIT_E2E === '1';

let tmp = '';
let compositesDir = '';
let configPath = '';
const originalEnv = { ...process.env };
let dockerReachable = false;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-init-e2e-'));
  compositesDir = join(tmp, 'composites');
  configPath = join(tmp, 'config');
  process.env.LLAMACTL_COMPOSITES_DIR = compositesDir;
  process.env.LLAMACTL_CONFIG = configPath;

  try {
    // Cheap docker-reachability probe without pulling the full
    // backend graph into the test harness.
    const { createDockerBackend } = await import(
      '@llamactl/remote'
    );
    const backend = createDockerBackend();
    await backend.ping();
    dockerReachable = true;
  } catch {
    dockerReachable = false;
  }
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

function silence<T>(fn: () => Promise<T>): Promise<T> {
  const stdoutOrig = process.stdout.write.bind(process.stdout);
  const stderrOrig = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (_s: string | Uint8Array): boolean => true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (_s: string | Uint8Array): boolean => true;
  return fn().finally(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = stdoutOrig;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = stderrOrig;
  });
}

describe.skipIf(!SHOULD_RUN)('init → apply → destroy round-trip', () => {
  test(
    'chroma-only template writes, applies, lists, destroys',
    async () => {
      if (!dockerReachable) {
        console.warn(
          '[init-e2e] skipping: docker daemon unreachable',
        );
        return;
      }

      // 1. Init — write the manifest.
      const initRc = await silence(() =>
        runInit([
          '--yes',
          '--no-apply',
          '--runtime=docker',
          '--template=chroma-only',
          '--name=init-e2e',
        ]),
      );
      expect(initRc).toBe(0);
      const manifestPath = join(compositesDir, 'init-e2e.yaml');
      const yaml = readFileSync(manifestPath, 'utf8');
      expect(yaml).toContain('name: init-e2e');
      expect(yaml).toContain('runtime: docker');

      // 2. Apply via the composite subcommand so we exercise the same
      //    path an operator would take.
      const applyRc = await silence(() =>
        runComposite(['apply', '-f', manifestPath]),
      );
      expect(applyRc).toBe(0);

      // 3. List — composite should be present.
      let listed = '';
      const stdoutOrig = process.stdout.write.bind(process.stdout);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = (s: string | Uint8Array): boolean => {
        listed += typeof s === 'string' ? s : String(s);
        return true;
      };
      try {
        const listRc = await runComposite(['list']);
        expect(listRc).toBe(0);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (process.stdout as any).write = stdoutOrig;
      }
      expect(listed).toContain('init-e2e');

      // 4. Destroy — cleans up.
      const destroyRc = await silence(() =>
        runComposite(['destroy', 'init-e2e']),
      );
      expect(destroyRc).toBe(0);
    },
    10 * 60_000,
  );
});

describe.skipIf(!SHOULD_RUN)('modelhost workload round-trip', () => {
  test('apply persists ModelHost and list renders it', async () => {
    if (!dockerReachable) {
      console.warn('[init-e2e] skipping: docker daemon unreachable');
      return;
    }

    const workloadDir = join(tmp, 'workloads');
    process.env.LLAMACTL_WORKLOADS_DIR = workloadDir;

    const manifestPath = join(tmp, 'mlx-host-local.yaml');
    await Bun.write(
      manifestPath,
      [
        'apiVersion: llamactl/v1',
        'kind: ModelHost',
        'metadata:',
        '  name: mlx-host-local',
        'spec:',
        '  enabled: true',
        '  node: local',
        '  engine: omlx',
        '  binary: /tmp/omlx',
        '  endpoint:',
        '    host: 127.0.0.1',
        '    port: 8094',
        '  hostedModels:',
        '    - rel: mlx-community/Qwen3-8B-MLX-4bit',
        '  resources:',
        '    expectedMemoryGiB: 12',
        '  extraArgs: []',
        '  timeoutSeconds: 60',
        '',
      ].join('\n'),
    );

    let stdout = '';
    const stdoutOrig = process.stdout.write.bind(process.stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (s: string | Uint8Array): boolean => {
      stdout += typeof s === 'string' ? s : String(s);
      return true;
    };

    try {
      const applyRc = await runApply(['-f', manifestPath]);
      expect(applyRc).toBe(0);
      const listRc = await runGet(['workloads']);
      expect(listRc).toBe(0);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = stdoutOrig;
    }

    expect(stdout).toContain('modelhost/mlx-host-local');
    expect(stdout).toContain('ModelHost ready at http://127.0.0.1:8094');
  }, 10 * 60_000);
});
