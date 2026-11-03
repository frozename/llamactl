import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendCliJournal,
  type CliJournalEntry,
  cliJournalPathFor,
  defaultCliJournalDir,
} from "../src/cli/journal.js";
import { mkdtempSync, readFileSync, rmSync } from "../src/safe-fs.js";

let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cli-journal-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("defaultCliJournalDir", () => {
  test("LLAMACTL_CLI_JOURNAL_DIR override returns the value", () => {
    expect(defaultCliJournalDir({ LLAMACTL_CLI_JOURNAL_DIR: "/j" })).toBe("/j");
  });

  test("whitespace-padded override is trimmed", () => {
    expect(defaultCliJournalDir({ LLAMACTL_CLI_JOURNAL_DIR: "  /j  " })).toBe("/j");
  });

  test("whitespace-only override falls back to DEV_STORAGE", () => {
    expect(
      defaultCliJournalDir({ LLAMACTL_CLI_JOURNAL_DIR: "   ", DEV_STORAGE: "/dev-root" }),
    ).toBe(join("/dev-root", "cli-journal"));
  });

  test("empty env uses homedir/.llamactl/cli-journal", () => {
    expect(defaultCliJournalDir({})).toBe(join(homedir(), ".llamactl", "cli-journal"));
  });
});

describe("cliJournalPathFor", () => {
  test("uses UTC ISO date from the timestamp", () => {
    // 23:30 at -05:00 is 04:30 UTC the next day, so the file is dated 2026-03-05.
    const ts = new Date("2026-03-04T23:30:00-05:00");
    expect(cliJournalPathFor(ts, { LLAMACTL_CLI_JOURNAL_DIR: "/j" })).toBe(
      join("/j", "2026-03-05.jsonl"),
    );
  });
});

describe("appendCliJournal", () => {
  test("creates nested journal dir that does not yet exist", async () => {
    const nested = join(tmp, "a", "b");
    const ts = "2020-01-02T03:04:05.000Z";

    const entry: CliJournalEntry = {
      ts,
      agent: "mac-mini",
      binding_name: "claude-pro",
      preset: "claude",
      prompt_bytes: 42,
      response_bytes: 100,
      latency_ms: 500,
      ok: true,
    };

    const env = { LLAMACTL_CLI_JOURNAL_DIR: nested };

    // First append creates the missing nested dir and the day file.
    await appendCliJournal(entry, env);
    const dayFile = join(nested, "2020-01-02.jsonl");
    expect(readFileSync(dayFile, "utf8")).toBe(`${JSON.stringify(entry)}\n`);

    // Second append adds a line rather than overwriting.
    await appendCliJournal(entry, env);
    const content = readFileSync(dayFile, "utf8");
    expect(content.endsWith("\n")).toBe(true);

    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);

    for (const line of lines) {
      expect(JSON.parse(line)).toEqual(entry);
    }
  });

  test("write failure is swallowed, not thrown", async () => {
    const entry: CliJournalEntry = {
      ts: "2020-01-02T03:04:05.000Z",
      agent: "mac-mini",
      binding_name: "test",
      preset: "custom",
      prompt_bytes: 10,
      response_bytes: 20,
      latency_ms: 100,
      ok: true,
    };

    // A regular file where the journal dir's parent should be makes mkdir fail.
    const fileInTmp = join(tmp, "isafile");
    await Bun.write(fileInTmp, "data");

    let stderrCall: string | undefined;
    const spy = spyOn(process.stderr, "write").mockImplementation((msg: string) => {
      stderrCall = msg;
      return true;
    });

    try {
      // Resolving at all (rather than rejecting) is the contract under test.
      await appendCliJournal(entry, { LLAMACTL_CLI_JOURNAL_DIR: join(fileInTmp, "sub") });
      expect(stderrCall).toMatch(/^cli-journal: append failed/);
    } finally {
      spy.mockRestore();
    }
  });
});
