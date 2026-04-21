import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { runComposite, formatStatusEvent } from '../src/commands/composite.js';
import { resetGlobals, setGlobals, EMPTY_GLOBALS } from '../src/dispatcher.js';

/**
 * CLI coverage for `llamactl composite {apply,destroy,list,get,status}`.
 * Everything runs through `getNodeClient()` → local-caller proxy (the
 * kubeconfig points at a fresh in-memory `local` node) so we never
 * spawn docker or hit the network. Dry-run paths exercise the router
 * end-to-end; wet-run paths are covered by the remote-package's
 * `composite-apply.test.ts` + `composite-router.test.ts`.
 */

let runtimeDir = '';
let compositesDir = '';
let configPath = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'llamactl-cli-composite-'));
  compositesDir = join(runtimeDir, 'composites');
  configPath = join(runtimeDir, 'config');
  // Reset env so prior test state (e.g. a stale $LLAMACTL_CONFIG)
  // never leaks in. The dispatcher resolves paths against env at
  // call time; pinning LLAMACTL_CONFIG at a non-existent path causes
  // `loadConfig` to fall back to `freshConfig` → local node.
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: runtimeDir,
    LLAMACTL_COMPOSITES_DIR: compositesDir,
    LLAMACTL_CONFIG: configPath,
  });
  setGlobals(EMPTY_GLOBALS);
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  resetGlobals();
  rmSync(runtimeDir, { recursive: true, force: true });
});

/**
 * Capture stdout + stderr writes during `fn`. Mirrors the trick
 * other CLI tests use (spawn a subprocess via `runCliAsync`) but
 * in-process — the local-caller proxy means we don't need a full
 * `bun` subprocess for dry-run / list / get.
 */
