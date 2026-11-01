import type { IngestRecord } from "./sessions.js";

// packages/remote/src/search/ingest/logs.ts
import { closeSync, existsSync, openSync, readSync, statSync } from "../../safe-fs.js";

export interface LogsIngestOpts {
  files: { label: string; path: string }[];
  sink: (records: IngestRecord[]) => Promise<void>;
  pollMs?: number;
  /** Bytes retained from each file, including any unterminated line; default 1MiB. */
  windowBytes?: number;
}

interface FileCursor {
  offset: number;
  pending: string;
  discardLeading: boolean;
}

function readChunk(path: string, cursor: FileCursor, size: number): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - cursor.offset);
    const count = readSync(fd, buffer, 0, buffer.length, cursor.offset);
    cursor.offset += count;
    return buffer.toString("utf8", 0, count);
  } finally {
    closeSync(fd);
  }
}

function readRecords(
  file: LogsIngestOpts["files"][number],
  cursor: FileCursor,
  windowBytes: number,
): IngestRecord[] {
  const size = statSync(file.path).size;
  if (cursor.offset > size) {
    cursor.offset = 0;
    cursor.pending = "";
    cursor.discardLeading = false;
  }
  if (cursor.offset === size) return [];
  // Ingest is best-effort: bound both startup backlogs and partial lines.
  if (size - cursor.offset + Buffer.byteLength(cursor.pending) > windowBytes) {
    cursor.offset = Math.max(0, size - windowBytes);
    cursor.pending = "";
    cursor.discardLeading = cursor.offset > 0;
  }
  const start = cursor.offset;
  let text = cursor.pending + readChunk(file.path, cursor, size);
  if (cursor.discardLeading) {
    const first = text.indexOf("\n");
    if (first < 0) {
      cursor.pending = "";
      return [];
    }
    text = text.slice(first + 1);
    cursor.discardLeading = false;
  }
  const boundary = text.lastIndexOf("\n") + 1;
  cursor.pending = text.slice(boundary);
  return text
    .slice(0, boundary)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, index) => ({
      id: `${file.label}::${String(start)}::${String(index)}`,
      content: line,
      metadata: { fileLabel: file.label, filePath: file.path, where: file.label },
    }));
}

export function startLogsIngest(opts: LogsIngestOpts): () => void {
  const pollMs = opts.pollMs ?? 30_000;
  const windowBytes = opts.windowBytes ?? 1024 * 1024;
  const cursors = new Map<string, FileCursor>();
  let stopped = false;
  let inflight = false;
  const isStopped = (): boolean => stopped;

  async function tick(): Promise<void> {
    if (stopped || inflight) return;
    inflight = true;
    try {
      for (const file of opts.files) {
        if (isStopped()) return;
        if (!existsSync(file.path)) continue;
        const cursor = cursors.get(file.path) ?? { offset: 0, pending: "", discardLeading: false };
        cursors.set(file.path, cursor);
        const records = readRecords(file, cursor, windowBytes);
        if (records.length > 0) {
          try {
            await opts.sink(records);
          } catch {
            /* ingest is best-effort */
          }
        }
      }
    } finally {
      inflight = false;
    }
  }

  void tick();
  const timer = setInterval(() => void tick(), pollMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    cursors.clear();
  };
}
