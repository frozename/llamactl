import type { IngestRecord } from "./sessions.js";

import { createRagAdapter } from "../../rag/index.js";
import { resolveRagNode } from "../../rag/resolve.js";
import { resolveDefaultRagNode } from "../rag-node.js";
import { startLogsIngest } from "./logs.js";
// packages/remote/src/search/ingest/lifecycle.ts
import { startSessionsIngest } from "./sessions.js";

let stopFns: (() => void)[] = [];

function makeSink(collection: "sessions" | "logs"): (records: IngestRecord[]) => Promise<void> {
  const nodeName = resolveDefaultRagNode();
  if (!nodeName)
    return async () => {
      /* no-op when no RAG node */
    };
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

export function startSearchIngest(): Promise<void> {
  const sessionsSink = makeSink("sessions");
  const logsSink = makeSink("logs");
  stopFns.push(startSessionsIngest({ sink: sessionsSink }));
  stopFns.push(
    startLogsIngest({
      sink: logsSink,
      files: [
        { label: "agent", path: "/tmp/llamactl-agent.log" },
        { label: "electron", path: "/tmp/llamactl-electron.log" },
      ],
    }),
  );
  return Promise.resolve();
}

export function stopSearchIngest(): void {
  for (const stop of stopFns) {
    try {
      stop();
    } catch {
      /* swallow */
    }
  }
  stopFns = [];
}
