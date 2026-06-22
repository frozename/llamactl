import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { handleFleetSnapshotRoute } from "../src/routes/fleet.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { type RunningAgent, startAgentServer } from "../src/server/serve.js";

/**
 * Regression guard for the DEV_STORAGE-dependent fleet-snapshot bug.
 *
 * `GET /v1/fleet/snapshot` (routes/fleet.ts) reads
 * `opts.journalPath ?? defaultFleetJournalPath()`. serve.ts used to
 * dispatch it with NO opts, so the route ALWAYS resolved
 * `defaultFleetJournalPath()` in the AGENT process env — when the
 * agent and supervisor processes have different `$DEV_STORAGE`, the
 * agent served a stale journal the supervisor never wrote to.
 *
 * The fix threads `StartAgentOptions.fleetJournalPath` into the
 * dispatch so an operator can point `agent serve` at the same journal
 * the supervisor writes. These tests pin:
 *   1. the bug shape — the route resolving the default ($DEV_STORAGE)
 *      path when called with no opts (RED today);
 *   2. the fix — a threaded `fleetJournalPath` makes the live server
 *      serve the configured journal, NOT the default (GREEN).
 */

const CONFIGURED_TS = "2026-06-21T12:00:00Z";
const DEFAULT_TS = "2026-06-08T00:00:00Z";

function snapshotLine(ts: string, freeMb: number): string {
  return JSON.stringify({
    kind: "fleet-snapshot",
    ts,
    node: "local",
    node_mem: {
      free_mb: freeMb,
      active_mb: 0,
      inactive_mb: 0,
      wired_mb: 0,
      compressor_mb: 0,
      swap_in: 0,
      swap_out: 0,
    },
    workloads: [],
  });
}

interface SnapshotBody {
  kind: string;
  ts: string;
  node_mem: { free_mb: number };
}

describe("fleet-snapshot journal threading", () => {
  let dir = "";
  let configuredJournal = "";
  let defaultStorageRoot = "";
  let defaultJournal = "";
  let priorDevStorage: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet-snapshot-journal-"));
    // The journal an operator would point `agent serve` at — the one
    // the supervisor actually writes. free_mb=7777 is the tell.
    configuredJournal = join(dir, "configured", "journal.jsonl");
    mkdirSync(dirname(configuredJournal), { recursive: true });
    writeFileSync(configuredJournal, snapshotLine(CONFIGURED_TS, 7777) + "\n", "utf8");

    // A poisoned default: point $DEV_STORAGE at a SEPARATE root whose
    // fleet-supervisor/journal.jsonl carries a DIFFERENT (stale)
    // snapshot. This is the file `defaultFleetJournalPath()` resolves.
    defaultStorageRoot = join(dir, "dev-storage");
    defaultJournal = join(defaultStorageRoot, "fleet-supervisor", "journal.jsonl");
    mkdirSync(dirname(defaultJournal), { recursive: true });
    writeFileSync(defaultJournal, snapshotLine(DEFAULT_TS, 1111) + "\n", "utf8");

    priorDevStorage = process.env["DEV_STORAGE"];
    process.env["DEV_STORAGE"] = defaultStorageRoot;
  });

  afterEach(() => {
    if (priorDevStorage === undefined) delete process.env["DEV_STORAGE"];
    else process.env["DEV_STORAGE"] = priorDevStorage;
    rmSync(dir, { recursive: true, force: true });
  });

  test("RED proof: route called as serve.ts did (no opts) serves the default-path snapshot, not the configured one", async () => {
    // This reproduces the pre-fix serve.ts dispatch verbatim:
    // `handleFleetSnapshotRoute(req)` with no second argument. With
    // $DEV_STORAGE poisoned, the route resolves the default journal —
    // proving an operator had no way to make it serve the supervisor's
    // journal. This documents the bug; the configured snapshot is
    // never reachable on this code path.
    const res = handleFleetSnapshotRoute(new Request("http://agent/v1/fleet/snapshot"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SnapshotBody;
    expect(body.ts).toBe(DEFAULT_TS);
    expect(body.node_mem.free_mb).toBe(1111);
  });

  test("GREEN: a threaded fleetJournalPath makes the live server serve the configured journal, not the $DEV_STORAGE default", async () => {
    let agent: RunningAgent | undefined;
    try {
      agent = startAgentServer({
        bindHost: "127.0.0.1",
        port: 0,
        // noAuth is gate-permitted on 127.0.0.1 — keeps the fetch simple.
        noAuth: true,
        tokenHash: "unused-when-noauth",
        // The bug fix: thread the supervisor's journal explicitly.
        fleetJournalPath: configuredJournal,
        advertiseMdns: false,
      });
      const res = await fetch(`${agent.url}/v1/fleet/snapshot`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as SnapshotBody;
      // The configured journal wins — NOT the $DEV_STORAGE default.
      expect(body.ts).toBe(CONFIGURED_TS);
      expect(body.node_mem.free_mb).toBe(7777);
    } finally {
      if (agent) await agent.stop().catch(() => undefined);
    }
  });

  test("absent fleetJournalPath preserves current behavior: the live server falls back to the $DEV_STORAGE default journal", async () => {
    let agent: RunningAgent | undefined;
    try {
      agent = startAgentServer({
        bindHost: "127.0.0.1",
        port: 0,
        noAuth: true,
        tokenHash: "unused-when-noauth",
        // No fleetJournalPath — byte-preserved default-resolution path.
        advertiseMdns: false,
      });
      const res = await fetch(`${agent.url}/v1/fleet/snapshot`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as SnapshotBody;
      expect(body.ts).toBe(DEFAULT_TS);
      expect(body.node_mem.free_mb).toBe(1111);
    } finally {
      if (agent) await agent.stop().catch(() => undefined);
    }
  });
});
