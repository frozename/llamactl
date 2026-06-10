import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { FleetJournalEntry } from "../src/types.js";

import { runFleet } from "../../cli/src/commands/fleet.js";
import { collectLatestSnapshots, collectProposals } from "../../mcp/src/tools/fleet.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fleet-schema-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJournal(lines: unknown[]): string {
  const path = join(dir, "journal.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
  return path;
}

describe("journal schema forward-compat", () => {
  test("fleet_snapshot MCP tool tolerates fleet-placement entry", () => {
    const entries = [
      { kind: "fleet-placement", ts: "2026-05-25T17:00:00Z", node: "local", decision: {} },
      {
        kind: "fleet-snapshot",
        ts: "2026-05-25T17:01:00Z",
        node: "local",
        node_mem: {
          free_mb: 1234,
          active_mb: 0,
          inactive_mb: 0,
          wired_mb: 0,
          compressor_mb: 10,
          swap_in: 0,
          swap_out: 0,
        },
        workloads: [],
      },
    ];
    const snapshots = collectLatestSnapshots(entries as unknown as FleetJournalEntry[]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.node).toBe("local");
  });

  test("fleet_proposals MCP tool tolerates fleet-placement entries", () => {
    const entries = [
      { kind: "fleet-placement", ts: "2026-05-25T17:00:00Z", node: "local", decision: {} },
      {
        kind: "fleet-proposal",
        ts: "2026-05-25T17:01:00Z",
        node: "local",
        proposalId: "p1",
        transition: {
          subject: "local",
          subjectKind: "node",
          signal: "pressure",
          from: "NORMAL",
          to: "HIGH",
        },
        action: { type: "evict", workload: "w1", reason: "test" },
      },
    ];
    const proposals = collectProposals(entries as unknown as FleetJournalEntry[], {
      pendingOnly: false,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.proposalId).toBe("p1");
  });

  test("journal-tail CLI renders valid lines when unknown entry type is present", async () => {
    const journalPath = writeJournal([
      { kind: "fleet-placement", ts: "2026-05-25T17:00:00Z", node: "local", foo: "bar" },
      { kind: "fleet-heartbeat", ts: "2026-05-25T17:00:30Z", node: "local" },
    ]);

    // journal-tail writes via process.stdout.write (no-console rule), so the
    // capture must wrap stdout rather than console.log.
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    try {
      const code = await runFleet(["journal-tail", "--journal", journalPath]);
      expect(code).toBe(0);
      const out = lines.join("");
      expect(out).toContain("fleet-placement");
      expect(out).toContain("fleet-heartbeat");
    } finally {
      process.stdout.write = orig;
    }
  });
});