async function capture(fn: () => Promise<number>): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout.write as any) = (chunk: unknown) => {
    stdout += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr.write as any) = (chunk: unknown) => {
    stderr += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  try {
    const code = await fn();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function writeTmp(name: string, contents: string): string {
  const path = join(runtimeDir, name);
  writeFileSync(path, contents, 'utf8');
  return path;
}

function sampleManifestYaml(): string {
  return stringifyYaml({
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
      ragNodes: [
        {
          name: 'kb',
          node: 'local',
          binding: {
            provider: 'chroma',
            endpoint: 'placeholder',
            extraArgs: [],
          },
          backingService: 'chroma-1',
        },
      ],
      gateways: [],
      dependencies: [],
      onFailure: 'rollback',
    },
  });
}

describe('composite apply (dry-run)', () => {
  test('-f <file> --dry-run exits 0 with topological order', async () => {
    const path = writeTmp('composite.yaml', sampleManifestYaml());
    const res = await capture(() => runComposite(['apply', '-f', path, '--dry-run']));
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('dry-run composite/kb-stack');
    expect(res.stdout).toContain('topological order');
    expect(res.stdout).toContain('service/chroma-1');
    expect(res.stdout).toContain('rag/kb');
    expect(res.stdout).toContain('implied edges');
    // rag/kb depends on service/chroma-1 via backingService.
    expect(res.stdout).toContain('rag/kb → service/chroma-1');
  });

  test('malformed YAML exits 1 with BAD_REQUEST-style error on stderr', async () => {
    const path = writeTmp('bad.yaml', 'not: [valid: yaml');
    const res = await capture(() => runComposite(['apply', '-f', path, '--dry-run']));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('composite apply:');
    expect(res.stderr).toMatch(/invalid composite manifest|parse/i);
  });

  test('missing -f surfaces usage error and exits 1', async () => {
    const res = await capture(() => runComposite(['apply']));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('-f <manifest.yaml> is required');
  });

  test('nonexistent file exits 1 with file-not-found on stderr', async () => {
    const res = await capture(() =>
      runComposite(['apply', '-f', join(runtimeDir, 'nope.yaml'), '--dry-run']),
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('file not found');
  });
});

describe('composite list', () => {
  test('empty store — exits 0, reports empty state', async () => {
    const res = await capture(() => runComposite(['list']));
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('No composites registered.');
  });

  test('after apply → list includes the name', async () => {
    const path = writeTmp('composite.yaml', sampleManifestYaml());
    // dry-run doesn't persist; we seed via saveComposite from the
    // remote store to avoid spinning up docker.
    const { saveComposite } = await import('../../remote/src/composite/store.js');
    saveComposite(
      {
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
        },
      },
      compositesDir,
    );
    // silence unused-warning for path
    expect(path).toBeTruthy();

    const res = await capture(() => runComposite(['list']));
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('NAME');
    expect(res.stdout).toContain('PHASE');
    expect(res.stdout).toContain('COMPONENTS');
    expect(res.stdout).toContain('APPLIED');
    expect(res.stdout).toContain('kb-stack');
    expect(res.stdout).toContain('Pending'); // no status persisted
  });
});

describe('composite get', () => {
  test('missing name exits 1', async () => {
    const res = await capture(() => runComposite(['get']));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('<name> is required');
  });

  test('apply then get round-trips to YAML', async () => {
    const { saveComposite } = await import('../../remote/src/composite/store.js');
    saveComposite(
      {
        apiVersion: 'llamactl/v1',
        kind: 'Composite',
        metadata: { name: 'kb-stack' },
        spec: {
          services: [],
          workloads: [],
          ragNodes: [],
          gateways: [],
          dependencies: [],
          onFailure: 'rollback',
        },
      },
      compositesDir,
    );

    const res = await capture(() => runComposite(['get', 'kb-stack']));
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('apiVersion: llamactl/v1');
    expect(res.stdout).toContain('kind: Composite');
    expect(res.stdout).toContain('name: kb-stack');
  });

  test('unknown name exits 1 with not-found on stderr', async () => {
    const res = await capture(() => runComposite(['get', 'missing']));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("composite 'missing' not found");
  });
});

describe('composite destroy', () => {
  test('missing name → exit 1', async () => {
    const res = await capture(() => runComposite(['destroy']));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('<name> is required');
  });

  test('unknown name → exit 1 with not-found', async () => {
    const res = await capture(() => runComposite(['destroy', 'missing-name']));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('composite destroy:');
    expect(res.stderr).toMatch(/not found/i);
  });

  test('dry-run on stored composite prints reverse-topo order', async () => {
    const { saveComposite } = await import('../../remote/src/composite/store.js');
    saveComposite(
      {
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
          ragNodes: [
            {
              name: 'kb',
              node: 'local',
              binding: {
                provider: 'chroma',
                endpoint: 'placeholder',
                extraArgs: [],
              },
              backingService: 'chroma-1',
            },
          ],
          gateways: [],
          dependencies: [],
          onFailure: 'rollback',
        },
      },
      compositesDir,
    );

    const res = await capture(() =>
      runComposite(['destroy', 'kb-stack', '--dry-run']),
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('dry-run destroy composite/kb-stack');
    expect(res.stdout).toContain('would remove');
    // Reverse-topo: rag tears down first, then service.
    const ragIdx = res.stdout.indexOf('rag/kb');
    const svcIdx = res.stdout.indexOf('service/chroma-1');
    expect(ragIdx).toBeGreaterThan(-1);
    expect(svcIdx).toBeGreaterThan(-1);
    expect(ragIdx).toBeLessThan(svcIdx);
  });
});

describe('composite help', () => {
  test('no subcommand prints usage and exits 1', async () => {
    const res = await capture(() => runComposite([]));
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('Usage: llamactl composite');
  });

  test('--help exits 0', async () => {
    const res = await capture(() => runComposite(['--help']));
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Usage: llamactl composite');
  });

  test('unknown subcommand exits 1', async () => {
    const res = await capture(() => runComposite(['bogus']));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Unknown composite subcommand');
  });
});

describe('formatStatusEvent', () => {
  test('phase', () => {
    expect(formatStatusEvent({ type: 'phase', phase: 'Applying' })).toBe(
      '→ phase: Applying',
    );
  });
  test('component-start / ready / failed', () => {
    const ref = { kind: 'service', name: 'chroma-1' };
    expect(formatStatusEvent({ type: 'component-start', ref })).toBe(
      '  ▸ service/chroma-1: starting',
    );
    expect(formatStatusEvent({ type: 'component-ready', ref })).toBe(
      '  ✓ service/chroma-1: ready',
    );
    expect(
      formatStatusEvent({
        type: 'component-failed',
        ref,
        message: 'boom',
      }),
    ).toBe('  ✗ service/chroma-1: boom');
  });
  test('rollback-start / complete', () => {
    expect(
      formatStatusEvent({
        type: 'rollback-start',
        refs: [
          { kind: 'service', name: 'x' },
          { kind: 'rag', name: 'y' },
        ],
      }),
    ).toBe('⇢ rolling back 2 components');
    expect(formatStatusEvent({ type: 'rollback-complete' })).toBe('⇠ rollback done');
  });
  test('done', () => {
    expect(formatStatusEvent({ type: 'done', ok: true })).toBe('⏺ done (ok=true)');
    expect(formatStatusEvent({ type: 'done', ok: false })).toBe(
      '⏺ done (ok=false)',
    );
  });
  test('unknown event returns null', () => {
    expect(formatStatusEvent({ type: 'weird' })).toBeNull();
    expect(formatStatusEvent(null)).toBeNull();
    expect(formatStatusEvent(undefined)).toBeNull();
  });
});
