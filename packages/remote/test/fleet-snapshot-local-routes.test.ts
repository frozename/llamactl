import type { LocalRoute } from "@llamactl/core/workloadRuntime";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildLocalRoutesSnapshot,
  type FleetSnapshotRouteOptions,
  handleFleetSnapshotRoute,
} from "../src/routes/fleet.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const WITH_PARAM = "http://agent/v1/fleet/snapshot?include=local-routes";
const WITHOUT_PARAM = "http://agent/v1/fleet/snapshot";

function route(over: Partial<LocalRoute> & Pick<LocalRoute, "model" | "workload">): LocalRoute {
  return {
    host: "127.0.0.1",
    port: 8080,
    engine: "omlx",
    kind: "ModelHost",
    pid: 4242,
    ...over,
  };
}

function snapshotLine(ts: string): string {
  return JSON.stringify({
    kind: "fleet-snapshot",
    ts,
    node: "local",
    node_mem: {
      free_mb: 4096,
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

const TWO_ALIASES: LocalRoute[] = [
  route({ workload: "w1", model: "alias-a" }),
  route({ workload: "w1", model: "alias-b" }),
];

describe("GET /v1/fleet/snapshot include=local-routes fallback (#306)", () => {
  let dir = "";
  let missingJournal = "";
  let routeCalls = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet-snapshot-local-routes-"));
    missingJournal = join(dir, "absent", "journal.jsonl");
    routeCalls = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function opts(routes: LocalRoute[], journalPath?: string): FleetSnapshotRouteOptions {
    return {
      journalPath: journalPath ?? missingJournal,
      localRoutes: (): LocalRoute[] => {
        routeCalls += 1;
        return routes;
      },
      revisionOf: (name: string): string | null => (name === "w1" ? "rev-1" : null),
      now: (): Date => NOW,
    };
  }

  test("with include=local-routes and no journal entry, serves the node's local routes", async () => {
    const res = handleFleetSnapshotRoute(new Request(WITH_PARAM), opts(TWO_ALIASES));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      kind: "local-routes",
      ts: "2026-10-27T12:00:00.000Z",
      workloads: [
        {
          name: "w1",
          models: ["alias-a", "alias-b"],
          endpoint: "http://127.0.0.1:8080",
          reachable: true,
          revision: "rev-1",
        },
      ],
    });
    expect("node_mem" in body).toBe(false);
  });

  test("without the parameter, no journal entry still answers 204 and never lists routes", () => {
    const res = handleFleetSnapshotRoute(new Request(WITHOUT_PARAM), opts(TWO_ALIASES));
    expect(res.status).toBe(204);
    expect(routeCalls).toBe(0);
  });

  test("with the parameter and no local routes, answers 204", () => {
    const res = handleFleetSnapshotRoute(new Request(WITH_PARAM), opts([]));
    expect(res.status).toBe(204);
    expect(routeCalls).toBe(1);
  });

  test("with the parameter and a journal entry, returns the journal entry unchanged", async () => {
    const journal = join(dir, "journal.jsonl");
    writeFileSync(journal, snapshotLine("2026-10-27T11:00:00Z") + "\n", "utf8");
    const plain = handleFleetSnapshotRoute(new Request(WITHOUT_PARAM), opts(TWO_ALIASES, journal));
    const asked = handleFleetSnapshotRoute(new Request(WITH_PARAM), opts(TWO_ALIASES, journal));
    expect(plain.status).toBe(200);
    expect(asked.status).toBe(200);
    const plainBody = (await plain.json()) as Record<string, unknown>;
    const askedBody = (await asked.json()) as Record<string, unknown>;
    expect(askedBody).toEqual(plainBody);
    expect(askedBody["kind"]).toBe("fleet-snapshot");
    expect(routeCalls).toBe(0);
  });

  test("a failing route source falls back to 204", () => {
    const failing: FleetSnapshotRouteOptions = {
      journalPath: missingJournal,
      localRoutes: (): LocalRoute[] => {
        throw new Error("ps failed");
      },
    };
    const res = handleFleetSnapshotRoute(new Request(WITH_PARAM), failing);
    expect(res.status).toBe(204);
  });

  test("buildLocalRoutesSnapshot groups by workload, dedups models and brackets IPv6 hosts", () => {
    const snap = buildLocalRoutesSnapshot(
      [
        route({ workload: "w1", model: "alias-a" }),
        route({
          workload: "w2",
          model: "qwen",
          host: "::1",
          port: 8081,
          engine: "llamacpp",
          kind: "ModelRun",
        }),
        route({ workload: "w1", model: "alias-a" }),
        route({ workload: "w2", model: "qwen-alias", host: "::1", port: 8081 }),
      ],
      (name: string): string | null => (name === "w1" ? "rev-1" : null),
      NOW,
    );
    expect(snap).toEqual({
      kind: "local-routes",
      ts: "2026-10-27T12:00:00.000Z",
      workloads: [
        {
          name: "w1",
          models: ["alias-a"],
          endpoint: "http://127.0.0.1:8080",
          reachable: true,
          revision: "rev-1",
        },
        {
          name: "w2",
          models: ["qwen", "qwen-alias"],
          endpoint: "http://[::1]:8081",
          reachable: true,
          revision: null,
        },
      ],
    });
    expect(buildLocalRoutesSnapshot([], (): string => "rev", NOW)).toBeNull();
  });
});
