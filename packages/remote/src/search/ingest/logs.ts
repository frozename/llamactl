import type { IngestRecord } from "./sessions.js";

// packages/remote/src/search/ingest/logs.ts
import { closeSync, existsSync, openSync, readSync, statSync } from "../../safe-fs.js";

export interface LogsIngestOpts {
  files: { label: string; path: string }[];
  sink: (records: IngestRecord[]) => Promise<void>;
  pollMs?: number;
  /** Bytes after which we discard content from the head of the file. */
  windowBytes?: number;
}

interface FileCursor {
  offset: number;
  pending: string;
}

export function startLogsIngest(opts: LogsIngestOpts): () => void {
  const pollMs = opts.pollMs ?? 30_000;
  const cursors = new Map<string, FileCursor>();
  let stopped = false;

  async function tick(): Promise<void> {
    for (const f of opts.files) {
      if (!existsSync(f.path)) continue;
      const size = statSync(f.path).size;
      const cur = cursors.get(f.path) ?? { offset: 0, pending: "" };
      if (cur.offset > size) {
        cur.offset = 0;
        cur.pending = "";
      } // log was rotated
      if (cur.offset === size) {
        cursors.set(f.path, cur);
        continue;
      }
      const fd = openSync(f.path, "r");
      try {
        const buf = Buffer.alloc(size - cur.offset);
        readSync(fd, buf, 0, buf.length, cur.offset);
        const text = cur.pending + buf.toString("utf8");
        // Split at the last newline: everything before is complete lines,
        // everything after is a partial line buffered for the next read.
        const boundary = text.lastIndexOf("\n") + 1;
        cur.pending = text.slice(boundary);
        const lines = text
          .slice(0, boundary)
          .split("\n")
          .filter((l) => l.length > 0);
        const records: IngestRecord[] = lines.map((line, idx) => ({
          id: `${f.label}::${String(cur.offset)}::${String(idx)}`,
          content: line,
          metadata: { fileLabel: f.label, filePath: f.path, where: f.label },
        }));
        if (records.length > 0) {
          try {
            await opts.sink(records);
          } catch {
            /* swallow */
          }
        }
        cur.offset = size;
        cursors.set(f.path, cur);
      } finally {
        closeSync(fd);
      }
    }
  }

  void tick();
  const timer = setInterval(() => {
    if (stopped) return;
    void tick();
  }, pollMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
