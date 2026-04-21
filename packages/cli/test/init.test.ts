import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runInit } from '../src/commands/init.js';

/**
 * `llamactl init` non-interactive path tests. `--yes` + explicit
 * flags let us exercise every branch without stdin; the apply path
 * is skipped via `--no-apply` so we don't need a running Docker
 * daemon.
 */

let tmp = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-init-'));
  process.env.LLAMACTL_COMPOSITES_DIR = join(tmp, 'composites');
  // Suppress stdout writes during assertions. Can't monkeypatch here
  // without losing runInit's process.stdout chain; we just let the
  // test runner eat the banner lines.
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (s: string | Uint8Array): boolean => {
    chunks.push(typeof s === 'string' ? s : String(s));
    return true;
  };
  return fn()
    .then((result) => ({ result, out: chunks.join('') }))
    .finally(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = original;
    });
}

describe('init --help', () => {
  test('prints USAGE and exits 0 without touching the filesystem', async () => {
    const { result, out } = await captureStdout(() => runInit(['--help']));
    expect(result).toBe(0);
    expect(out).toContain('llamactl init');
    expect(out).toContain('--template=');
    expect(
      existsSync(process.env.LLAMACTL_COMPOSITES_DIR!),
    ).toBe(false);
  });
});

describe('init --yes --no-apply writes the template', () => {
  test('chroma-only template lands at the right path with metadata.name rewrite', async () => {
    const { result } = await captureStdout(() =>
      runInit([
        '--yes',
        '--no-apply',
        '--runtime=docker',
        '--template=chroma-only',
        '--name=smoke-a',
      ]),
    );
    expect(result).toBe(0);

    const target = join(
      process.env.LLAMACTL_COMPOSITES_DIR!,
      'smoke-a.yaml',
    );
    expect(existsSync(target)).toBe(true);
    const yaml = readFileSync(target, 'utf8');
    expect(yaml).toContain('name: smoke-a');
    expect(yaml).toContain('runtime: docker');
    expect(yaml).toContain('kind: chroma');
  });

  test('runtime=kubernetes rewrites the spec.runtime line', async () => {
    const { result } = await captureStdout(() =>
      runInit([
        '--yes',
        '--no-apply',
        '--runtime=kubernetes',
        '--template=chroma-only',
        '--name=smoke-b',
      ]),
    );
    expect(result).toBe(0);
    const yaml = readFileSync(
      join(process.env.LLAMACTL_COMPOSITES_DIR!, 'smoke-b.yaml'),
      'utf8',
    );
    expect(yaml).toContain('runtime: kubernetes');
  });

  test('pgvector-with-embedder template carries the embedder stanza', async () => {
    await captureStdout(() =>
      runInit([
        '--yes',
        '--no-apply',
        '--runtime=docker',
        '--template=pgvector-with-embedder',
        '--name=pg-kb',
      ]),
    );
    const yaml = readFileSync(
      join(process.env.LLAMACTL_COMPOSITES_DIR!, 'pg-kb.yaml'),
      'utf8',
    );
    expect(yaml).toContain('provider: pgvector');
    expect(yaml).toContain('embedder:');
    expect(yaml).toContain('passwordEnv: PG_PASSWORD');
  });

  test('chroma-plus-workload template includes a ModelRunSpec', async () => {
    await captureStdout(() =>
      runInit([
        '--yes',
        '--no-apply',
        '--runtime=docker',
        '--template=chroma-plus-workload',
        '--name=stack',
      ]),
    );
    const yaml = readFileSync(
      join(process.env.LLAMACTL_COMPOSITES_DIR!, 'stack.yaml'),
      'utf8',
    );
    expect(yaml).toContain('workloads:');
    expect(yaml).toContain('target:');
    expect(yaml).toContain('gguf');
  });
});

describe('init --force behavior', () => {
  test('existing file blocks write without --force', async () => {
    const target = join(
      process.env.LLAMACTL_COMPOSITES_DIR!,
      'kept.yaml',
    );
    // Pre-populate the composites dir with a sentinel file.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(process.env.LLAMACTL_COMPOSITES_DIR!, { recursive: true });
    writeFileSync(target, '# pre-existing — do not overwrite\n', 'utf8');

    const { result } = await captureStdout(() =>
      runInit([
        '--yes',
        '--no-apply',
        '--runtime=docker',
        '--template=chroma-only',
        '--name=kept',
      ]),
    );
    expect(result).toBe(1);
    expect(readFileSync(target, 'utf8')).toContain('pre-existing');
  });

  test('--force overwrites the existing file', async () => {
    const target = join(
      process.env.LLAMACTL_COMPOSITES_DIR!,
      'overwrite-me.yaml',
    );
    const { mkdirSync } = await import('node:fs');
    mkdirSync(process.env.LLAMACTL_COMPOSITES_DIR!, { recursive: true });
    writeFileSync(target, '# old contents\n', 'utf8');

    const { result } = await captureStdout(() =>
      runInit([
        '--yes',
        '--no-apply',
        '--force',
        '--runtime=docker',
        '--template=chroma-only',
        '--name=overwrite-me',
      ]),
    );
    expect(result).toBe(0);
    const yaml = readFileSync(target, 'utf8');
    expect(yaml).toContain('kind: Composite');
    expect(yaml).not.toContain('old contents');
  });
});

describe('init bad args', () => {
  test('unknown --template value falls back to chroma-only', async () => {
    const { result } = await captureStdout(() =>
      runInit([
        '--yes',
        '--no-apply',
        '--runtime=docker',
        '--template=nonsense',
        '--name=fallback',
      ]),
    );
    // Invalid flag values are silently ignored — command still works.
    expect(result).toBe(0);
    const yaml = readFileSync(
      join(process.env.LLAMACTL_COMPOSITES_DIR!, 'fallback.yaml'),
      'utf8',
    );
    expect(yaml).toContain('chroma-only');
  });
});
