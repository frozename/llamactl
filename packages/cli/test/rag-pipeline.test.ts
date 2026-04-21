import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeClient } from '@llamactl/remote';
import { runRag } from '../src/commands/rag.js';
import {
  __setRagPipelineTestSeams,
  __resetRagPipelineTestSeams,
} from '../src/commands/rag-pipeline.js';

/**
 * CLI coverage for `llamactl rag pipeline ...`. Tests run against a
 * stubbed NodeClient (no tRPC round-trip) plus a real tmpdir for the
 * `logs` subcommand which reads the journal file directly.
 */

interface Captured { out: string; err: string }

function captureStdio<T>(fn: () => Promise<T>): Promise<{ result: T; cap: Captured }> {
  const chunks: Captured = { out: '', err: '' };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (s: string | Uint8Array): boolean => {
    chunks.out += typeof s === 'string' ? s : String(s);
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (s: string | Uint8Array): boolean => {
    chunks.err += typeof s === 'string' ? s : String(s);
    return true;
  };
  return fn()
    .then((result) => ({ result, cap: chunks }))
    .finally(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = origOut;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = origErr;
    });
}

function makeStubClient(overrides: Partial<StubProcs> = {}): NodeClient {
  const stubs: StubProcs = {
    ragPipelineApply: async () => ({ ok: true, name: 'test', path: '/tmp/x', created: true }),
    ragPipelineRun: async () => ({
      ok: true,
      dryRun: false,
      summary: {
        total_docs: 3,
        total_chunks: 12,
        skipped_docs: 0,
        errors: 0,
        elapsed_ms: 42,
        per_source: [{ source: 'test:0:filesystem', docs: 3, chunks: 12, errors: 0 }],
      },
    }),
    ragPipelineList: async () => ({
      pipelines: [
        {
          name: 'test',
          manifest: {
            apiVersion: 'llamactl/v1',
            kind: 'RagPipeline',
            metadata: { name: 'test' },
            spec: {
              destination: { ragNode: 'kb-pg', collection: 'docs' },
              sources: [{ kind: 'filesystem', root: '/tmp/x', glob: '**/*' }],
              transforms: [],
              concurrency: 4,
              on_duplicate: 'skip',
            },
          },
        },
      ],
    }),
    ragPipelineGet: async () => ({
      manifest: {
        apiVersion: 'llamactl/v1',
        kind: 'RagPipeline',
        metadata: { name: 'test' },
        spec: {
          destination: { ragNode: 'kb-pg', collection: 'docs' },
          sources: [{ kind: 'filesystem', root: '/tmp/x', glob: '**/*' }],
          transforms: [],
          concurrency: 4,
          on_duplicate: 'skip',
        },
      },
    }),
    ragPipelineRemove: async () => ({ ok: true, removed: true }),
    ...overrides,
  };
  return {
    ragPipelineApply: { mutate: stubs.ragPipelineApply },
    ragPipelineRun: { mutate: stubs.ragPipelineRun },
    ragPipelineList: { query: stubs.ragPipelineList },
    ragPipelineGet: { query: stubs.ragPipelineGet },
    ragPipelineRemove: { mutate: stubs.ragPipelineRemove },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as NodeClient;
}

interface StubProcs {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ragPipelineApply: (i: { manifestYaml: string }) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ragPipelineRun: (i: { name: string; dryRun: boolean }) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ragPipelineList: () => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ragPipelineGet: (i: { name: string }) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ragPipelineRemove: (i: { name: string }) => Promise<any>;
}

let tmp = '';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-rag-pipeline-'));
  __setRagPipelineTestSeams({ nodeClient: makeStubClient() });
});

afterEach(() => {
  __resetRagPipelineTestSeams();
  rmSync(tmp, { recursive: true, force: true });
});

describe('rag pipeline — help + unknown', () => {
  test('no subcommand prints USAGE + exit 0', async () => {
    const { result, cap } = await captureStdio(() => runRag(['pipeline']));
    expect(result).toBe(0);
    expect(cap.out).toContain('Usage: llamactl rag pipeline');
  });
  test('unknown subcommand → exit 1', async () => {
    const { result, cap } = await captureStdio(() => runRag(['pipeline', 'bogus']));
    expect(result).toBe(1);
    expect(cap.err).toContain('Unknown rag pipeline subcommand');
  });
});

describe('rag pipeline apply', () => {
  test('-f file missing → exit 1', async () => {
    const { result, cap } = await captureStdio(() =>
      runRag(['pipeline', 'apply']),
    );
    expect(result).toBe(1);
    expect(cap.err).toContain('-f <file.yaml> is required');
  });
  test('file not on disk → exit 1', async () => {
    const { result, cap } = await captureStdio(() =>
      runRag(['pipeline', 'apply', '-f', '/nope/does-not-exist.yaml']),
    );
    expect(result).toBe(1);
    expect(cap.err).toContain('file not found');
  });
  test('happy path forwards raw YAML + prints applied line', async () => {
    const p = join(tmp, 'pipe.yaml');
    writeFileSync(p, 'apiVersion: llamactl/v1\nkind: RagPipeline\n');
    const { result, cap } = await captureStdio(() =>
      runRag(['pipeline', 'apply', '-f', p]),
    );
    expect(result).toBe(0);
    expect(cap.out).toContain("applied rag pipeline 'test'");
  });
});

