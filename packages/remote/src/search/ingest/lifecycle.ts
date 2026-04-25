// packages/remote/src/search/ingest/lifecycle.ts
import { startSessionsIngest } from './sessions.js';
import { startLogsIngest } from './logs.js';
import { resolveDefaultRagNode } from '../rag-node.js';
import { resolveRagNode } from '../../rag/resolve.js';
import { createRagAdapter } from '../../rag/index.js';
import type { IngestRecord } from './sessions.js';

let stopFns: (() => void)[] = [];

async function makeSink(collection: 'sessions' | 'logs'): Promise<(records: IngestRecord[]) => Promise<void>> {
  const nodeName = await resolveDefaultRagNode();
  if (!nodeName) return async () => { /* no-op when no RAG node */ };
  return async (records) => {
    const { node, cfg } = resolveRagNode(nodeName);
    const adapter = await createRagAdapter(node, { config: cfg });
    try {
      await adapter.store({
        collection,
        documents: records.map((r) => ({
          id: r.id,
          content: r.content,
          metadata: r.metadata,
        })),
      });
    } finally {
      await adapter.close();
    }
  };
}

export async function startSearchIngest(): Promise<void> {
  const sessionsSink = await makeSink('sessions');
  const logsSink = await makeSink('logs');
  stopFns.push(startSessionsIngest({ sink: sessionsSink }));
  stopFns.push(startLogsIngest({ sink: logsSink }));
}

export function stopSearchIngest(): void {
  for (const stop of stopFns) {
    try { stop(); } catch { /* swallow */ }
  }
  stopFns = [];
}