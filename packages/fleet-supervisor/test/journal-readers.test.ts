import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultFleetAuditPath,
  defaultFleetJournalPath,
  readCurrentLeaseHolder,
  readRecentMovesFromJournal,
} from "../src/journal.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

describe("defaultFleetJournalPath", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env["DEV_STORAGE"];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env["DEV_STORAGE"];
    } else {
      process.env["DEV_STORAGE"] = saved;
    }
  });

  it("respects DEV_STORAGE when set", () => {
    process.env["DEV_STORAGE"] = "/x/dev";
    expect(defaultFleetJournalPath()).toBe("/x/dev/fleet-supervisor/journal.jsonl");
  });

  it("falls back to homedir when DEV_STORAGE is unset", () => {
    delete process.env["DEV_STORAGE"];
    expect(defaultFleetJournalPath()).toBe(`${homedir()}/.llamactl/fleet-supervisor/journal.jsonl`);
  });
});

describe("defaultFleetAuditPath", () => {
  let savedFleet: string | undefined;
  let savedDev: string | undefined;

  beforeEach(() => {
    savedFleet = process.env["LLAMACTL_FLEET_DIR"];
    savedDev = process.env["DEV_STORAGE"];
  });

  afterEach(() => {
    if (savedFleet === undefined) {
      delete process.env["LLAMACTL_FLEET_DIR"];
    } else {
      process.env["LLAMACTL_FLEET_DIR"] = savedFleet;
    }
    if (savedDev === undefined) {
      delete process.env["DEV_STORAGE"];
    } else {
      process.env["DEV_STORAGE"] = savedDev;
    }
  });

  it("respects LLAMACTL_FLEET_DIR when set", () => {
    process.env["LLAMACTL_FLEET_DIR"] = "/x/fleet";
    expect(defaultFleetAuditPath()).toBe("/x/fleet/audit.jsonl");
  });

  it("falls back to homedir when LLAMACTL_FLEET_DIR is unset", () => {
    delete process.env["LLAMACTL_FLEET_DIR"];
    expect(defaultFleetAuditPath()).toBe(`${homedir()}/.llamactl/fleet-supervisor/audit.jsonl`);
  });

  it("DEV_STORAGE does not affect audit path", () => {
    process.env["DEV_STORAGE"] = "/x/dev";
    delete process.env["LLAMACTL_FLEET_DIR"];
    expect(defaultFleetAuditPath()).toBe(`${homedir()}/.llamactl/fleet-supervisor/audit.jsonl`);
  });
});

