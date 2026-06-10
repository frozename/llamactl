import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleFleetSnapshotRoute } from "../../remote/src/routes/fleet.js";

let dir = "";
let journalPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fleet-route-test-"));
  journalPath = join(dir, "journal.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /v1/fleet/snapshot", () => {
  test("returns the latest fleet-snapshot entry from journal, status 200", async () => {
    writeFileSync(
      journalPath,
      [
        JSON.stringify({
          kind: "fleet-snapshot",
          ts: "2026-05-25T17:00:00Z",
          node: "local",
          node_mem: {
            free_mb: 1000,
            active_mb: 0,
            inactive_mb: 0,
            wired_mb: 0,
            compressor_mb: 100,
            swap_in: 0,
            swap_out: 0,
          },
          workloads: [],
        }),
        JSON.stringify({ kind: "fleet-heartbeat", ts: "2026-05-25T17:00:15Z", node: "local" }),
        JSON.stringify({
          kind: "fleet-snapshot",
          ts: "2026-05-25T17:01:00Z",
          node: "local",
          node_mem: {
            free_mb: 2000,
            active_mb: 0,
            inactive_mb: 0,
            wired_mb: 0,
            compressor_mb: 120,
            swap_in: 0,
            swap_out: 0,
          },
          workloads: [],
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const res = await handleFleetSnapshotRoute(new Request("http://agent/v1/fleet/snapshot"), {
      journalPath,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; ts: string; node_mem: { free_mb: number } };
    expect(body.kind).toBe("fleet-snapshot");
    expect(body.ts).toBe("2026-05-25T17:01:00Z");
    expect(body.node_mem.free_mb).toBe(2000);
  });

  test("returns 204 when no fleet-snapshot in journal", async () => {
    writeFileSync(
      journalPath,
      [JSON.stringify({ kind: "fleet-heartbeat", ts: "2026-05-25T17:00:15Z", node: "local" })].join(
        "\n",
      ) + "\n",
      "utf8",
    );

    const res = await handleFleetSnapshotRoute(new Request("http://agent/v1/fleet/snapshot"), {
      journalPath,
    });

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });
});
