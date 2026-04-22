/**
 * Retrieval quality benchmark. Takes an operator-supplied query set
 * (YAML: `RagBench` manifest) and runs each query through
 * `ragSearch`, then scores the result set against expected doc IDs
 * and/or expected content substrings.
 *
 * Metrics reported per run:
 *   - hit rate @ k    — fraction of queries with at least one hit in top-k
 *   - mean reciprocal rank (MRR) — average of 1/(rank of first hit);
 *     queries with zero hits contribute 0
 *   - per-query hit + rank — so the operator can inspect which
 *     queries failed
 *
 * Intentionally modest: no reranking, no precision@k vs recall@k
 * distinction, no semantic evaluation. The goal is to let an
 * operator sanity-check a collection after ingesting or tweaking
 * an embedder binding, not to compete with dedicated IR benchmarks.
 */

import { z } from 'zod';

export const RagBenchQuerySchema = z
  .object({
    query: z.string().min(1),
    /**
     * Expected doc ID. A hit is when any top-k result's document.id
     * equals this exactly (no wildcard — the operator writes a
     * specific expectation).
     */
    expected_doc_id: z.string().optional(),
    /**
     * Expected content substring. A hit is when any top-k result's
     * document.content contains this string (case-sensitive to keep
     * failure modes obvious). Complements `expected_doc_id` — at
     * least one of the two must be present.
     */
    expected_substring: z.string().optional(),
    /**
     * Per-query topK override. Falls back to `spec.topK` when absent.
     */
    topK: z.number().int().positive().max(100).optional(),
  })
  .refine((q) => q.expected_doc_id || q.expected_substring, {
    message: 'each query must set expected_doc_id or expected_substring (or both)',
  });
export type RagBenchQuery = z.infer<typeof RagBenchQuerySchema>;

export const RagBenchManifestSchema = z.object({
  apiVersion: z.literal('llamactl/v1'),
  kind: z.literal('RagBench'),
  metadata: z.object({ name: z.string().min(1) }),
  spec: z.object({
    node: z.string().min(1),
    collection: z.string().optional(),
    topK: z.number().int().positive().max(100).default(10),
    queries: z.array(RagBenchQuerySchema).min(1),
  }),
});
export type RagBenchManifest = z.infer<typeof RagBenchManifestSchema>;

export interface PerQueryResult {
  query: string;
  topK: number;
  /** 1-based rank of the first hit; null when nothing matched. */
  hitRank: number | null;
  /** Which test matched first — useful for debugging intent. */
  hitKind: 'doc_id' | 'substring' | null;
  /** The ID of the matched document; null when no hit. */
  matchedDocId: string | null;
  /** Error surfaced from ragSearch, if any. Skips scoring. */
  error?: string;
}

export interface BenchReport {
  ok: true;
  manifest: RagBenchManifest;
  /** Fraction of queries with ≥1 hit (0..1). */
  hitRate: number;
  /** Mean reciprocal rank across queries (0..1). */
  mrr: number;
  /** Absolute counts, useful when the queries list is tiny. */
  totalQueries: number;
  hits: number;
  errors: number;
  perQuery: PerQueryResult[];
  elapsed_ms: number;
}

/**
 * Minimal shape the caller must expose. Mirrors the router's
 * `ragSearch` return value (narrowed for this surface). Tests stub
 * this directly; production callers pass `caller.ragSearch`.
 */
export interface RagSearchCaller {
  (input: {
    node: string;
    query: string;
    topK: number;
    collection?: string;
  }): Promise<{
    results: Array<{
      document: { id: string; content: string; metadata?: Record<string, unknown> };
      score: number;
      distance?: number;
    }>;
    collection: string;
  }>;
}

export interface RunRagBenchOptions {
  manifest: RagBenchManifest;
  /** The ragSearch implementation. Test seam + the production caller. */
  search: RagSearchCaller;
  /** Injected clock for deterministic elapsed_ms in tests. */
  now?: () => number;
}

export async function runRagBench(
  opts: RunRagBenchOptions,
): Promise<BenchReport> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const spec = opts.manifest.spec;
  const perQuery: PerQueryResult[] = [];
  let hits = 0;
  let errors = 0;
  let mrrSum = 0;

  for (const q of spec.queries) {
    const topK = q.topK ?? spec.topK;
    try {
      const res = await opts.search({
        node: spec.node,
        query: q.query,
        topK,
        ...(spec.collection !== undefined ? { collection: spec.collection } : {}),
      });
      const hit = findFirstHit(res.results, q);
      if (hit) {
        hits++;
        mrrSum += 1 / hit.rank;
        perQuery.push({
          query: q.query,
          topK,
          hitRank: hit.rank,
          hitKind: hit.kind,
          matchedDocId: hit.docId,
        });
      } else {
        perQuery.push({
          query: q.query,
          topK,
          hitRank: null,
          hitKind: null,
          matchedDocId: null,
        });
      }
    } catch (err) {
      errors++;
      perQuery.push({
        query: q.query,
        topK,
        hitRank: null,
        hitKind: null,
        matchedDocId: null,
        error: (err as Error).message,
      });
    }
  }

  const scored = spec.queries.length - errors;
  const hitRate = scored > 0 ? hits / scored : 0;
  const mrr = scored > 0 ? mrrSum / scored : 0;

  return {
    ok: true,
    manifest: opts.manifest,
    hitRate,
    mrr,
    totalQueries: spec.queries.length,
    hits,
    errors,
    perQuery,
    elapsed_ms: now() - startedAt,
  };
}

/**
 * Walk results top-down; return the first rank where either the
 * expected doc_id matches exactly or the expected substring
 * appears. `expected_doc_id` beats `expected_substring` at the same
 * rank — it's the more specific signal.
 */
function findFirstHit(
  results: Array<{ document: { id: string; content: string } }>,
  q: RagBenchQuery,
): { rank: number; kind: 'doc_id' | 'substring'; docId: string } | null {
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (q.expected_doc_id && r.document.id === q.expected_doc_id) {
      return { rank: i + 1, kind: 'doc_id', docId: r.document.id };
    }
    if (q.expected_substring && r.document.content.includes(q.expected_substring)) {
      return { rank: i + 1, kind: 'substring', docId: r.document.id };
    }
  }
  return null;
}
