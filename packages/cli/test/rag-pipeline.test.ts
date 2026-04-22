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
    ragPipelineDraft: async (i) => ({
      ok: true,
      yaml: `apiVersion: llamactl/v1\nkind: RagPipeline\nmetadata:\n  name: ${i.nameOverride ?? 'drafted'}\nspec: {}\n`,
      manifest: {
        apiVersion: 'llamactl/v1',
        kind: 'RagPipeline',
        metadata: { name: i.nameOverride ?? 'drafted' },
        spec: {
          destination: { ragNode: i.defaultRagNode ?? 'kb-pg', collection: 'docs' },
          sources: [{ kind: 'filesystem', root: '/tmp/x', glob: '**/*' }],
          transforms: [],
          concurrency: 4,
          on_duplicate: 'skip',
        },
      },
      warnings: i.description === '' ? ['description was empty'] : [],
    }),
    ...overrides,
  };
  return {
    ragPipelineApply: { mutate: stubs.ragPipelineApply },
    ragPipelineRun: { mutate: stubs.ragPipelineRun },
    ragPipelineList: { query: stubs.ragPipelineList },
    ragPipelineGet: { query: stubs.ragPipelineGet },
    ragPipelineRemove: { mutate: stubs.ragPipelineRemove },
    ragPipelineDraft: { query: stubs.ragPipelineDraft },
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
  ragPipelineDraft: (i: {
    description: string;
    availableRagNodes?: string[];
    defaultRagNode?: string;
    nameOverride?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) => Promise<any>;
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
  test('-f - reads manifest from stdin and applies', async () => {
    const yaml = 'apiVersion: llamactl/v1\nkind: RagPipeline\nmetadata:\n  name: piped\n';
    let sawYaml = '';
    __setRagPipelineTestSeams({
      nodeClient: makeStubClient({
        ragPipelineApply: async (i) => {
          sawYaml = i.manifestYaml;
          return { ok: true, name: 'piped', path: '/tmp/p', created: true };
        },
      }),
      readStdinYaml: () => yaml,
    });
    const { result, cap } = await captureStdio(() =>
      runRag(['pipeline', 'apply', '-f', '-']),
    );
    expect(result).toBe(0);
    expect(sawYaml).toBe(yaml);
    expect(cap.out).toContain("applied rag pipeline 'piped'");
  });
  test('-f - with empty stdin → exit 1', async () => {
    __setRagPipelineTestSeams({
      nodeClient: makeStubClient(),
      readStdinYaml: () => '',
    });
    const { result, cap } = await captureStdio(() =>
      runRag(['pipeline', 'apply', '-f', '-']),
    );
    expect(result).toBe(1);
    expect(cap.err).toContain('stdin was empty');
  });
  test('-f - surfacing a read error returns exit 1', async () => {
    __setRagPipelineTestSeams({
      nodeClient: makeStubClient(),
      readStdinYaml: () => {
        throw new Error('EIO fake-read-failure');
      },
    });
    const { result, cap } = await captureStdio(() =>
      runRag(['pipeline', 'apply', '-f', '-']),
    );
    expect(result).toBe(1);
    expect(cap.err).toContain('failed reading manifest from stdin');
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

describe('rag pipeline draft', () => {
  test('missing description → exit 1', async () => {
    const { result, cap } = await captureStdio(() => runRag(['pipeline', 'draft']));
    expect(result).toBe(1);
    expect(cap.err).toContain('<description> is required');
  });
  test('happy path prints YAML to stdout, empty stderr when no warnings', async () => {
    const { result, cap } = await captureStdio(() =>
      runRag(['pipeline', 'draft', 'ingest', 'https://site.io']),
    );
    expect(result).toBe(0);
    expect(cap.out).toContain('apiVersion: llamactl/v1');
    expect(cap.out).toContain('kind: RagPipeline');
    expect(cap.err).toBe('');
  });
  test('--name threads nameOverride', async () => {
    let seen: unknown = null;
    __setRagPipelineTestSeams({
      nodeClient: makeStubClient({
        ragPipelineDraft: async (i) => {
          seen = i;
          return {
            ok: true,
            yaml: 'apiVersion: llamactl/v1\n',
            manifest: {
              apiVersion: 'llamactl/v1',
              kind: 'RagPipeline',
              metadata: { name: 'x' },
              spec: {},
            },
            warnings: [],
          };
        },
      }),
    });
    const { result } = await captureStdio(() =>
      runRag(['pipeline', 'draft', 'foo', '--name', 'my-pipeline']),
    );
    expect(result).toBe(0);
    expect((seen as { nameOverride?: string }).nameOverride).toBe('my-pipeline');
  });
  test('warnings are surfaced on stderr', async () => {
    __setRagPipelineTestSeams({
      nodeClient: makeStubClient({
        ragPipelineDraft: async () => ({
          ok: true,
          yaml: 'apiVersion: llamactl/v1\n',
          manifest: {
            apiVersion: 'llamactl/v1',
            kind: 'RagPipeline',
            metadata: { name: 'd' },
            spec: {},
          },
          warnings: ['something ambiguous', 'also check the glob'],
        }),
      }),
    });
    const { cap } = await captureStdio(() =>
      runRag(['pipeline', 'draft', 'something']),
    );
    expect(cap.err).toContain('warning: something ambiguous');
    expect(cap.err).toContain('warning: also check the glob');
  });
});

describe('rag pipeline scheduler', () => {
  test('--once runs a single tick and exits 0', async () => {
    let seenOpts: unknown = null;
    __setRagPipelineTestSeams({
      nodeClient: makeStubClient(),
      startPipelineScheduler: (opts) => {
        seenOpts = opts;
        // Synchronously fire onTick before returning so --once
        // verification can assert against a specific report.
        opts.onTick?.({
          ts: '2026-04-21T10:30:00.000Z',
          considered: 2,
          fired: ['p1'],
          skippedInFlight: [],
          unparseable: [],
        });
        return { stop: () => {}, done: Promise.resolve() };
      },
    });
    const { result, cap } = await captureStdio(() =>
      runRag(['pipeline', 'scheduler', '--once']),
    );
    expect(result).toBe(0);
    expect((seenOpts as { once?: boolean }).once).toBe(true);
    expect(cap.err).toContain('fired=1');
    expect(cap.err).toContain('fired: p1');
  });
  test('--interval=30 clamps and passes 30000ms to the scheduler', async () => {
    let seenOpts: unknown = null;
    __setRagPipelineTestSeams({
      nodeClient: makeStubClient(),
      startPipelineScheduler: (opts) => {
        seenOpts = opts;
        return { stop: () => {}, done: Promise.resolve() };
      },
    });
    const { result } = await captureStdio(() =>
      runRag(['pipeline', 'scheduler', '--once', '--interval=30']),
    );
    expect(result).toBe(0);
    expect((seenOpts as { tickIntervalMs?: number }).tickIntervalMs).toBe(30_000);
  });
  test('invalid --interval → exit 1', async () => {
    __setRagPipelineTestSeams({
      nodeClient: makeStubClient(),
      startPipelineScheduler: () => ({ stop: () => {}, done: Promise.resolve() }),
    });
    const { result, cap } = await captureStdio(() =>
      runRag(['pipeline', 'scheduler', '--interval=huh']),
    );
    expect(result).toBe(1);
    expect(cap.err).toContain('Invalid --interval value');
  });
  test('--quiet suppresses tick output', async () => {
    __setRagPipelineTestSeams({
      nodeClient: makeStubClient(),
      startPipelineScheduler: (opts) => {
        opts.onTick?.({
          ts: '2026-04-21T10:30:00.000Z',
          considered: 1,
          fired: ['loud'],
          skippedInFlight: [],
          unparseable: [],
        });
        return { stop: () => {}, done: Promise.resolve() };
      },
    });
    const { result, cap } = await captureStdio(() =>
      runRag(['pipeline', 'scheduler', '--once', '--quiet']),
    );
    expect(result).toBe(0);
    expect(cap.err).toBe('');
  });
});
