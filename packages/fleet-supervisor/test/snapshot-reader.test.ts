import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as fs from "../src/safe-fs.js";
import { readLatestFleetSnapshotFromJournal } from "../src/snapshot-reader.js";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const paths: string[] = [];

function journal(contents: string): string {
  const dir = fs.mkdtempSync(join(tmpdir(), "fleet-snapshot-reader-"));
  paths.push(dir);
  const path = join(dir, "journal.jsonl");
  fs.writeFileSync(path, contents);
  return path;
}

function snapshot(ts: string, node = "synthetic"): string {
  return JSON.stringify({ kind: "fleet-snapshot", ts, node });
}

afterEach(() => {
  for (const path of paths.splice(0)) fs.rmSync(path, { recursive: true, force: true });
});

describe("fleet snapshot journal reader", () => {
  test("keeps the first snapshot with the lexicographically greatest string timestamp", () => {
    const path = journal(
      [snapshot("z", "first"), snapshot("2026-10-31"), snapshot("z", "tie")].join("\n"),
    );
    expect(JSON.stringify(readLatestFleetSnapshotFromJournal(path))).toBe(snapshot("z", "first"));
  });

  test("ignores malformed records, wrong kinds and non-string timestamps", () => {
    const path = journal(
      "\r\n  " +
        snapshot("a") +
        '\r\nnull\n{bad}\n{"kind":"fleet-heartbeat","ts":"z"}\n{"kind":"fleet-snapshot","ts":9}\n{"kind":',
    );
    expect(readLatestFleetSnapshotFromJournal(path)?.ts).toBe("a");
  });

  test("accepts a complete final record without a newline and preserves split UTF-8", () => {
    const prefix = '{"kind":"fleet-snapshot","ts":"a","node":"';
    const node = "x".repeat(65535 - Buffer.byteLength(prefix)) + "🙂";
    expect(readLatestFleetSnapshotFromJournal(journal(prefix + node + '"}'))?.node).toBe(node);
  });

  test("returns null for a missing or empty journal", () => {
    const path = journal("");
    expect(readLatestFleetSnapshotFromJournal(path)).toBeNull();
    fs.unlinkSync(path);
    expect(readLatestFleetSnapshotFromJournal(path)).toBeNull();
  });

  test("does not allocate the complete journal and bounds each filesystem read", () => {
    const path = journal((snapshot("a") + "\n").repeat(20000) + snapshot("z"));
    const wholeFile = spyOn(fs, "readFileSync");
    const reads = spyOn(fs, "readSync");
    try {
      expect(readLatestFleetSnapshotFromJournal(path)?.ts).toBe("z");
      expect(wholeFile).not.toHaveBeenCalled();
      expect(reads.mock.calls.length).toBeGreaterThan(1);
      for (const call of reads.mock.calls)
        expect(Number(call.at(3))).toBeLessThanOrEqual(64 * 1024);
    } finally {
      wholeFile.mockRestore();
      reads.mockRestore();
    }
  });

  test("ignores an oversized encoded line and resumes at the following record", () => {
    const path = journal(snapshot("z", "x".repeat(MAX_LINE_BYTES)) + "\n" + snapshot("a"));
    expect(readLatestFleetSnapshotFromJournal(path)?.ts).toBe("a");
  });

  test("accepts a line at the encoded byte limit", () => {
    const prefix = snapshot("a", "");
    const line = snapshot("a", "x".repeat(MAX_LINE_BYTES - Buffer.byteLength(prefix)));
    expect(Buffer.byteLength(line)).toBe(MAX_LINE_BYTES);
    expect(readLatestFleetSnapshotFromJournal(journal(line))?.ts).toBe("a");
  });

  test("counts multibyte data and CR before trimming against the line ceiling", () => {
    const prefix = snapshot("z", "");
    const line = snapshot(
      "z",
      "é".repeat(Math.floor((MAX_LINE_BYTES - Buffer.byteLength(prefix)) / 2)),
    );
    const path = journal(line + "  \r\n" + snapshot("a"));
    expect(readLatestFleetSnapshotFromJournal(path)?.ts).toBe("a");
  });

  test("returns null when every line is oversized or malformed", () => {
    const path = journal("x".repeat(MAX_LINE_BYTES + 1) + '\n{"kind":');
    expect(readLatestFleetSnapshotFromJournal(path)).toBeNull();
  });

  test("rereads replacement and truncated journals without stale state", () => {
    const path = journal(snapshot("z"));
    expect(readLatestFleetSnapshotFromJournal(path)?.ts).toBe("z");
    const replacement = path + ".next";
    fs.writeFileSync(replacement, snapshot("a"));
    fs.renameSync(replacement, path);
    expect(readLatestFleetSnapshotFromJournal(path)?.ts).toBe("a");
    fs.truncateSync(path, 0);
    expect(readLatestFleetSnapshotFromJournal(path)).toBeNull();
  });
  test("defers concurrent appends beyond the initially opened file size", () => {
    const path = journal(snapshot("a") + "\n");
    const original = fs.readSync;
    let appended = false;
    const read = spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
      const count = Reflect.apply(original, fs, args) as number;
      if (!appended) {
        appended = true;
        fs.appendFileSync(path, snapshot("z") + "\n");
      }
      return count;
    });
    try {
      expect(readLatestFleetSnapshotFromJournal(path)?.ts).toBe("a");
      expect(appended).toBe(true);
    } finally {
      read.mockRestore();
    }
    expect(readLatestFleetSnapshotFromJournal(path)?.ts).toBe("z");
  });

  test("closes the opened descriptor when a read fails", () => {
    const path = journal(snapshot("a"));
    const read = spyOn(fs, "readSync").mockImplementation(() => {
      throw new Error("synthetic read failure");
    });
    const close = spyOn(fs, "closeSync");
    try {
      expect(() => readLatestFleetSnapshotFromJournal(path)).toThrow("synthetic read failure");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
      close.mockRestore();
    }
  });
  test("finishes the opened inode when the journal rotates during a read", () => {
    const path = journal(snapshot("z") + "\n" + (snapshot("a") + "\n").repeat(3000));
    const original = fs.readSync;
    let rotated = false;
    const read = spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
      const count = Reflect.apply(original, fs, args) as number;
      if (!rotated) {
        rotated = true;
        fs.renameSync(path, path + ".old");
        fs.writeFileSync(path, snapshot("zz"));
      }
      return count;
    });
    try {
      expect(readLatestFleetSnapshotFromJournal(path)?.ts).toBe("z");
      expect(rotated).toBe(true);
    } finally {
      read.mockRestore();
    }
    expect(readLatestFleetSnapshotFromJournal(path)?.ts).toBe("zz");
  });

  test("stops at EOF after concurrent truncation without retaining a prior result", () => {
    const path = journal(snapshot("a") + "\n" + " ".repeat(200000) + "\n" + snapshot("z"));
    const original = fs.readSync;
    let truncated = false;
    const read = spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
      const count = Reflect.apply(original, fs, args) as number;
      if (!truncated) {
        truncated = true;
        fs.truncateSync(path, 0);
      }
      return count;
    });
    try {
      expect(readLatestFleetSnapshotFromJournal(path)?.ts).toBe("a");
      expect(truncated).toBe(true);
    } finally {
      read.mockRestore();
    }
    expect(readLatestFleetSnapshotFromJournal(path)).toBeNull();
  });
});
