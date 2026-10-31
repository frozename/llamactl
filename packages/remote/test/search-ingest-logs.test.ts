// packages/remote/test/search-ingest-logs.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { startLogsIngest } from "../src/search/ingest/logs.js";

describe("logs ingest", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "logs-ingest-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("emits one record per non-empty line", async () => {
    const path = join(tmp, "a.log");
    writeFileSync(path, "line one\nline two\nline three\n", "utf8");
    const seen: { content: string }[] = [];
    const stop = startLogsIngest({
      files: [{ label: "a", path }],
      sink: async (records) => {
        await Promise.resolve();
        seen.push(...records);
      },
      pollMs: 30,
    });
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(seen.length).toBe(3);
  });

  test("tails appended content on next poll", async () => {
    const path = join(tmp, "b.log");
    writeFileSync(path, "first\n", "utf8");
    const seen: { content: string }[] = [];
    const stop = startLogsIngest({
      files: [{ label: "b", path }],
      sink: async (records) => {
        await Promise.resolve();
        seen.push(...records);
      },
      pollMs: 20,
    });
    await new Promise((r) => setTimeout(r, 50));
    appendFileSync(path, "second\n", "utf8");
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(seen.map((r) => r.content)).toContain("second");
    expect(seen.map((r) => r.content)).toContain("first");
  });

  test("line split across two reads is ingested as one document", async () => {
    const path = join(tmp, "split.log");
    // Write the first half of a line without a terminating newline.
    writeFileSync(path, "partial-li", "utf8");
    const seen: string[] = [];
    const stop = startLogsIngest({
      files: [{ label: "s", path }],
      sink: async (records) => {
        await Promise.resolve();
        for (const r of records) seen.push(r.content);
      },
      pollMs: 20,
    });
    // First tick reads "partial-li" — no complete lines yet.
    await new Promise((r) => setTimeout(r, 60));
    expect(seen).toHaveLength(0);
    // Complete the line.
    appendFileSync(path, "ne-complete\n", "utf8");
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe("partial-line-complete");
  });

  test("bounds initial and appended backlogs to the configured tail window", async () => {
    const path = join(tmp, "bounded.log");
    writeFileSync(path, "old".repeat(100) + "\nkeep one\nkeep two\n");
    const seen: string[] = [];
    const stop = startLogsIngest({
      files: [{ label: "bounded", path }],
      windowBytes: 32,
      pollMs: 10,
      sink: async (records) => {
        await Promise.resolve();
        seen.push(...records.map((r) => r.content));
      },
    });
    try {
      await Bun.sleep(30);
      expect(seen).toEqual(["keep one", "keep two"]);
      appendFileSync(path, "discard".repeat(100) + "\nappended\n");
      await Bun.sleep(30);
      expect(seen).toEqual(["keep one", "keep two", "appended"]);
    } finally {
      stop();
    }
  });

  test("default window bounds a multi-megabyte startup backlog", async () => {
    const path = join(tmp, "default-window.log");
    writeFileSync(path, ("x".repeat(1023) + "\n").repeat(2048));
    const seen: string[] = [];
    const stop = startLogsIngest({
      files: [{ label: "default", path }],
      sink: async (records) => {
        await Promise.resolve();
        seen.push(...records.map((r) => r.content));
      },
    });
    try {
      await Bun.sleep(10);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0)).toBeLessThanOrEqual(
        1024 * 1024,
      );
      expect(seen.every((text) => text === "x".repeat(1023))).toBe(true);
    } finally {
      stop();
    }
  });

  test("bounds unterminated lines across multiple reads without emitting fragments", async () => {
    const path = join(tmp, "long-line.log");
    writeFileSync(path, "x".repeat(20));
    const seen: string[] = [];
    const stop = startLogsIngest({
      files: [{ label: "long", path }],
      windowBytes: 32,
      pollMs: 10,
      sink: async (records) => {
        await Promise.resolve();
        seen.push(...records.map((r) => r.content));
      },
    });
    try {
      await Bun.sleep(30);
      appendFileSync(path, "x".repeat(20));
      await Bun.sleep(30);
      appendFileSync(path, "\nvalid\n");
      await Bun.sleep(30);
      expect(seen).toEqual(["valid"]);
    } finally {
      stop();
    }
  });

  test("does not overlap a blocked sink or replay its batch", async () => {
    const path = join(tmp, "slow.log");
    writeFileSync(path, "first\n");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const stop = startLogsIngest({
      files: [{ label: "slow", path }],
      pollMs: 5,
      sink: async (records) => {
        await Promise.resolve();
        seen.push(...records.map((r) => r.content));
        await blocked;
      },
    });
    try {
      await Bun.sleep(30);
      expect(seen).toEqual(["first"]);
      appendFileSync(path, "second\n");
      await Bun.sleep(30);
      expect(seen).toEqual(["first"]);
      release();
      await Bun.sleep(30);
      expect(seen).toEqual(["first", "second"]);
    } finally {
      stop();
      release();
    }
  });

  test("stop during a pending sink prevents reading the next file", async () => {
    const first = join(tmp, "first.log"),
      second = join(tmp, "second.log");
    writeFileSync(first, "first\n");
    writeFileSync(second, "second\n");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const stop = startLogsIngest({
      files: [
        { label: "first", path: first },
        { label: "second", path: second },
      ],
      pollMs: 5,
      sink: async (records) => {
        await Promise.resolve();
        seen.push(...records.map((r) => r.content));
        await blocked;
      },
    });
    stop();
    release();
    await Bun.sleep(30);
    expect(seen).toEqual(["first"]);
  });
});
