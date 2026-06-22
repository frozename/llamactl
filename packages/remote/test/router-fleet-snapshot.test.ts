import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { router } from "../src/router.js";
import { handleFleetSnapshotRoute } from "../src/routes/fleet.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

let dir = "";
let journalPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llamactl-router-fleet-"));
  journalPath = join(dir, "journal.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function snapshotFixture(ts: string, freeMb: number): Record<string, unknown> {
  return {
    kind: "fleet-snapshot",
    ts,
    node: "node-a",
    node_mem: {
      free_mb: freeMb,
      active_mb: 1000,
      inactive_mb: 200,
      wired_mb: 300,
      compressor_mb: 40,
      swap_in: 0,
      swap_out: 0,
    },
    workloads: [
      {
        name: "ranker",
        kind: "ModelRun",
        endpoint: "http://127.0.0.1:8081",
        priority: 45,
        placement: "movable",
        rss_mb: 1500,
        request_rate_5m: 2,
        error_rate_5m: 0,
        p50_ms: 120,
        p95_ms: 250,
        models: ["qwen"],
        reachable: true,
        consecutiveErrors: 0,
        revision: "boot-1",
      },
    ],
  };
}

async function callFleetSnapshot(ctx: { fleetJournalPath?: string }): Promise<unknown> {
  const caller = router.createCaller(ctx) as unknown as {
    fleetSnapshot: () => Promise<unknown>;
  };
  try {
    return await caller.fleetSnapshot();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

describe("fleetSnapshot router query", () => {
  test("returns byte-identical JSON to GET /v1/fleet/snapshot for the same journal", async () => {
    const older = snapshotFixture("2026-06-22T12:34:56.000Z", 1000);
    const latest = snapshotFixture("2026-06-22T12:35:56.000Z", 4096);
    writeFileSync(
      journalPath,
      [
        JSON.stringify(older),
        JSON.stringify({ kind: "fleet-heartbeat", ts: "2026-06-22T12:35:00.000Z", node: "node-a" }),
        JSON.stringify(latest),
      ].join("\n") + "\n",
      "utf8",
    );

    const routeRes = handleFleetSnapshotRoute(new Request("http://agent/v1/fleet/snapshot"), {
      journalPath,
    });
    expect(routeRes.status).toBe(200);
    const routeJson = (await routeRes.json()) as unknown;
    const queryJson = await callFleetSnapshot({ fleetJournalPath: journalPath });

    expect(JSON.stringify(queryJson)).toBe(JSON.stringify(routeJson));
  });

  test("returns null when the journal has no fleet snapshot", async () => {
    writeFileSync(
      journalPath,
      `${JSON.stringify({ kind: "fleet-heartbeat", ts: "2026-06-22T12:35:00.000Z", node: "node-a" })}\n`,
      "utf8",
    );

    const queryJson = await callFleetSnapshot({ fleetJournalPath: journalPath });

    expect(queryJson).toBeNull();
  });
});
