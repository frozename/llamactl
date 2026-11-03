import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { appendHealerJournal, defaultHealerJournalPath, type JournalEntry } from "../src/index.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "../src/safe-fs.js";

/**
 * defaultHealerJournalPath is pinned with explicit env objects (never
 * process.env) so the precedence rules — trimmed override > trimmed
 * DEV_STORAGE > homedir default — hold regardless of the host's real
 * environment. appendHealerJournal is pinned against a temp dir.
 */

describe("defaultHealerJournalPath", () => {
  test("LLAMACTL_HEALER_JOURNAL override is used verbatim", () => {
    expect(defaultHealerJournalPath({ LLAMACTL_HEALER_JOURNAL: "/x/j.jsonl" })).toBe("/x/j.jsonl");
  });

  test("override is trimmed", () => {
    expect(defaultHealerJournalPath({ LLAMACTL_HEALER_JOURNAL: "  /x/j.jsonl  " })).toBe(
      "/x/j.jsonl",
    );
  });

  test("whitespace-only override falls through to DEV_STORAGE", () => {
    expect(
      defaultHealerJournalPath({ LLAMACTL_HEALER_JOURNAL: "   ", DEV_STORAGE: "/dev/store" }),
    ).toBe(join("/dev/store", "healer", "journal.jsonl"));
  });

  test("DEV_STORAGE is trimmed", () => {
    expect(defaultHealerJournalPath({ DEV_STORAGE: " /dev/store " })).toBe(
      join("/dev/store", "healer", "journal.jsonl"),
    );
  });

  test("whitespace-only DEV_STORAGE falls through to the homedir default", () => {
    expect(defaultHealerJournalPath({ DEV_STORAGE: "  " })).toBe(
      join(homedir(), ".llamactl", "healer", "journal.jsonl"),
    );
  });

  test("empty env yields the homedir default", () => {
    expect(defaultHealerJournalPath({})).toBe(
      join(homedir(), ".llamactl", "healer", "journal.jsonl"),
    );
  });

  test("override wins over DEV_STORAGE", () => {
    expect(
      defaultHealerJournalPath({ LLAMACTL_HEALER_JOURNAL: "/x/j.jsonl", DEV_STORAGE: "/dev" }),
    ).toBe("/x/j.jsonl");
  });
});

describe("appendHealerJournal", () => {
  let tmp = "";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "llamactl-healer-journal-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("creates missing parent directories", () => {
    const path = join(tmp, "a", "b", "journal.jsonl");
    appendHealerJournal({ kind: "error", ts: "t1", message: "m1" }, path);
    expect(existsSync(dirname(path))).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  test("writes one newline-terminated JSON line per entry, in order", () => {
    const path = join(tmp, "journal.jsonl");
    const first: JournalEntry = { kind: "error", ts: "t1", message: "m1" };
    const second: JournalEntry = {
      kind: "tick",
      ts: "t2",
      report: { ts: "t2", probes: [], unhealthy: 0 },
      source: "direct",
    };
    appendHealerJournal(first, path);
    appendHealerJournal(second, path);

    const lines = readFileSync(path, "utf8").split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines).toHaveLength(3);
    const parsed = lines.slice(0, 2).map((line) => JSON.parse(line) as JournalEntry);
    expect(parsed[0]).toEqual(first);
    expect(parsed[1]).toEqual(second);
  });

  test("a third append preserves the earlier lines", () => {
    const path = join(tmp, "journal.jsonl");
    const first: JournalEntry = { kind: "error", ts: "t1", message: "m1" };
    const second: JournalEntry = { kind: "error", ts: "t2", message: "m2" };
    const third: JournalEntry = { kind: "error", ts: "t3", message: "m3" };
    appendHealerJournal(first, path);
    appendHealerJournal(second, path);
    appendHealerJournal(third, path);

    const parsed = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as JournalEntry);
    expect(parsed).toEqual([first, second, third]);
  });
});
