import type { LocalRoute } from "@llamactl/core/workloadRuntime";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { router } from "../src/router.js";
import {
  buildLocalRoutesSnapshot,
  type FleetSnapshotRouteOptions,
  handleFleetSnapshotRoute,
} from "../src/routes/fleet.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { __peerSnapshotInternals } from "../src/server/peer-snapshot-poller.js";

const originalFetch = globalThis.fetch;
const TS = "2026-11-23T12:00:00.000Z";
const NOW = new Date(TS);
const WITH_PARAM = "http://agent/v1/fleet/snapshot?include=local-routes";
const WITHOUT_PARAM = "http://agent/v1/fleet/snapshot";
const QUALIFICATION = "llamactl.io/qualification";

const JOURNAL_SNAPSHOT = {
  kind: "fleet-snapshot",
  ts: TS,
  node: "node-a",
  node_mem: {
    free_mb: 4096,
    active_mb: 1000,
    inactive_mb: 200,
    wired_mb: 300,
    compressor_mb: 40,
    swap_in: 0,
    swap_out: 0,
  },
  workloads: [
    {
      name: "glm-host",
      kind: "ModelHost",
      endpoint: "http://127.0.0.1:8080",
      priority: 45,
      placement: "movable",
      rss_mb: 1500,
      request_rate_5m: 2,
      error_rate_5m: 0,
      p50_ms: 120,
      p95_ms: 250,
      models: ["glm-alias", "org/glm.gguf"],
      reachable: true,
      consecutiveErrors: 0,
      revision: "boot-1",
    },
    {
      name: "qwen-run",
      kind: "ModelRun",
      endpoint: "http://127.0.0.1:8081",
      priority: 60,
      placement: "pinned",
      rss_mb: 8000,
      request_rate_5m: 5,
      error_rate_5m: 0,
      p50_ms: 300,
      p95_ms: 900,
      models: ["qwen"],
      reachable: true,
      consecutiveErrors: 0,
      revision: "boot-2",
    },
  ],
} as const;

interface FleetSnapshotWorkloadBody {
  name: string;
  labels?: Record<string, string>;
}

interface FleetSnapshotBody {
  kind: string;
  workloads?: readonly FleetSnapshotWorkloadBody[];
}

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

function j1Routes(): LocalRoute[] {
  return [
    route({ workload: "glm-host", model: "glm-alias", qualificationStage: "experimental" }),
    route({ workload: "qwen-run", model: "qwen", port: 8081 }),
  ];
}