describe('rag pipeline run', () => {
  test('missing <name> → exit 1', async () => {
    const { result, cap } = await captureStdio(() => runRag(['pipeline', 'run']));
    expect(result).toBe(1);
    expect(cap.err).toContain('<name> is required');
  });
  test('plain run prints summary', async () => {
    const { result, cap } = await captureStdio(() =>
      runRag(['pipeline', 'run', 'test']),
    );
    expect(result).toBe(0);
    expect(cap.out).toContain("ran pipeline 'test'");
    expect(cap.out).toContain('total_docs: 3');
  });
  test('--dry-run labels "dry-ran" in output', async () => {
    let sawDryRun = false;
    __setRagPipelineTestSeams({
      nodeClient: makeStubClient({
        ragPipelineRun: async (i) => {
          sawDryRun = i.dryRun;
          return {
            ok: true,
            dryRun: i.dryRun,
            summary: {
              total_docs: 3,
              total_chunks: 12,
              skipped_docs: 0,
              errors: 0,
              elapsed_ms: 21,
              per_source: [],
            },
          };
        },
      }),
    });
    const { result, cap } = await captureStdio(() =>
      runRag(['pipeline', 'run', 'test', '--dry-run']),
    );
    expect(result).toBe(0);
    expect(sawDryRun).toBe(true);
    expect(cap.out).toContain("dry-ran pipeline 'test'");
  });
  test('--json emits a single-line JSON doc', async () => {
    const { cap } = await captureStdio(() =>
      runRag(['pipeline', 'run', 'test', '--json']),
    );
    const parsed = JSON.parse(cap.out.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.summary.total_chunks).toBe(12);
  });
});

describe('rag pipeline list', () => {
  test('prints pipeline row + destination', async () => {
    const { result, cap } = await captureStdio(() =>
      runRag(['pipeline', 'list']),
    );
    expect(result).toBe(0);
    expect(cap.out).toContain('test');
    expect(cap.out).toContain('kb-pg/docs');
  });
  test('--json emits structured doc', async () => {
    const { cap } = await captureStdio(() => runRag(['pipeline', 'list', '--json']));
    const parsed = JSON.parse(cap.out.trim());
    expect(Array.isArray(parsed.pipelines)).toBe(true);
  });
  test('empty → informative message', async () => {
    __setRagPipelineTestSeams({
      nodeClient: makeStubClient({
        ragPipelineList: async () => ({ pipelines: [] }),
      }),
    });
    const { cap } = await captureStdio(() => runRag(['pipeline', 'list']));
    expect(cap.out).toContain('no rag pipelines applied');
  });
});

describe('rag pipeline get', () => {
  test('prints manifest as YAML', async () => {
    const { result, cap } = await captureStdio(() =>
      runRag(['pipeline', 'get', 'test']),
    );
    expect(result).toBe(0);
    expect(cap.out).toContain('apiVersion: llamactl/v1');
    expect(cap.out).toContain('kind: RagPipeline');
  });
  test('missing <name> → exit 1', async () => {
    const { result, cap } = await captureStdio(() => runRag(['pipeline', 'get']));
    expect(result).toBe(1);
    expect(cap.err).toContain('<name> is required');
  });
});

describe('rag pipeline rm', () => {
  test('happy path', async () => {
    const { result, cap } = await captureStdio(() =>
      runRag(['pipeline', 'rm', 'test']),
    );
    expect(result).toBe(0);
    expect(cap.out).toContain("removed rag pipeline 'test'");
  });
  test('not found → exit 1', async () => {
    __setRagPipelineTestSeams({
      nodeClient: makeStubClient({
        ragPipelineRemove: async () => ({ ok: true, removed: false }),
      }),
    });
    const { result, cap } = await captureStdio(() =>
      runRag(['pipeline', 'rm', 'test']),
    );
    expect(result).toBe(1);
    expect(cap.err).toContain('not found');
  });
});

describe('rag pipeline logs', () => {
  test('missing <name> → exit 1', async () => {
    const { result, cap } = await captureStdio(() => runRag(['pipeline', 'logs']));
    expect(result).toBe(1);
    expect(cap.err).toContain('<name> is required');
  });
  test('tail default prints last 50 (or all when fewer)', async () => {
    const journal = join(tmp, 'journal.jsonl');
    mkdirSync(tmp, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      lines.push(
        JSON.stringify({ kind: 'doc-ingested', ts: new Date().toISOString(), source: 's', doc_id: `d${i}`, sha: 'x', chunks: 1 }),
      );
    }
    writeFileSync(journal, `${lines.join('\n')}\n`);
    __setRagPipelineTestSeams({
      nodeClient: makeStubClient(),
      journalPathFor: () => journal,
    });
    const { result, cap } = await captureStdio(() =>
      runRag(['pipeline', 'logs', 'test', '--tail=3']),
    );
    expect(result).toBe(0);
    // Should only include last 3 doc_ids
    expect(cap.out).not.toContain('"doc_id":"d0"');
    expect(cap.out).toContain('"doc_id":"d4"');
    expect(cap.out).toContain('"doc_id":"d3"');
    expect(cap.out).toContain('"doc_id":"d2"');
  });
  test('journal missing → exit 1', async () => {
    __setRagPipelineTestSeams({
      nodeClient: makeStubClient(),
      journalPathFor: () => join(tmp, 'never.jsonl'),
    });
    const { result, cap } = await captureStdio(() =>
      runRag(['pipeline', 'logs', 'test']),
    );
    expect(result).toBe(1);
    expect(cap.err).toContain('no journal at');
  });
});
