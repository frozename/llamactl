import type { LocalRoute, PeerSnapshot } from "@llamactl/core/workloadRuntime";
import type { FleetSnapshotEntry } from "@llamactl/fleet-supervisor";

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildLocalRoutesSnapshot,
  labelJournalExperimentalWorkloads,
} from "../src/routes/fleet.js";
import { __peerSnapshotInternals } from "../src/server/peer-snapshot-poller.js";

const originalFetch = globalThis.fetch;
const NOW = new Date("2026-11-23T12:00:00.000Z");
const QUALIFICATION = "llamactl.io/qualification";
const MODEL = "org/glm.gguf";

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

function localRoutesPayload(labels: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "local-routes",
    ts: NOW.toISOString(),
    workloads: [
      {
        name: "glm-host",
        models: [MODEL],
        endpoint: "http://127.0.0.1:8080",
        reachable: true,
        revision: "rev-1",
        labels,
      },
    ],
  };
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

async function snapshotForLabels(labels: Record<string, unknown>): Promise<PeerSnapshot | null> {
  stubPeerFetch(localRoutesPayload(labels));
  return await __peerSnapshotInternals.fetchPeerSnapshot(
    { id: "peer-z", endpoint: "https://127.0.0.1:7843", token: "t" },
    1234,
  );
}

function journalEntry(): FleetSnapshotEntry {
  return {
    kind: "fleet-snapshot",
    ts: NOW.toISOString(),
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
        rss_mb: 1500,
        request_rate_5m: 2,
        error_rate_5m: 0,
        p50_ms: 120,
        p95_ms: 250,
        models: [MODEL],
        reachable: true,
        consecutiveErrors: 0,
        revision: "boot-1",
      },
    ],
  };
}

describe("peer snapshot degraded qualification label (#518)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("F-D1: a degraded-only workload advertises the degraded qualification label", () => {
    // Kills: the producer emitting only experimental.
    const snap = buildLocalRoutesSnapshot(
      [route({ workload: "glm-host", model: MODEL, qualificationStage: "degraded" })],
      (): string => "rev-1",
      NOW,
    );
    expect(snap?.workloads).toEqual([
      {
        name: "glm-host",
        models: [MODEL],
        endpoint: "http://127.0.0.1:8080",
        reachable: true,
        revision: "rev-1",
        labels: { [QUALIFICATION]: "degraded" },
      },
    ]);
  });

  test("F-D2: experimental wins over degraded in either route order", () => {
    // Kills: last-route-wins label assignment, where a later degraded route overwrites experimental.
    const degraded = route({
      workload: "glm-host",
      model: "glm-degraded",
      qualificationStage: "degraded",
    });
    const experimental = route({
      workload: "glm-host",
      model: "glm-experimental",
      qualificationStage: "experimental",
    });
    for (const routes of [
      [degraded, experimental],
      [experimental, degraded],
    ]) {
      const snap = buildLocalRoutesSnapshot(routes, (): string => "rev-1", NOW);
      expect(snap?.workloads).toEqual([
        {
          name: "glm-host",
          models: routes.map((entry) => entry.model),
          endpoint: "http://127.0.0.1:8080",
          reachable: true,
          revision: "rev-1",
          labels: { [QUALIFICATION]: "experimental" },
        },
      ]);
    }
  });

  test("J-D1: the journal overlay labels a degraded workload without mutating the entry", () => {
    // Kills: the journal overlay ignoring degraded.
    const entry = journalEntry();
    const before = structuredClone(entry);
    const overlaid = labelJournalExperimentalWorkloads(entry, {
      localRoutes: (): LocalRoute[] => [
        route({ workload: "glm-host", model: MODEL, qualificationStage: "degraded" }),
      ],
    });
    expect(overlaid).toEqual({
      ...entry,
      workloads: [
        {
          ...entry.workloads[0]!,
          labels: { [QUALIFICATION]: "degraded" },
        },
      ],
    });
    expect(entry).toEqual(before);
  });

  test("J-D2: experimental wins the journal overlay and clean routes return the same object", () => {
    // Kills: a degraded overlay overwriting experimental, or copying an unchanged entry.
    const entry = journalEntry();
    const mixed = labelJournalExperimentalWorkloads(entry, {
      localRoutes: (): LocalRoute[] => [
        route({ workload: "glm-host", model: "glm-degraded", qualificationStage: "degraded" }),
        route({ workload: "glm-host", model: MODEL, qualificationStage: "experimental" }),
      ],
    });
    expect(mixed).toEqual({
      ...entry,
      workloads: [
        {
          ...entry.workloads[0]!,
          labels: { [QUALIFICATION]: "experimental" },
        },
      ],
    });

    const clean = labelJournalExperimentalWorkloads(entry, {
      localRoutes: (): LocalRoute[] => [route({ workload: "glm-host", model: MODEL })],
    });
    expect(clean).toBe(entry);
  });

  test("P-D1: a degraded-labelled workload forwards the label onto every model row", async () => {
    // Kills: the forwarder dropping degraded.
    const snapshot = await snapshotForLabels({ [QUALIFICATION]: "degraded" });
    expect(snapshot?.workloads).toEqual([
      {
        modelId: MODEL,
        port: 8080,
        revision: "rev-1",
        labels: { [QUALIFICATION]: "degraded" },
      },
    ]);
  });

  test("P-D2: extra labels alongside degraded are dropped", async () => {
    // Kills: forwarding the raw peer record.
    const snapshot = await snapshotForLabels({ [QUALIFICATION]: "degraded", team: "x" });
    expect(snapshot?.workloads).toEqual([
      {
        modelId: MODEL,
        port: 8080,
        revision: "rev-1",
        labels: { [QUALIFICATION]: "degraded" },
      },
    ]);
  });

  test("P-D3: non-degraded stages and wrong-case degraded forward no labels", async () => {
    // Kills: forwarding every qualification value instead of only the degraded exclusion signal.
    for (const value of ["validated", "production", "candidate", "Degraded"]) {
      const snapshot = await snapshotForLabels({ [QUALIFICATION]: value });
      expect(snapshot?.workloads).toEqual([{ modelId: MODEL, port: 8080, revision: "rev-1" }]);
      for (const row of snapshot?.workloads ?? []) {
        expect("labels" in row).toBe(false);
      }
    }
  });
});
