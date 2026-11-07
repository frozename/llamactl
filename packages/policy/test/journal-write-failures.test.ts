import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CostJournalActionEntry, CostJournalErrorEntry } from "../src/journal.js";

import { appendCostJournal } from "../src/journal.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../src/safe-fs.js";

describe("appendCostJournal write failures", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "policy-journal-fail-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("target path is a directory", () => {
    const target = join(dir, "journal.jsonl");
    mkdirSync(target);

    let expected = "";
    try {
      writeFileSync(target, "x", "utf8");
    } catch (e) {
      expected = (e as Error).message;
    }
    expect(expected.length).toBeGreaterThan(0);

    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
    appendCostJournal(
      {
        kind: "error" as CostJournalErrorEntry["kind"],
        ts: "2026-01-01T00:00:00.000Z",
        message: "m",
      },
      target,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe("[cost-guardian] journal write failed: " + expected + "\n");

    spy.mockRestore();
  });

  test("parent path blocked by a file", () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "i am a file");
    const brokenPath = join(blocker, "sub", "journal.jsonl");

    let expected = "";
    try {
      mkdirSync(dirname(brokenPath), { recursive: true });
    } catch (e) {
      expected = (e as Error).message;
    }
    expect(expected.length).toBeGreaterThan(0);

    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
    appendCostJournal(
      {
        kind: "action" as CostJournalActionEntry["kind"],
        ts: "2026-01-01T00:00:00.000Z",
        action: "deregister-refused" as const,
        ok: false,
      },
      brokenPath,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe("[cost-guardian] journal write failed: " + expected + "\n");
    expect(readFileSync(blocker, "utf8")).toBe("i am a file");
    expect(existsSync(brokenPath)).toBe(false);

    spy.mockRestore();
  });
});
