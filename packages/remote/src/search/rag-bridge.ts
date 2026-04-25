// packages/remote/src/search/rag-bridge.ts
import type { SessionHit, KnowledgeHit, LogHit } from './types.js';
import { resolveRagNode } from '../rag/resolve.js';
import { createRagAdapter } from '../rag/index.js';

export type RagCollection = 'sessions' | 'knowledge' | 'logs';

export interface RagBridgeOpts {
  node: string;
  collection: RagCollection;
  query: string;
  topK?: number;
  signal?: AbortSignal;
  /** Test-only seam. */
  adapter?: any;
}

export async function ragBridgeSearch(
  opts: RagBridgeOpts,
): Promise<Array<SessionHit | KnowledgeHit | LogHit>> {
  if (opts.signal?.aborted) throw new Error('aborted');
  let adapter = opts.adapter;
  if (!adapter) {
    const { node, cfg } = resolveRagNode(opts.node);
    adapter = await createRagAdapter(node, { config: cfg });
  }
  try {
    const res = await adapter.search({
      query: opts.query,
      topK: opts.topK ?? 10,
      collection: opts.collection,
    });
    return normalizeHits(opts.collection, res);
  } finally {
    if (!opts.adapter) {
      await adapter.close();
    }
  }
}

function normalizeHits(
  collection: RagCollection,
  res: unknown,
): Array<SessionHit | KnowledgeHit | LogHit> {
  const hits = (res as { hits?: Array<any> }).hits ?? [];
  if (collection === 'sessions') {
    return hits.map((h) => ({
      sessionId: h.metadata?.sessionId ?? h.id,
      goal: h.metadata?.goal ?? '',
      status: h.metadata?.status ?? 'live',
      startedAt: h.metadata?.startedAt ?? '',
      matches: [{
        where: h.metadata?.where ?? 'session content',
        snippet: String(h.content ?? '').slice(0, 200),
        spans: [],
      }],
      score: typeof h.score === 'number' ? h.score : 0,
    }));
  }
  if (collection === 'knowledge') {
    return hits.map((h) => ({
      entityId: h.metadata?.entityId ?? h.id,
      title: h.metadata?.title ?? h.id,
      matches: [{
        where: 'body',
        snippet: String(h.content ?? '').slice(0, 200),
        spans: [],
      }],
      score: typeof h.score === 'number' ? h.score : 0,
    }));
  }
  return hits.map((h) => ({
    fileLabel: h.metadata?.fileLabel ?? 'unknown',
    filePath: h.metadata?.filePath ?? '',
    matches: [{
      lineNumber: h.metadata?.lineNumber ?? 0,
      where: h.metadata?.where ?? '',
      snippet: String(h.content ?? '').slice(0, 200),
      spans: [],
    }],
    score: typeof h.score === 'number' ? h.score : 0,
  }));
}