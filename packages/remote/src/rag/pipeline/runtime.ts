/**
 * RAG ingestion pipeline orchestrator. Walks a validated manifest
 * source-by-source, feeds the fetched RawDocs through the declared
 * transforms, dedupes against the journal, and batches the tail into
 * the target rag node's adapter store.
 *
 * Concurrency note: v1 processes sources sequentially and runs up to
 * `spec.concurrency` doc pipelines in flight within a single source
 * via a simple semaphore. Full per-source parallelism and
 * distributed work-stealing land in R2 — the public contract stays
 * the same regardless.
 */
import { createHash } from 'node:crypto';

import type { DeleteRequest, StoreRequest, RetrievalProvider } from '@nova/contracts';

import { RagPipelineManifestSchema, type RagPipelineManifest } from './schema.js';
import { openJournal, type Journal, type JournalEntry } from './journal.js';
import { FETCHERS } from './fetchers/registry.js';
import { TRANSFORMS } from './transforms/registry.js';
import type { RawDoc } from './types.js';
import { loadConfig, resolveNode, defaultConfigPath } from '../../config/kubeconfig.js';
import { createRagAdapter } from '../index.js';

export interface OpenAdapterResult {
  store: RetrievalProvider['store'];
  /**
   * Optional — only required when the manifest's `on_duplicate` is
   * `replace`. Tests that don't exercise that code path can omit it;
   * the runtime logs a descriptive error and continues with the wet
   * store if a replace is attempted without a delete binding.
   */
  delete?: RetrievalProvider['delete'];
  close(): Promise<void>;
}

export interface RunPipelineOptions {
  manifest: RagPipelineManifest;
  journalPath: string;
  /**
   * How to resolve a rag node into an adapter. Default: real
   * kubeconfig + `createRagAdapter`. Tests inject a mocked
   * `store`/`close` pair.
   */
  openAdapter?: (nodeName: string) => Promise<OpenAdapterResult>;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /**
   * Walk the pipeline through fetch + transform + journal without
   * calling `adapter.store`. Every doc that would normally land as a
   * `doc-ingested` entry becomes `doc-would-ingest` instead — the
   * distinction keeps future dedupe logic honest (only wet writes
   * count). Useful for "show me what this spec pulls + chunks
   * without touching the store."
   */
  dryRun?: boolean;
}

export interface RunSummary {
  total_docs: number;
  total_chunks: number;
  skipped_docs: number;
  errors: number;
  elapsed_ms: number;
  per_source: Array<{
    source: string;
    docs: number;
    chunks: number;
    errors: number;
  }>;
}

const BATCH_SIZE = 20;