describe("readCurrentLeaseHolder", () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the file does not exist", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-lease-test-"));
    const path = join(dir, "journal.jsonl");
    expect(readCurrentLeaseHolder(path)).toBeNull();
  });

  it("picks the row with the greatest ts, not the last row", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-lease-test-"));
    const path = join(dir, "journal.jsonl");
    const lateTs = "2026-06-01T00:00:02.000Z";
    const earlyTs = "2026-06-01T00:00:01.000Z";

    writeFileSync(
      path,
      [
        JSON.stringify({
          kind: "fleet-lease-election",
          ts: lateTs,
          holder: "node-late",
        }),
        JSON.stringify({
          kind: "fleet-lease-election",
          ts: earlyTs,
          holder: "node-early",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    expect(readCurrentLeaseHolder(path)).toBe("node-late");
  });

  it("equal ts keeps the first row seen (strict >)", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-lease-test-"));
    const path = join(dir, "journal.jsonl");
    const sameTs = "2026-06-01T00:00:00.000Z";

    writeFileSync(
      path,
      [
        JSON.stringify({
          kind: "fleet-lease-election",
          ts: sameTs,
          holder: "first-seen",
        }),
        JSON.stringify({
          kind: "fleet-lease-election",
          ts: sameTs,
          holder: "second-seen",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    expect(readCurrentLeaseHolder(path)).toBe("first-seen");
  });

  it("skips blank lines, non-JSON garbage, other kinds, non-string holders, and missing ts", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-lease-test-"));
    const path = join(dir, "journal.jsonl");

    const validTs = "2026-06-01T00:00:01.000Z";
    const laterTs = "2026-06-01T00:00:05.000Z";

    writeFileSync(
      path,
      [
        "",
        "not json at all",
        JSON.stringify({
          kind: "fleet-snapshot",
          ts: laterTs,
          holder: "snapshot-holder",
        }),
        JSON.stringify({
          kind: "fleet-lease-election",
          ts: laterTs,
          holder: 42,
        }),
        JSON.stringify({
          kind: "fleet-lease-election",
          holder: "no-ts-holder",
        }),
        JSON.stringify({
          kind: "fleet-lease-election",
          ts: validTs,
          holder: "valid-holder",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    expect(readCurrentLeaseHolder(path)).toBe("valid-holder");
  });

  it("returns null when all rows are invalid", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-lease-test-"));
    const path = join(dir, "journal.jsonl");

    writeFileSync(
      path,
      [
        JSON.stringify({
          kind: "fleet-snapshot",
          ts: "2026-06-01T00:00:05.000Z",
          holder: "snapshot-holder",
        }),
        JSON.stringify({
          kind: "fleet-lease-election",
          ts: "2026-06-01T00:00:06.000Z",
          holder: 42,
        }),
        JSON.stringify({
          kind: "fleet-lease-election",
          holder: "no-ts-holder",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    expect(readCurrentLeaseHolder(path)).toBeNull();
  });
});

describe("readRecentMovesFromJournal", () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns [] when the file does not exist", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-moves-test-"));
    const path = join(dir, "journal.jsonl");
    expect(readRecentMovesFromJournal(path)).toEqual([]);
  });

  it("accepts a legacy fleet-move row with string workload", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-moves-test-"));
    const path = join(dir, "journal.jsonl");
    const ts = "2026-06-01T00:00:00.000Z";

    writeFileSync(
      path,
      JSON.stringify({
        kind: "fleet-move",
        workload: "w-legacy",
        ts,
      }) + "\n",
      "utf8",
    );

    const moves = readRecentMovesFromJournal(path);
    expect(moves).toHaveLength(1);
    const sorted = [...moves].sort((a, b) => a.workload.localeCompare(b.workload));
    expect(sorted[0]!.workload).toBe("w-legacy");
    expect(sorted[0]!.movedAtMs).toBe(Date.parse(ts));
  });

  it("ignores fleet-move rows whose workload is not a string", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-moves-test-"));
    const path = join(dir, "journal.jsonl");
    const ts = "2026-06-01T00:00:00.000Z";

    writeFileSync(
      path,
      JSON.stringify({
        kind: "fleet-move",
        workload: 123,
        ts,
      }) + "\n",
      "utf8",
    );

    expect(readRecentMovesFromJournal(path)).toEqual([]);
  });

  it("ignores fleet-proposal rows whose action.type is not 'move'", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-moves-test-"));
    const path = join(dir, "journal.jsonl");
    const ts = "2026-06-01T00:00:00.000Z";

    writeFileSync(
      path,
      JSON.stringify({
        kind: "fleet-proposal",
        ts,
        node: "local",
        action: { type: "evict" },
        transition: { subject: "w1" },
      }) + "\n",
      "utf8",
    );

    expect(readRecentMovesFromJournal(path)).toEqual([]);
  });

  it("ignores move proposals whose transition.subject is not a string", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-moves-test-"));
    const path = join(dir, "journal.jsonl");
    const ts = "2026-06-01T00:00:00.000Z";

    writeFileSync(
      path,
      JSON.stringify({
        kind: "fleet-proposal",
        ts,
        node: "local",
        action: { type: "move", workload: "w1" },
        transition: { subject: 42 },
      }) + "\n",
      "utf8",
    );

    expect(readRecentMovesFromJournal(path)).toEqual([]);
  });

  it("ignores rows whose ts is missing", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-moves-test-"));
    const path = join(dir, "journal.jsonl");

    writeFileSync(
      path,
      JSON.stringify({
        kind: "fleet-move",
        workload: "w-no-ts",
      }) + "\n",
      "utf8",
    );

    expect(readRecentMovesFromJournal(path)).toEqual([]);
  });

  it("ignores fleet-move rows whose ts is a number", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-moves-test-"));
    const path = join(dir, "journal.jsonl");

    writeFileSync(
      path,
      JSON.stringify({
        kind: "fleet-move",
        workload: "w",
        ts: 12345,
      }) + "\n",
      "utf8",
    );

    expect(readRecentMovesFromJournal(path)).toEqual([]);
  });

  it("ignores rows whose ts does not parse as a date", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-moves-test-"));
    const path = join(dir, "journal.jsonl");

    writeFileSync(
      path,
      JSON.stringify({
        kind: "fleet-move",
        workload: "w-bad-ts",
        ts: "not-a-date",
      }) + "\n",
      "utf8",
    );

    expect(readRecentMovesFromJournal(path)).toEqual([]);
  });

  it("keeps the per-workload maximum movedAtMs even when a later file row has an earlier timestamp", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-moves-test-"));
    const path = join(dir, "journal.jsonl");
    const earlyTs = "2026-06-01T00:00:00.000Z";
    const lateTs = "2026-06-01T00:00:10.000Z";

    // Late timestamp first, early second: a "last row wins" reader would
    // incorrectly settle on the early timestamp.
    writeFileSync(
      path,
      [
        JSON.stringify({
          kind: "fleet-proposal",
          ts: lateTs,
          node: "local",
          action: { type: "move", workload: "w-early" },
          transition: { subject: "w-early" },
        }),
        JSON.stringify({
          kind: "fleet-move",
          workload: "w-early",
          ts: earlyTs,
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const moves = readRecentMovesFromJournal(path);
    expect(moves).toHaveLength(1);
    expect(moves[0]!.workload).toBe("w-early");
    expect(moves[0]!.movedAtMs).toBe(Date.parse(lateTs));
  });

  it("returns one entry per distinct workload with mixed fleet-move and fleet-proposal move rows", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-moves-test-"));
    const path = join(dir, "journal.jsonl");
    const ts1 = "2026-06-01T00:00:01.000Z";
    const ts2 = "2026-06-01T00:00:02.000Z";

    writeFileSync(
      path,
      [
        JSON.stringify({
          kind: "fleet-move",
          workload: "w-a",
          ts: ts1,
        }),
        JSON.stringify({
          kind: "fleet-proposal",
          ts: ts2,
          node: "local",
          action: { type: "move", workload: "w-b" },
          transition: { subject: "w-b" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const moves = readRecentMovesFromJournal(path);
    expect(moves).toHaveLength(2);
    expect(moves).toContainEqual({ workload: "w-a", movedAtMs: Date.parse(ts1) });
    expect(moves).toContainEqual({ workload: "w-b", movedAtMs: Date.parse(ts2) });
  });

  it("ignores malformed JSON and blank lines", () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-moves-test-"));
    const path = join(dir, "journal.jsonl");
    const ts = "2026-06-01T00:00:00.000Z";

    writeFileSync(
      path,
      [
        "",
        "{bad json",
        JSON.stringify({
          kind: "fleet-move",
          workload: "w-valid",
          ts,
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const moves = readRecentMovesFromJournal(path);
    expect(moves).toHaveLength(1);
    const sorted = [...moves].sort((a, b) => a.workload.localeCompare(b.workload));
    expect(sorted[0]!.workload).toBe("w-valid");
    expect(sorted[0]!.movedAtMs).toBe(Date.parse(ts));
  });
});
