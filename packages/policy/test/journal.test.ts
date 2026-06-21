/* eslint-disable @typescript-eslint/no-unsafe-assignment -- JSON.parse returns any; test fixtures inspect journal lines with explicit type annotations. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendCostJournal } from "../src/journal.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "../src/safe-fs.js";

describe("appendCostJournal", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "policy-journal-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes a JSONL line and creates missing parent dirs", () => {
    const path = join(dir, "sub", "journal.jsonl");
    appendCostJournal({ kind: "error", ts: "2026-01-01T00:00:00Z", message: "test-error" }, path);
    const parsed: { kind: string; message: string } = JSON.parse(readFileSync(path, "utf8").trim());
    expect(parsed.kind).toBe("error");
    expect(parsed.message).toBe("test-error");
  });

  test("does not throw when disk write fails (ENOTDIR)", () => {
    // Place a regular file where the parent directory would need to be created,
    // forcing mkdirSync to throw ENOTDIR.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "i am a file");
    const brokenPath = join(blocker, "sub", "journal.jsonl");
    expect(() => {
      appendCostJournal({ kind: "error", ts: "x", message: "m" }, brokenPath);
    }).not.toThrow();
  });

  test("writes error description to stderr on disk failure", () => {
    const blocker = join(dir, "blocker2");
    writeFileSync(blocker, "i am a file");
    const brokenPath = join(blocker, "sub", "journal.jsonl");

    const stderrLines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrLines.push(String(chunk));
      return true;
    };
    try {
      appendCostJournal({ kind: "error", ts: "x", message: "m" }, brokenPath);
    } finally {
      process.stderr.write = orig;
    }
    expect(stderrLines.join("")).toContain("cost-guardian");
  });
});