export async function runPipeline(
  opts: RunPipelineOptions,
): Promise<RunSummary> {
  const manifest = RagPipelineManifestSchema.parse(opts.manifest);
  const env = opts.env ?? process.env;
  const signal = opts.signal ?? new AbortController().signal;

  const journal = await openJournal(opts.journalPath);
  const startedAt = Date.now();

  const sourceLabels = manifest.spec.sources.map((s, i) =>
    sourceLabel(manifest.metadata.name, i, s.kind),
  );

  const specHash = sha256HexBytes(JSON.stringify(manifest.spec));
  await journal.append({
    kind: 'run-started',
    ts: new Date().toISOString(),
    spec_hash: specHash,
    sources: sourceLabels,
  });

  const openAdapter = opts.openAdapter ?? defaultOpenAdapter(env);
  let adapter: OpenAdapterResult;
  try {
    adapter = await openAdapter(manifest.spec.destination.ragNode);
  } catch (err) {
    await journal.append({
      kind: 'error',
      ts: new Date().toISOString(),
      message: `openAdapter failed: ${toMessage(err)}`,
    });
    await journal.append({
      kind: 'run-complete',
      ts: new Date().toISOString(),
      total_docs: 0,
      total_chunks: 0,
      elapsed_ms: Date.now() - startedAt,
    });
    await journal.close();
    throw err;
  }

  const summary: RunSummary = {
    total_docs: 0,
    total_chunks: 0,
    skipped_docs: 0,
    errors: 0,
    elapsed_ms: 0,
    per_source: [],
  };

  try {
    for (let i = 0; i < manifest.spec.sources.length; i++) {
      const src = manifest.spec.sources[i]!;
      const label = sourceLabels[i]!;
      const fetcher = FETCHERS[src.kind];
      if (!fetcher) {
        await journal.append({
          kind: 'error',
          ts: new Date().toISOString(),
          source: label,
          message: `unknown source kind '${src.kind}'`,
        });
        summary.errors++;
        summary.per_source.push({ source: label, docs: 0, chunks: 0, errors: 1 });
        continue;
      }

      await journal.append({
        kind: 'source-started',
        ts: new Date().toISOString(),
        source: label,
      });

      const perSource = await runSource({
        label,
        fetcher,
        sourceSpec: src,
        transforms: manifest.spec.transforms,
        collection: manifest.spec.destination.collection,
        adapter,
        journal,
        env,
        signal,
        concurrency: manifest.spec.concurrency,
        dryRun: opts.dryRun ?? false,
        onDuplicate: manifest.spec.on_duplicate,
      });

      summary.total_docs += perSource.docs;
      summary.total_chunks += perSource.chunks;
      summary.skipped_docs += perSource.skipped;
      summary.errors += perSource.errors;
      summary.per_source.push({
        source: label,
        docs: perSource.docs,
        chunks: perSource.chunks,
        errors: perSource.errors,
      });

      await journal.append({
        kind: 'source-complete',
        ts: new Date().toISOString(),
        source: label,
        docs: perSource.docs,
        chunks: perSource.chunks,
        errors: perSource.errors,
      });
    }
  } finally {
    try {
      await adapter.close();
    } catch {
      // Close errors are noisy but non-fatal — the run already ended.
    }
  }

  summary.elapsed_ms = Date.now() - startedAt;
  await journal.append({
    kind: 'run-complete',
    ts: new Date().toISOString(),
    total_docs: summary.total_docs,
    total_chunks: summary.total_chunks,
    elapsed_ms: summary.elapsed_ms,
  });
  await journal.close();
  return summary;
}

interface PerSourceTally {
  docs: number;
  chunks: number;
  skipped: number;
  errors: number;
}

type OnDuplicate = RagPipelineManifest['spec']['on_duplicate'];

async function runSource(args: {
  label: string;
  fetcher: (typeof FETCHERS)[string];
  sourceSpec: unknown;
  transforms: RagPipelineManifest['spec']['transforms'];
  collection: string;
  adapter: OpenAdapterResult;
  journal: Journal;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  concurrency: number;
  dryRun: boolean;
  onDuplicate: OnDuplicate;
}): Promise<PerSourceTally> {
  const tally: PerSourceTally = { docs: 0, chunks: 0, skipped: 0, errors: 0 };
  const log = (event: Parameters<Parameters<typeof args.fetcher.fetch>[0]['log']>[0]) => {
    if (event.level === 'error') {
      void appendErrorEntry(args.journal, args.label, event.msg);
    }
  };

  let source: AsyncIterable<RawDoc>;
  try {
    source = args.fetcher.fetch({
      spec: args.sourceSpec,
      log,
      signal: args.signal,
      env: args.env,
    });
  } catch (err) {
    tally.errors++;
    await appendErrorEntry(args.journal, args.label, `fetcher init: ${toMessage(err)}`);
    return tally;
  }

  // Doc-level semaphore. `spec.concurrency` sets the max in-flight
  // doc pipelines within a source. Work is submitted as an async
  // task per doc; the semaphore caps in-flight tasks.
  const sem = new Semaphore(Math.max(1, args.concurrency));
  const inflight: Array<Promise<void>> = [];

  try {
    for await (const rawDoc of source) {
      if (args.signal.aborted) break;
      await sem.acquire();
      const task = (async () => {
        try {
          const outcome = await processDoc({
            label: args.label,
            rawDoc,
            transforms: args.transforms,
            collection: args.collection,
            adapter: args.adapter,
            journal: args.journal,
            dryRun: args.dryRun,
            onDuplicate: args.onDuplicate,
          });
          if (outcome.skipped) tally.skipped++;
          else {
            tally.docs++;
            tally.chunks += outcome.chunks;
          }
          if (outcome.errored) tally.errors++;
        } finally {
          sem.release();
        }
      })();
      inflight.push(task);
    }
  } catch (err) {
    tally.errors++;
    await appendErrorEntry(args.journal, args.label, `fetch loop: ${toMessage(err)}`);
  }

  await Promise.all(inflight);
  return tally;
}

