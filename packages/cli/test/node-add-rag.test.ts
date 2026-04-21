import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runNode } from '../src/commands/node.js';

/**
 * `llamactl node add-rag` registers a RAG-kind node. The parser
 * accepts pgvector-flavoured options (embedder + password routing
 * + extra args) + chroma's simpler shape. Validation rides the
 * underlying `ClusterNodeSchema.refine()`.
 */

let tmp = '';
let configPath = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-node-add-rag-'));
  configPath = join(tmp, 'config');
  process.env.LLAMACTL_CONFIG = configPath;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; err: string }> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (s: string | Uint8Array): boolean => {
    chunks.push(typeof s === 'string' ? s : String(s));
    return true;
  };
  return fn()
    .then((result) => ({ result, err: chunks.join('') }))
    .finally(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = original;
    });
}

function silenceStdout<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (_s: string | Uint8Array): boolean => true;
  return fn().finally(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = original;
  });
}

describe('node add-rag — pgvector with embedder + password-env', () => {
  test('writes the rag binding + embedder + auth.tokenEnv to kubeconfig', async () => {
    const rc = await silenceStdout(() =>
      runNode([
        'add-rag',
        'kb-pg',
        '--provider',
        'pgvector',
        '--endpoint',
        'postgres://kb@db.local:5432/kb',
        '--collection',
        'docs',
        '--embedder-node',
        'sirius',
        '--embedder-model',
        'text-embedding-3-small',
        '--password-env',
        'PG_PW',
      ]),
    );
    expect(rc).toBe(0);
    const yaml = readFileSync(configPath, 'utf8');
    expect(yaml).toContain("name: kb-pg");
    expect(yaml).toContain('kind: rag');
    expect(yaml).toContain('provider: pgvector');
    expect(yaml).toContain('collection: docs');
    expect(yaml).toContain('tokenEnv: PG_PW');
    expect(yaml).toContain('node: sirius');
    expect(yaml).toContain('model: text-embedding-3-small');
  });
});

describe('node add-rag — chroma with keychain password-ref', () => {
  test('password-ref lands under auth.tokenRef', async () => {
    const rc = await silenceStdout(() =>
      runNode([
        'add-rag',
        'kb-chroma',
        '--provider',
        'chroma',
        '--endpoint',
        'chroma-mcp run',
        '--password-ref',
        'keychain:llamactl/chroma-kb',
      ]),
    );
    expect(rc).toBe(0);
    const yaml = readFileSync(configPath, 'utf8');
    expect(yaml).toContain('provider: chroma');
    expect(yaml).toContain('tokenRef: keychain:llamactl/chroma-kb');
  });
});

describe('node add-rag — --key=value inline form works', () => {
  test('inline = separator parses identically to space-separated', async () => {
    const rc = await silenceStdout(() =>
      runNode([
        'add-rag',
        'kb-inline',
        '--provider=chroma',
        '--endpoint=chroma-mcp run --persist-directory /tmp/c',
      ]),
    );
    expect(rc).toBe(0);
    const yaml = readFileSync(configPath, 'utf8');
    expect(yaml).toContain('name: kb-inline');
    expect(yaml).toContain('provider: chroma');
  });
});

describe('node add-rag — validation', () => {
  test('missing --provider rejects', async () => {
    const { result, err } = await captureStderr(() =>
      runNode(['add-rag', 'kb', '--endpoint', 'x']),
    );
    expect(result).toBe(1);
    expect(err).toContain('--provider is required');
  });

  test('missing --endpoint rejects', async () => {
    const { result, err } = await captureStderr(() =>
      runNode(['add-rag', 'kb', '--provider', 'chroma']),
    );
    expect(result).toBe(1);
    expect(err).toContain('--endpoint is required');
  });

  test('invalid --provider value rejects', async () => {
    const { result, err } = await captureStderr(() =>
      runNode([
        'add-rag',
        'kb',
        '--provider',
        'milvus',
        '--endpoint',
        'x',
      ]),
    );
    expect(result).toBe(1);
    expect(err).toContain("--provider must be 'chroma' or 'pgvector'");
  });

  test('embedder-node alone (no --embedder-model) rejects', async () => {
    const { result, err } = await captureStderr(() =>
      runNode([
        'add-rag',
        'kb',
        '--provider',
        'pgvector',
        '--endpoint',
        'postgres://kb@db:5432/kb',
        '--embedder-node',
        'sirius',
      ]),
    );
    expect(result).toBe(1);
    expect(err).toContain('must be set together');
  });

  test('both --password-env and --password-ref rejects', async () => {
    const { result, err } = await captureStderr(() =>
      runNode([
        'add-rag',
        'kb',
        '--provider',
        'pgvector',
        '--endpoint',
        'postgres://kb@db:5432/kb',
        '--password-env',
        'PG',
        '--password-ref',
        'keychain:llamactl/pg',
      ]),
    );
    expect(result).toBe(1);
    expect(err).toContain('only one of');
  });

  test('unknown flag rejects', async () => {
    const { result, err } = await captureStderr(() =>
      runNode([
        'add-rag',
        'kb',
        '--provider',
        'chroma',
        '--endpoint',
        'x',
        '--fortune-cookie',
      ]),
    );
    expect(result).toBe(1);
    expect(err).toContain('unknown flag --fortune-cookie');
  });
});

describe('node add-rag — repeated --extra-arg', () => {
  test('each --extra-arg appends to extraArgs[]', async () => {
    const rc = await silenceStdout(() =>
      runNode([
        'add-rag',
        'kb',
        '--provider',
        'chroma',
        '--endpoint',
        'chroma-mcp run',
        '--extra-arg',
        '--persist',
        '--extra-arg',
        '/tmp/c',
      ]),
    );
    expect(rc).toBe(0);
    const yaml = readFileSync(configPath, 'utf8');
    expect(yaml).toContain("- --persist");
    expect(yaml).toContain('- /tmp/c');
  });
});
