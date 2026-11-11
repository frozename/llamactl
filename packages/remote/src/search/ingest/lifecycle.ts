import type { IngestRecord } from "./sessions.js";

import { createRagAdapter } from "../../rag/index.js";
import { resolveRagNode } from "../../rag/resolve.js";
import { resolveDefaultRagNode } from "../rag-node.js";
import { startLogsIngest } from "./logs.js";
// packages/remote/src/search/ingest/lifecycle.ts
import { startSessionsIngest } from "./sessions.js";

/**
 * Stops the search ingests started by one `startSearchIngest()` call. A handle
 * is scoped to that single start; `stopSearchIngest()` is process-wide and
 * stops every ingest started anywhere in the process.
 */
export type SearchIngestStop = () => void;

let stopFns: (() => void)[] = [];

function makeSink(
  nodeName: string,
  collection: "sessions" | "logs",
): (records: IngestRecord[]) => Promise<void> {
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

// Stops each entry that is still registered, splicing it out of the process
// registry first. An entry already removed by stopSearchIngest() is skipped, so
// no stop is ever called twice.
function stopEntries(entries: (() => void)[]): void {
  for (const entry of entries) {
    const index = stopFns.indexOf(entry);
    if (index === -1) continue;
    stopFns.splice(index, 1);
    try {
      entry();
    } catch {
      /* swallow */
    }
  }
}

export function startSearchIngest(): SearchIngestStop {
  const nodeName = resolveDefaultRagNode();
  if (!nodeName) return () => undefined;
  const sessionsSink = makeSink(nodeName, "sessions");
  const logsSink = makeSink(nodeName, "logs");
  const mine: (() => void)[] = [];
  const register = (stop: () => void): void => {
    mine.push(stop);
    stopFns.push(stop);
  };
  try {
    register(startSessionsIngest({ sink: sessionsSink }));
    register(
      startLogsIngest({
        sink: logsSink,
        files: [
          { label: "agent", path: "/tmp/llamactl-agent.log" },
          { label: "electron", path: "/tmp/llamactl-electron.log" },
        ],
      }),
    );
  } catch (err) {
    // A partial start undoes itself: the already-started ingest is stopped
    // before the original error propagates.
    stopEntries(mine);
    throw err;
  }
  let stopped = false;
  return (): void => {
    if (stopped) return;
    stopped = true;
    stopEntries(mine);
  };
}

export function stopSearchIngest(): void {
  const entryFns = stopFns;
  stopFns = [];
  for (const stop of entryFns) {
    try {
      stop();
    } catch {
      /* swallow */
    }
  }
}
