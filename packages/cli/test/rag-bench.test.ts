import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeClient } from '@llamactl/remote';
import { runRag } from '../src/commands/rag.js';
import {
  __setRagBenchTestSeams,
  __resetRagBenchTestSeams,
} from '../src/commands/rag-bench.js';

/**
 * CLI coverage for `llamactl rag bench`. Tests run against a
 * stubbed NodeClient so the bench doesn't actually round-trip
 * through the tRPC router + rag adapter. Covers: happy-path,
 * stdin pipe, --json emission, exit codes (0 on full hit, 2 on
 * any miss/error, 1 on usage error).
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeStubClient(benchResult: any): NodeClient {
  return {
    ragBench: { mutate: async () => benchResult },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as NodeClient;
}

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-rag-bench-cli-'));
});
afterEach(() => {
  __resetRagBenchTestSeams();
  rmSync(tmp, { recursive: true, force: true });
});

const MANIFEST_YAML = `apiVersion: llamactl/v1
kind: RagBench
metadata: { name: t }
spec:
  node: kb-pg
  topK: 10
  queries:
    - query: hi
      expected_doc_id: a.md
`;

const FULL_HIT_REPORT = {
  ok: true,
  manifest: {
    apiVersion: 'llamactl/v1',
    kind: 'RagBench',
    metadata: { name: 't' },
    spec: { node: 'kb-pg', topK: 10, queries: [{ query: 'hi', expected_doc_id: 'a.md' }] },
  },
  hitRate: 1,
  mrr: 1,
  totalQueries: 1,
  hits: 1,
  errors: 0,
  perQuery: [
    { query: 'hi', topK: 10, hitRank: 1, hitKind: 'doc_id', matchedDocId: 'a.md' },
  ],
  elapsed_ms: 42,
};

const MIXED_REPORT = {
  ok: true,
  manifest: FULL_HIT_REPORT.manifest,
  hitRate: 0.5,
  mrr: 0.5,
  totalQueries: 2,
  hits: 1,
  errors: 0,
  perQuery: [
    { query: 'hit-me', topK: 10, hitRank: 1, hitKind: 'doc_id', matchedDocId: 'a.md' },
    { query: 'miss-me', topK: 10, hitRank: null, hitKind: null, matchedDocId: null },
  ],
  elapsed_ms: 10,
};

describe('rag bench', () => {
  test('-f file missing → exit 1', async () => {
    __setRagBenchTestSeams({ nodeClient: makeStubClient(FULL_HIT_REPORT) });
    const { result, cap } = await captureStdio(() => runRag(['bench']));
    expect(result).toBe(1);
    expect(cap.err).toContain('-f <file.yaml | -> is required');
  });

  test('file not on disk → exit 1', async () => {
    __setRagBenchTestSeams({ nodeClient: makeStubClient(FULL_HIT_REPORT) });
    const { result, cap } = await captureStdio(() =>
      runRag(['bench', '-f', '/nope/does-not-exist.yaml']),
    );
    expect(result).toBe(1);
    expect(cap.err).toContain('file not found');
  });

  test('happy path (all queries hit) → exit 0 + human summary', async () => {
    const p = join(tmp, 'bench.yaml');
    writeFileSync(p, MANIFEST_YAML);
    __setRagBenchTestSeams({ nodeClient: makeStubClient(FULL_HIT_REPORT) });
    const { result, cap } = await captureStdio(() =>
      runRag(['bench', '-f', p]),
    );
    expect(result).toBe(0);
    expect(cap.out).toContain('RagBench: t');
    expect(cap.out).toContain('hit rate  100.0%');
    expect(cap.out).toContain('[hit ] hi');
  });

  test('any miss → exit 2 (quality-gate semantics)', async () => {
    const p = join(tmp, 'mixed.yaml');
    writeFileSync(p, MANIFEST_YAML);
    __setRagBenchTestSeams({ nodeClient: makeStubClient(MIXED_REPORT) });
    const { result, cap } = await captureStdio(() =>
      runRag(['bench', '-f', p]),
    );
    expect(result).toBe(2);
    expect(cap.out).toContain('hit rate  50.0%');
    expect(cap.out).toContain('[miss] miss-me');
  });

  test('--json emits a single-line JSON doc', async () => {
    const p = join(tmp, 'bench.yaml');
    writeFileSync(p, MANIFEST_YAML);
    __setRagBenchTestSeams({ nodeClient: makeStubClient(FULL_HIT_REPORT) });
    const { result, cap } = await captureStdio(() =>
      runRag(['bench', '-f', p, '--json']),
    );
    expect(result).toBe(0);
    const parsed = JSON.parse(cap.out.trim());
    expect(parsed.hitRate).toBe(1);
    expect(parsed.perQuery).toHaveLength(1);
  });

  test('-f - reads manifest from stdin', async () => {
    let sawYaml = '';
    __setRagBenchTestSeams({
      readStdinYaml: () => MANIFEST_YAML,
      nodeClient: {
        ragBench: {
          mutate: async (i: { manifestYaml: string }) => {
            sawYaml = i.manifestYaml;
            return FULL_HIT_REPORT;
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any as NodeClient,
    });
    const { result } = await captureStdio(() =>
      runRag(['bench', '-f', '-']),
    );
    expect(result).toBe(0);
    expect(sawYaml).toBe(MANIFEST_YAML);
  });

  test('-f - with empty stdin → exit 1', async () => {
    __setRagBenchTestSeams({
      readStdinYaml: () => '',
      nodeClient: makeStubClient(FULL_HIT_REPORT),
    });
    const { result, cap } = await captureStdio(() =>
      runRag(['bench', '-f', '-']),
    );
    expect(result).toBe(1);
    expect(cap.err).toContain('stdin was empty');
  });
});
