import type { LocalRoute, PeerSnapshot } from "@llamactl/core/workloadRuntime";

import { routingCatalog } from "@llamactl/core";
import { listClusterRoutes } from "@llamactl/core/workloadRuntime";
import { afterEach, describe, expect, test } from "bun:test";

import { buildLocalRoutesSnapshot } from "../src/routes/fleet.js";
import { __peerSnapshotInternals } from "../src/server/peer-snapshot-poller.js";

const originalFetch = globalThis.fetch;
const NOW = new Date("2026-11-23T12:00:00.000Z");
const QUALIFICATION = "llamactl.io/qualification";

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

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Stub globalThis.fetch to answer the peer snapshot GET with `payload`. */
function stubPeerFetch(payload: unknown): void {
  globalThis.fetch = ((_input: Request | string | URL, _init?: RequestInit) =>
    Promise.resolve(jsonResponse(payload))) as typeof fetch;
}

async function snapshotFor(payload: unknown): Promise<PeerSnapshot | null> {
  stubPeerFetch(payload);
  return await __peerSnapshotInternals.fetchPeerSnapshot(
    { id: "peer-z", endpoint: "https://127.0.0.1:7843", token: "peer-token" },
    1234,
  );
}

function localRoutesPayload(workloads: Record<string, unknown>[]): Record<string, unknown> {
  return {
    kind: "local-routes",
    ts: NOW.toISOString(),
    workloads,
  };
}

describe("peer snapshot qualification label forwarding (#518)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("P1: an experimental-labelled workload forwards the label onto every model row", async () => {
    // Kills: collectPeerWorkloads dropping labels.
    const snapshot = await snapshotFor(
      localRoutesPayload([
        {
          name: "glm-host",
          models: ["glm-alias", "org/glm.gguf"],
          endpoint: "http://127.0.0.1:8080",
          reachable: true,
          revision: "rev-1",
          labels: { [QUALIFICATION]: "experimental" },
        },
      ]),
    );
    expect(snapshot?.workloads).toEqual([
      {
        modelId: "glm-alias",
        port: 8080,
        revision: "rev-1",
        labels: { [QUALIFICATION]: "experimental" },
      },
      {
        modelId: "org/glm.gguf",
        port: 8080,
        revision: "rev-1",
        labels: { [QUALIFICATION]: "experimental" },
      },
    ]);
  });

  test("P2: only the experimental qualification label is forwarded", async () => {
    // Guard: kills forwarding any stage or arbitrary labels — every variant
    // below must produce rows with no `labels` key at all.
    const variants: unknown[] = [
      { [QUALIFICATION]: "validated" },
      { [QUALIFICATION]: "production", team: "x" },
      { team: "eval" },
      null,
      "experimental",
      ["experimental"],
      { [QUALIFICATION]: 7 },
    ];
    for (const labels of variants) {
      const snapshot = await snapshotFor(
        localRoutesPayload([
          {
            name: "w1",
            models: ["m1"],
            endpoint: "http://127.0.0.1:8080",
            reachable: true,
            revision: "rev-1",
            labels,
          },
        ]),
      );
      expect(snapshot?.workloads).toEqual([{ modelId: "m1", port: 8080, revision: "rev-1" }]);
      for (const row of snapshot?.workloads ?? []) {
        expect("labels" in row).toBe(false);
      }
    }
  });

  test("P3: an unreachable experimental workload contributes no rows", async () => {
    // Guard: reachable:false is skipped before labels are read.
    const snapshot = await snapshotFor(
      localRoutesPayload([
        {
          name: "ghost",
          models: ["ghost-model"],
          endpoint: "http://127.0.0.1:9999",
          reachable: false,
          revision: "rev-g",
          labels: { [QUALIFICATION]: "experimental" },
        },
        {
          name: "live",
          models: ["live-model"],
          endpoint: "http://127.0.0.1:8080",
          reachable: true,
          revision: "rev-l",
        },
      ]),
    );
    expect(snapshot?.workloads).toEqual([{ modelId: "live-model", port: 8080, revision: "rev-l" }]);
  });

  test("P3b: modelId dedupe keeps the first workload's label decision", async () => {
    // Guard: first workload wins — a validated label emits nothing, so the
    // surviving row carries no labels even though a later experimental
    // workload shares the modelId. A last-wins or merge mutant leaks it.
    const snapshot = await snapshotFor(
      localRoutesPayload([
        {
          name: "first",
          models: ["dup-model"],
          endpoint: "http://127.0.0.1:8080",
          reachable: true,
          revision: "rev-first",
          labels: { [QUALIFICATION]: "validated" },
        },
        {
          name: "second",
          models: ["dup-model"],
          endpoint: "http://127.0.0.1:8081",
          reachable: true,
          revision: "rev-second",
          labels: { [QUALIFICATION]: "experimental" },
        },
      ]),
    );
    expect(snapshot?.workloads).toEqual([
      { modelId: "dup-model", port: 8080, revision: "rev-first" },
    ]);
    for (const row of snapshot?.workloads ?? []) {
      expect("labels" in row).toBe(false);
    }
  });

  test("P4: an experimental alias snapshot round-trips into experimental-excluded routing", async () => {
    // Kills: either half of the producer/forwarder pair —
    // buildLocalRoutesSnapshot not emitting the label, or
    // collectPeerWorkloads not forwarding it. On base the peer route stays
    // unlabeled, so the non-pinned selection keeps it eligible.
    const localSnapshot = buildLocalRoutesSnapshot(
      [
        route({
          workload: "glm-host",
          model: "glm-alias",
          qualificationStage: "experimental",
        }),
        route({
          workload: "glm-host",
          model: "org/glm.gguf",
          qualificationStage: "experimental",
        }),
      ],
      (): string => "rev-1",
      NOW,
    );
    if (localSnapshot === null) throw new Error("expected a local-routes snapshot");
    stubPeerFetch(localSnapshot);
    const snap = await __peerSnapshotInternals.fetchPeerSnapshot(
      { id: "peer-z", endpoint: "https://127.0.0.1:7843", token: "peer-token" },
      1234,
    );
    if (snap === null) throw new Error("expected a peer snapshot");

    const routes = listClusterRoutes(
      [],
      new Map([["peer-z", snap]]),
      { peers: [{ id: "peer-z", endpoint: "https://peer-z.test:443" }] },
      1234,
    );
    const catalog = routingCatalog.buildRouteCatalog({ routes });

    const unpinned = routingCatalog.selectCatalogCandidates(catalog, "glm-alias", {
      pinned: false,
    });
    expect(unpinned.eligible).toEqual([]);
    expect(
      unpinned.rejected.some((entry) => entry.rejection.reason === "experimental-excluded"),
    ).toBe(true);

    const pinned = routingCatalog.selectCatalogCandidates(catalog, "glm-alias", {
      pinned: true,
    });
    expect(pinned.rejected).toEqual([]);
    expect(pinned.eligible.map((candidate) => candidate.advertisement.ownerNodeId)).toEqual([
      "peer-z",
    ]);
  });
});
