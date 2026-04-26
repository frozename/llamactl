// packages/remote/src/search/ingest/logs.ts
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import type { IngestRecord } from './sessions.js';

export interface LogsIngestOpts {
  files: { label: string; path: string }[];
  sink: (records: IngestRecord[]) => Promise<void>;
  pollMs?: number;
  /** Bytes after which we discard content from the head of the file. */
  windowBytes?: number;
}

interface FileCursor { offset: number }

export function startLogsIngest(opts: LogsIngestOpts): () => void {
  const pollMs = opts.pollMs ?? 30_000;
  const cursors = new Map<string, FileCursor>();
  let stopped = false;

  async function tick(): Promise<void> {
    for (const f of opts.files) {
      if (!existsSync(f.path)) continue;
      const size = statSync(f.path).size;
      const cur = cursors.get(f.path) ?? { offset: 0 };
      if (cur.offset > size) cur.offset = 0; // log was rotated
      if (cur.offset === size) {
        cursors.set(f.path, cur);
        continue;
      }
      const fd = openSync(f.path, 'r');
      try {
        const buf = Buffer.alloc(size - cur.offset);
        readSync(fd, buf, 0, buf.length, cur.offset);
        const text = buf.toString('utf8');
        const lines = text.split('\n').filter((l) => l.length > 0);
        const records: IngestRecord[] = lines.map((line, idx) => ({
          id: `${f.label}::${cur.offset}::${idx}`,
          content: line,
          metadata: { fileLabel: f.label, filePath: f.path, where: f.label },
        }));
        if (records.length > 0) {
          try { await opts.sink(records); } catch { /* swallow */ }
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