async function processDoc(args: {
  label: string;
  rawDoc: RawDoc;
  transforms: RagPipelineManifest['spec']['transforms'];
  collection: string;
  adapter: OpenAdapterResult;
  journal: Journal;
  dryRun: boolean;
  onDuplicate: OnDuplicate;
}): Promise<{ skipped: boolean; errored: boolean; chunks: number }> {
  const { rawDoc, label, transforms, collection, adapter, journal, dryRun, onDuplicate } = args;
  const sha = sha256HexBytes(rawDoc.content);
  // Exact re-ingest is always a no-op — every mode.
  if (await journal.seen(label, rawDoc.id, sha)) {
    await journal.append({
      kind: 'doc-skipped',
      ts: new Date().toISOString(),
      source: label,
      doc_id: rawDoc.id,
      reason: 'duplicate',
    });
    return { skipped: true, errored: false, chunks: 0 };
  }

  let chunks: RawDoc[];
  try {
    chunks = await applyTransforms(rawDoc, transforms);
  } catch (err) {
    await appendErrorEntry(
      journal,
      label,
      `transform failed for ${rawDoc.id}: ${toMessage(err)}`,
      rawDoc.id,
    );
    return { skipped: false, errored: true, chunks: 0 };
  }

  // `version` mode rewrites chunk IDs for re-ingestions so both old
  // and new coexist in the store. First-time ingestions stay bare
  // (no `@sha` suffix) so the operator can start in `skip` and flip
  // to `version` later without bifurcating the ID space unnecessarily.
  // The orig id stays in metadata so retrieval can still attribute
  // the chunk to its doc. `replace` and `skip` use the chunks as the
  // transform emitted them.
  let chunkIdSuffix = '';
  if (onDuplicate === 'version') {
    const prior = await journal.priorIngestions(label, rawDoc.id);
    if (prior.length > 0) chunkIdSuffix = `@${sha.slice(0, 12)}`;
  }
  const storedChunks = chunkIdSuffix
    ? chunks.map((c) => ({
        ...c,
        id: injectIdSuffix(c.id, rawDoc.id, chunkIdSuffix),
        metadata: { ...c.metadata, orig_doc_id: rawDoc.id, version_sha: sha.slice(0, 12) },
      }))
    : chunks;
  const chunkIds = storedChunks.map((c) => c.id);

  let errored = false;
  if (!dryRun) {
    // `replace`: union every prior ingestion's chunk_ids and delete
    // them up front. Only relevant when this doc_id has been seen
    // before with a different sha. No-ops for fresh docs.
    if (onDuplicate === 'replace') {
      const priorIds = await collectPriorChunkIds(journal, label, rawDoc.id);
      if (priorIds.length > 0) {
        if (!adapter.delete) {
          await appendErrorEntry(
            journal,
            label,
            `on_duplicate=replace requested but adapter has no delete binding — skipping pre-delete for ${rawDoc.id}`,
            rawDoc.id,
          );
        } else {
          try {
            const deleteReq: DeleteRequest = { ids: priorIds, collection };
            await adapter.delete(deleteReq);
          } catch (err) {
            errored = true;
            await appendErrorEntry(
              journal,
              label,
              `replace-delete failed for ${rawDoc.id}: ${toMessage(err)}`,
              rawDoc.id,
            );
            // Surface but keep going — the store below will overwrite
            // matching IDs in some adapters (pgvector upserts) and
            // duplicate in others. Either outcome is still auditable
            // via the journal.
          }
        }
      }
    }

    for (let i = 0; i < storedChunks.length; i += BATCH_SIZE) {
      const batch = storedChunks.slice(i, i + BATCH_SIZE);
      const storeReq: StoreRequest = {
        collection,
        documents: batch.map((c) => ({
          id: c.id,
          content: c.content,
          metadata: c.metadata,
        })),
      };
      try {
        await adapter.store(storeReq);
      } catch (err) {
        errored = true;
        await appendErrorEntry(
          journal,
          label,
          `store failed for ${rawDoc.id} batch@${i}: ${toMessage(err)}`,
          rawDoc.id,
        );
        // Surface the first batch failure and stop pushing the rest —
        // partial doc in the store is a worse outcome than a retry.
        break;
      }
    }
  }

  await journal.append({
    kind: dryRun ? 'doc-would-ingest' : 'doc-ingested',
    ts: new Date().toISOString(),
    source: label,
    doc_id: rawDoc.id,
    sha,
    chunks: storedChunks.length,
    chunk_ids: chunkIds,
  });

  return { skipped: false, errored, chunks: storedChunks.length };
}