function workloadAt(body: FleetSnapshotBody, index: number): FleetSnapshotWorkloadBody {
  const workload = body.workloads?.[index];
  if (workload === undefined) throw new Error("expected a journal workload");
  return workload;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubPeerFetch(payload: unknown): void {
  globalThis.fetch = ((_input: Request | string | URL, _init?: RequestInit) =>
    Promise.resolve(jsonResponse(payload))) as typeof fetch;
}

async function callFleetSnapshot(
  ctx: { fleetJournalPath?: string; fleetLocalRoutes?: () => LocalRoute[] },
  input?: unknown,
): Promise<unknown> {
  const caller = router.createCaller(ctx) as unknown as {
    fleetSnapshot: (input?: unknown) => Promise<unknown>;
  };
  try {
    return await caller.fleetSnapshot(input);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

describe("journal fleet-snapshot experimental overlay (#518)", () => {
  let dir = "";
  let journalPath = "";
  let routeCalls = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet-snapshot-journal-qualification-"));
    journalPath = join(dir, "journal.jsonl");
    writeFileSync(journalPath, `${JSON.stringify(JOURNAL_SNAPSHOT)}\n`, "utf8");
    routeCalls = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  });

  function opts(routes: LocalRoute[]): FleetSnapshotRouteOptions {
    return {
      journalPath,
      localRoutes: (): LocalRoute[] => {
        routeCalls += 1;
        return routes;
      },
    };
  }

  test("J1: an experimental route labels its journal workload under include=local-routes", async () => {
    // Kills: readFleetSnapshotOrLocalRoutes returning the journal entry
    // without the overlay.
    const res = handleFleetSnapshotRoute(new Request(WITH_PARAM), opts(j1Routes()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as FleetSnapshotBody;
    expect(body.kind).toBe("fleet-snapshot");
    expect(workloadAt(body, 0)).toEqual({
      ...JOURNAL_SNAPSHOT.workloads[0],
      labels: { [QUALIFICATION]: "experimental" },
    });
    expect("labels" in workloadAt(body, 1)).toBe(false);
    expect(body).toEqual({
      ...JOURNAL_SNAPSHOT,
      workloads: [
        { ...JOURNAL_SNAPSHOT.workloads[0], labels: { [QUALIFICATION]: "experimental" } },
        JOURNAL_SNAPSHOT.workloads[1],
      ],
    });
  });

  test("J2: an explicit-label route labels; a validated route does not", async () => {
    // Kills: overlay keyed only on qualificationStage instead of
    // routingCapabilities.isExperimentalRoute, and labelling every routed workload.
    const routes = [
      route({
        workload: "glm-host",
        model: "glm-alias",
        labels: { [QUALIFICATION]: "experimental" },
      }),
      route({
        workload: "qwen-run",
        model: "qwen",
        port: 8081,
        qualificationStage: "validated",
      }),
    ];
    const res = handleFleetSnapshotRoute(new Request(WITH_PARAM), opts(routes));
    expect(res.status).toBe(200);
    const body = (await res.json()) as FleetSnapshotBody;
    expect(workloadAt(body, 0).labels).toEqual({ [QUALIFICATION]: "experimental" });
    expect("labels" in workloadAt(body, 1)).toBe(false);
  });

  test("J3: without include=local-routes the journal entry is served unchanged", async () => {
    // Guard: applying the overlay (and listLocalRoutes IO) for
    // supervisor/CLI callers.
    const res = handleFleetSnapshotRoute(new Request(WITHOUT_PARAM), opts(j1Routes()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as FleetSnapshotBody;
    expect(body).toEqual(JOURNAL_SNAPSHOT);
    for (const workload of body.workloads ?? []) {
      expect("labels" in workload).toBe(false);
    }
    expect(routeCalls).toBe(0);
  });

  test("J4: an empty journal workload list never lists routes", async () => {
    // Guard: preserves fleet-snapshot-local-routes.test.ts "returns the
    // journal entry unchanged" — no route IO when nothing can be labelled.
    writeFileSync(
      journalPath,
      `${JSON.stringify({ ...JOURNAL_SNAPSHOT, workloads: [] })}\n`,
      "utf8",
    );
    const res = handleFleetSnapshotRoute(new Request(WITH_PARAM), opts(j1Routes()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as FleetSnapshotBody;
    expect(body).toEqual({ ...JOURNAL_SNAPSHOT, workloads: [] });
    expect(routeCalls).toBe(0);
  });

  test("J5: a failing route source still serves the journal entry", async () => {
    // Guard: the overlay must swallow route-source errors like
    // localRoutesFallback does — never a 204, never a throw.
    const failing: FleetSnapshotRouteOptions = {
      journalPath,
      localRoutes: (): LocalRoute[] => {
        throw new Error("ps failed");
      },
    };
    const res = handleFleetSnapshotRoute(new Request(WITH_PARAM), failing);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FleetSnapshotBody;
    expect(body).toEqual(JOURNAL_SNAPSHOT);
  });

  test("J6: the overlay matches journal workloads by name, not by model id", async () => {
    // Kills: matching by model id or labelling every workload — the
    // other-host route serves glm-alias yet must not label glm-host,
    // while the qwen-run name match still labels.
    const routes = [
      route({
        workload: "other-host",
        model: "glm-alias",
        qualificationStage: "experimental",
      }),
      route({
        workload: "qwen-run",
        model: "qwen",
        port: 8081,
        qualificationStage: "experimental",
      }),
    ];
    const res = handleFleetSnapshotRoute(new Request(WITH_PARAM), opts(routes));
    expect(res.status).toBe(200);
    const body = (await res.json()) as FleetSnapshotBody;
    expect("labels" in workloadAt(body, 0)).toBe(false);
    expect(workloadAt(body, 1).labels).toEqual({ [QUALIFICATION]: "experimental" });
  });

  test("J7: the tRPC fleetSnapshot procedure agrees with the HTTP route", async () => {
    // Kills: an overlay only in handleFleetSnapshotRoute and not in
    // readFleetSnapshotOrLocalRoutes.
    const res = handleFleetSnapshotRoute(new Request(WITH_PARAM), opts(j1Routes()));
    expect(res.status).toBe(200);
    const httpBody = (await res.json()) as FleetSnapshotBody;

    const query = await callFleetSnapshot(
      { fleetJournalPath: journalPath, fleetLocalRoutes: () => j1Routes() },
      { include: ["local-routes"] },
    );
    expect((query as FleetSnapshotBody).workloads?.[0]?.labels).toEqual({
      [QUALIFICATION]: "experimental",
    });
    expect(JSON.stringify(query)).toBe(JSON.stringify(httpBody));
  });

  test("J8: a journal-served experimental alias reaches peer rows labelled", async () => {
    // Kills: the same missing overlay, observed at the consumer — the peer
    // poller forwards only labels the snapshot actually carries. The
    // producer side is already green (#830), pinned here so a regression
    // there cannot masquerade as this slice's failure.
    const routes = j1Routes();
    const produced = buildLocalRoutesSnapshot(routes, (): string => "boot-1", NOW);
    expect(produced?.workloads[0]?.labels).toEqual({ [QUALIFICATION]: "experimental" });

    const res = handleFleetSnapshotRoute(new Request(WITH_PARAM), opts(routes));
    expect(res.status).toBe(200);
    const body = (await res.json()) as FleetSnapshotBody;
    stubPeerFetch(body);
    const snap = await __peerSnapshotInternals.fetchPeerSnapshot(
      { id: "peer-z", endpoint: "https://127.0.0.1:7843", token: "peer-token" },
      1234,
    );
    expect(snap?.workloads).toEqual([
      {
        modelId: "glm-alias",
        port: 8080,
        revision: "boot-1",
        labels: { [QUALIFICATION]: "experimental" },
      },
      {
        modelId: "org/glm.gguf",
        port: 8080,
        revision: "boot-1",
        labels: { [QUALIFICATION]: "experimental" },
      },
      { modelId: "qwen", port: 8081, revision: "boot-2" },
    ]);
  });
});
