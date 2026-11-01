import { afterEach, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExecutorOptions } from "../src/executor.js";
import type { FleetExecutionEntry, FleetJournalEntry, FleetProposalEntry } from "../src/types.js";

import { runExecutor } from "../src/executor.js";
import { MAX_JOURNAL_LINE_BYTES } from "../src/journal-reader.js";
import * as fs from "../src/safe-fs.js";

const directories: string[] = [];
const TS = "2026-10-31T00:00:00.000Z";
const NOW = Date.parse(TS);

function journal(rows: unknown[]): string {
  const directory = fs.mkdtempSync(join(tmpdir(), "executor-journal-"));
  directories.push(directory);
  const path = join(directory, "journal.jsonl");
  fs.writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n"));
  return path;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function proposal(proposalId = "p", node = "self"): FleetProposalEntry {
  return {
    kind: "fleet-proposal",
    ts: TS,
    node,
    proposalId,
    action: { type: "evict", workload: proposalId, reason: "test" },
    transition: {
      subject: proposalId,
      subjectKind: "workload",
      signal: "degraded",
      from: "healthy",
      to: "degraded",
    },
  };
}

function execution(overrides: Partial<FleetExecutionEntry> = {}): FleetExecutionEntry {
  return {
    kind: "fleet-execution",
    ts: TS,
    node: "other",
    proposalId: "p",
    action: proposal().action,
    status: "failed",
    attempt: 1,
    maxAttempts: 3,
    ...overrides,
  };
}

function options(
  path: string,
  overrides: Partial<ExecutorOptions> = {},
): { opts: ExecutorOptions; disabled: string[]; written: FleetJournalEntry[] } {
  const disabled: string[] = [];
  const written: FleetJournalEntry[] = [];
  const opts: ExecutorOptions = {
    node: "self",
    auto: true,
    severityThreshold: 3,
    journalPath: path,
    nowMs: NOW,
    writeJournal: (entry) => written.push(entry),
    disable: (workload) => {
      disabled.push(workload);
      return Promise.resolve(0);
    },
    enable: () => Promise.resolve(0),
    ...overrides,
  };
  return { opts, disabled, written };
}

test("default reader releases irrelevant decoded history before acting", async () => {
  const path = journal([
    ...Array.from({ length: 64 }, () => ({ kind: "fleet-snapshot", payload: "x".repeat(16384) })),
    { kind: "fleet-move", workload: "unused" },
    { kind: "fleet-lease-election", holder: "unused" },
    proposal(),
    proposal("second"),
  ]);
  const snapshots: WeakRef<object>[] = [];
  const retainedCounts: number[] = [];
  const parse = JSON.parse;
  const parser = spyOn(JSON, "parse").mockImplementation((text: string) => {
    const row = parse(text) as { kind?: string };
    if (row.kind === "fleet-snapshot") snapshots.push(new WeakRef(row));
    return row;
  });
  const { opts } = options(path, {
    disable: async () => {
      // Mock results and the creation job otherwise keep WeakRef targets alive.
      parser.mockClear();
      await Bun.sleep(0);
      Bun.gc(true);
      retainedCounts.push(snapshots.filter((reference) => reference.deref() !== undefined).length);
      return 0;
    },
  });
  try {
    expect(await runExecutor(opts)).toHaveLength(2);
    expect(snapshots).toHaveLength(64);
    expect(retainedCounts).toEqual([0, 0]);
  } finally {
    parser.mockRestore();
  }
});

test("default reader does not materialize the journal with readFileSync", async () => {
  const path = journal([proposal()]);
  const read = spyOn(fs, "readFileSync").mockImplementation(() => {
    throw new Error("whole-file journal read");
  });
  try {
    const { opts, disabled } = options(path);
    expect(await runExecutor(opts)).toHaveLength(1);
    expect(disabled).toEqual(["p"]);
  } finally {
    read.mockRestore();
  }
});

test("foreign-node terminal execution suppresses a local proposal", async () => {
  const { opts, disabled } = options(journal([execution({ status: "executed" }), proposal()]));
  expect(await runExecutor(opts)).toEqual([]);
  expect(disabled).toEqual([]);
});

test("legacy failed execution without attempt is terminal despite later failures", async () => {
  const legacy = execution();
  delete legacy.attempt;
  const { opts, disabled } = options(journal([legacy, proposal(), execution({ attempt: 2 })]));
  expect(await runExecutor(opts)).toEqual([]);
  expect(disabled).toEqual([]);
});

test("equal retry attempts preserve file order and highest attempt sets backoff", async () => {
  const { opts, disabled } = options(
    journal([
      proposal(),
      execution({ attempt: 2, nextAttemptAt: "2026-10-31T00:01:00Z" }),
      execution({ attempt: 2, nextAttemptAt: "2026-10-30T23:59:00Z" }),
      execution({ attempt: 1 }),
    ]),
  );
  expect(await runExecutor(opts)).toEqual([]);
  expect(disabled).toEqual([]);
});

test("duplicate proposal order is preserved and foreign proposals are not executed", async () => {
  const { opts, disabled } = options(
    journal([
      proposal("first"),
      proposal("foreign", "other"),
      proposal("second"),
      proposal("first"),
    ]),
  );
  expect((await runExecutor(opts)).map((entry) => entry.proposalId)).toEqual([
    "first",
    "second",
    "first",
  ]);
  expect(disabled).toEqual(["first", "second", "first"]);
});

test("manual override still journals skips for other proposals and expiry wins", async () => {
  const { opts, disabled } = options(
    journal([proposal(), proposal("other"), { ...proposal("expired"), expiresAt: TS }]),
    { auto: false, executeId: "p" },
  );
  const results = await runExecutor(opts);
  expect(results.map(({ proposalId, status, reason }) => ({ proposalId, status, reason }))).toEqual(
    [
      { proposalId: "p", status: "executed", reason: undefined },
      { proposalId: "other", status: "skipped", reason: "--auto not set" },
      { proposalId: "expired", status: "skipped", reason: "expired" },
    ],
  );
  expect(disabled).toEqual(["p"]);
});

test("injected reader remains authoritative and receives the original path", async () => {
  const path = journal([proposal("disk")]);
  const paths: string[] = [];
  const { opts, disabled } = options(path, {
    readJournal: (input) => {
      paths.push(input);
      return [proposal("injected")];
    },
  });
  expect(await runExecutor(opts)).toHaveLength(1);
  expect(paths).toEqual([path]);
  expect(disabled).toEqual(["injected"]);
});

for (const trailingNewline of [false, true]) {
  test(`oversized terminal row aborts before any effects (LF=${String(trailingNewline)})`, async () => {
    const path = journal([
      proposal("pending"),
      proposal(),
      execution({ status: "executed", reason: "x".repeat(MAX_JOURNAL_LINE_BYTES) }),
    ]);
    if (trailingNewline) fs.appendFileSync(path, "\n");
    const { opts, disabled, written } = options(path);
    const close = spyOn(fs, "closeSync");
    try {
      const result: unknown = await runExecutor(opts).catch((error: unknown) => error);
      expect(result).toEqual(new Error("Journal line exceeds 8388608 bytes"));
      expect(disabled).toEqual([]);
      expect(written).toEqual([]);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });
}
