import type { PeerNode } from "@llamactl/core/config/peers";

import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateSelfSignedCert } from "../../remote/src/server/tls.js";
import {
  createMigrationController,
  createPeerFetch,
  type FleetJournalEntry,
  type FleetSnapshotEntry,
  type NodeSnapshot,
} from "../src/index.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

const originalFetch = globalThis.fetch;

function requestUrl(input: Request | string | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestBodyJson(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("expected JSON string request body");
  return JSON.parse(body) as unknown;
}

function toNodeSnapshot(snapshot: FleetSnapshotEntry): NodeSnapshot {
  return {
    node: snapshot.node,
    pressureState: "NORMAL",
    nodeMem: { freeMb: snapshot.node_mem.free_mb },
    workloads: snapshot.workloads.map((workload) => ({
      name: workload.name,
      reachable: workload.reachable,
    })),
  };
}

describe("MigrationController integration", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("creates and executes a move flow without env gating", async () => {
    delete process.env["LLAMACTL_FLEET_MOVE_ENABLED"];

    let nowMs = 1_700_000_000_000;
    let tick = 10;
    const journal: FleetJournalEntry[] = [];

    const controller = createMigrationController({
      peers: ["m2mini"],
      fetchSnapshot: () =>
        Promise.resolve({
          node: "m2mini",
          pressureState: "NORMAL",
          nodeMem: { freeMb: 8000 },
          workloads: [{ name: "model-a", reachable: true }],
        }),
      deployWorkload: () => Promise.resolve(undefined),
      removeWorkload: () => Promise.resolve(undefined),
      selfNode: "m4pro",
      getLeaseHolder: () => "m4pro",
      getNowMs: () => nowMs,
      getCurrentTick: () => tick,
      healthTimeoutMs: 5,
      pollIntervalMs: 1,
      sleep: () => {
        nowMs += 1;
        tick += 1;
        return Promise.resolve();
      },
    });

    const proposal = await controller.onJournalEntry(
      {
        kind: "fleet-transition",
        ts: new Date(nowMs).toISOString(),
        node: "m4pro",
        subject: "node",
        subjectKind: "node",
        signal: "pressure",
        from: "NORMAL",
        to: "HIGH",
      },
      {
        name: "model-a",
        node: "m4pro",
        spec: { placement: "auto" },
        evictProposalId: "evict-1",
      },
      {
        node: "m4pro",
        pressureState: "HIGH",
        nodeMem: { freeMb: 100 },
        workloads: [],
      },
    );

    expect(proposal).not.toBeNull();
    if (proposal === null) throw new Error("expected proposal");

    const result = await controller.executeMove(proposal, (entry) => journal.push(entry));
    expect(result).toBe("pending_health_check");
    expect(
      journal.some((entry) => entry.kind === "fleet-proposal" && entry.action.type === "move"),
    ).toBe(true);

    await controller.advancePendingHealthPolls();
    expect(
      journal.some((entry) => entry.kind === "fleet-execution" && entry.status === "executed"),
    ).toBe(true);
  });

  it("T5: treats a disconnected tunnel relay snapshot as destination_unavailable", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "llamactl-migration-relay-"));
    const cert = await generateSelfSignedCert({
      dir: certDir,
      commonName: "127.0.0.1",
      hostnames: ["127.0.0.1"],
    });
    const relayCalls: { url: string; body: unknown }[] = [];
    globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
      relayCalls.push({
        url: requestUrl(input),
        body: requestBodyJson(init),
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: "res",
            id: "relay-1",
            error: { code: "tunnel-send-failed", message: "node is not connected" },
          }),
          { status: 502, headers: { "content-type": "application/json" } },
        ),
      );
    }) as typeof fetch;

    try {
      const peer: PeerNode = {
        id: "m2mini",
        endpoint: "https://direct-m2mini.invalid:7843",
        tunnelPreferred: true,
        tunnelCentralUrl: "https://central.local:7843",
        tunnelCentralCertificate: cert.certPem,
        tunnelCentralFingerprint: cert.fingerprint,
        tunnelRelayToken: "local-agent-token",
      };
      const fetchPeerSnapshot = createPeerFetch(peer);
      let relayErrorMessage = "";
      const controller = createMigrationController({
        peers: ["m2mini"],
        fetchSnapshot: async () => {
          try {
            const snapshot = await fetchPeerSnapshot();
            if (snapshot === null) throw new Error("empty snapshot");
            return toNodeSnapshot(snapshot);
          } catch (err) {
            relayErrorMessage = (err as Error).message;
            throw err;
          }
        },
        deployWorkload: () => Promise.resolve(undefined),
        removeWorkload: () => Promise.resolve(undefined),
        selfNode: "m4pro",
        getLeaseHolder: () => "m4pro",
        getNowMs: () => 1_700_000_000_000,
        healthTimeoutMs: 5,
        pollIntervalMs: 1,
      });

      const result = await controller.executeMove(
        {
          workload: "model-a",
          fromNode: "m4pro",
          toNode: "m2mini",
          proposalId: "move-model-a-1",
          evictProposalId: "evict-model-a-1",
          expiresAt: new Date(1_700_000_030_000).toISOString(),
          expiresAtMs: 1_700_000_030_000,
        },
        () => undefined,
      );

      expect(result).toBe("destination_unavailable");
      expect(relayCalls).toHaveLength(1);
      expect(relayCalls[0]!.url).toBe("https://central.local:7843/tunnel-relay/m2mini");
      expect(relayCalls[0]!.body).toEqual({
        method: "fleetSnapshot",
        type: "query",
        input: undefined,
      });
      expect(relayErrorMessage).toContain("502");
      expect(relayErrorMessage).toContain("tunnel-send-failed");
    } finally {
      rmSync(certDir, { recursive: true, force: true });
    }
  });
});