async function collectPriorChunkIds(
  journal: Journal,
  source: string,
  doc_id: string,
): Promise<string[]> {
  const prior = await journal.priorIngestions(source, doc_id);
  if (prior.length === 0) return [];
  // Union across every prior sha — operator may have toggled between
  // `skip` (orphans pile up) and `replace` over time, so we clean up
  // whatever's still addressable, not just the most recent version.
  const dedup = new Set<string>();
  for (const p of prior) {
    for (const id of p.chunk_ids) dedup.add(id);
  }
  return Array.from(dedup);
}

/**
 * Inject `suffix` between the doc_id prefix and any transform-added
 * chunk marker (e.g. `#3`). Most transforms emit IDs shaped
 * `<doc_id><marker>`; falling back to plain concatenation when the
 * prefix isn't recognized keeps us safe for future transforms.
 */
function injectIdSuffix(chunkId: string, docId: string, suffix: string): string {
  if (chunkId === docId) return `${docId}${suffix}`;
  if (chunkId.startsWith(docId)) {
    return `${docId}${suffix}${chunkId.slice(docId.length)}`;
  }
  return `${chunkId}${suffix}`;
}

/**
 * Pipe transforms in declared order. We collect the full output into
 * an array because the orchestrator needs the chunk count up front
 * for batching + journaling. Memory is bounded by a single doc's
 * chunk set, which is reasonable for v1; streaming all the way to
 * store() is a future optimization.
 */
async function applyTransforms(
  rawDoc: RawDoc,
  transforms: RagPipelineManifest['spec']['transforms'],
): Promise<RawDoc[]> {
  let stream: AsyncIterable<RawDoc> = asAsync(rawDoc);
  for (const t of transforms) {
    const impl = TRANSFORMS[t.kind];
    if (!impl) throw new Error(`unknown transform kind '${t.kind}'`);
    stream = impl.transform(stream, t);
  }
  const out: RawDoc[] = [];
  for await (const d of stream) out.push(d);
  return out.length > 0 ? out : [rawDoc];
}

async function* asAsync(doc: RawDoc): AsyncIterable<RawDoc> {
  yield doc;
}

async function appendErrorEntry(
  journal: Journal,
  source: string,
  message: string,
  doc_id?: string,
): Promise<void> {
  const entry: JournalEntry = {
    kind: 'error',
    ts: new Date().toISOString(),
    source,
    message,
    ...(doc_id !== undefined ? { doc_id } : {}),
  };
  await journal.append(entry);
}

function sha256HexBytes(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sourceLabel(pipeline: string, index: number, kind: string): string {
  return `${pipeline}:${index}:${kind}`;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Default adapter opener — reads kubeconfig, resolves the rag node,
 * hands to `createRagAdapter`. Tests inject `openAdapter` instead so
 * no kubeconfig lookup or Postgres connection is required.
 */
function defaultOpenAdapter(
  env: NodeJS.ProcessEnv,
): (nodeName: string) => Promise<OpenAdapterResult> {
  return async (nodeName) => {
    const cfg = loadConfig(defaultConfigPath(env));
    const resolved = resolveNode(cfg, nodeName);
    const adapter = await createRagAdapter(resolved.node, { env, config: cfg });
    return {
      store: adapter.store.bind(adapter),
      delete: adapter.delete.bind(adapter),
      close: () => adapter.close(),
    };
  };
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}
