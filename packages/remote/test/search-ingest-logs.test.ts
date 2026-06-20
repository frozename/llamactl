// packages/remote/test/search-ingest-logs.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
});
