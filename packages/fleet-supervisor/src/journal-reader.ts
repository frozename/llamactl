import { closeSync, fstatSync, openSync, readSync } from "./safe-fs.js";

// Oversized records are unsupported so one journal line cannot exhaust agent memory.
export const MAX_JOURNAL_LINE_BYTES = 8 * 1024 * 1024;
const READ_BYTES = 64 * 1024;

class JournalLine {
  private parts: Buffer[] = [];
  private bytes = 0;
  private oversized = false;

  consume(segment: Buffer, complete: boolean): string | null {
    if (!this.oversized && this.bytes + segment.length > MAX_JOURNAL_LINE_BYTES) {
      this.oversized = true;
      this.parts = [];
    }
    if (this.oversized) {
      if (complete) this.reset();
      return null;
    }
    if (!complete) {
      // The next read overwrites buffer, so unfinished lines must own their bytes.
      this.parts.push(Buffer.from(segment));
      this.bytes += segment.length;
      return null;
    }
    const text =
      this.parts.length === 0
        ? segment.toString("utf8")
        : Buffer.concat([...this.parts, segment], this.bytes + segment.length).toString("utf8");
    this.reset();
    return text;
  }

  private reset(): void {
    this.parts = [];
    this.bytes = 0;
    this.oversized = false;
  }
}

/** Scans the initial file extent; lines above 8 MiB before LF (including CR) are ignored. */
export function* readJournalLines(path: string): Generator<string> {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.allocUnsafe(READ_BYTES);
    const line = new JournalLine();
    for (let offset = 0; offset < size; ) {
      const bytes = readSync(fd, buffer, 0, Math.min(READ_BYTES, size - offset), offset);
      if (bytes === 0) break;
      offset += bytes;
      const chunk = buffer.subarray(0, bytes);
      let start = 0;
      while (start < bytes) {
        const newline = chunk.indexOf(10, start);
        const end = newline === -1 ? bytes : newline;
        const text = line.consume(chunk.subarray(start, end), newline !== -1);
        if (text !== null) yield text;
        start = end + 1;
      }
    }
    const last = line.consume(Buffer.alloc(0), true);
    if (last !== null) yield last;
  } finally {
    closeSync(fd);
  }
}
