import {
  type FleetSnapshotEntry,
  openAggregatorDb,
  writeSnapshot,
} from "@llamactl/fleet-supervisor";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyManifest, type WorkloadClient } from "../src/workload/apply.js";

let dir: string;
let dbPath: string;
let journalPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "placement-staleness-"));
  dbPath = join(dir, "cluster.db");
  journalPath = join(dir, "journal.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeSnapshot(node: string, ts: string, freeMb: number): FleetSnapshotEntry {
  return {
    kind: "fleet-snapshot",
    ts,
    node,
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
  };
}

const TARGET = "models/qwen.gguf";

function makeMockClient(target: string): WorkloadClient {
  return {
    serverStatus: {
      query: () =>
        Promise.resolve({
          state: "up",
          rel: target,
          extraArgs: [],
          pid: 999,
          host: null,
          port: null,
          binary: null,
          endpoint: "http://127.0.0.1:8080",
        }),
    },
    serverStop: { mutate: () => Promise.resolve(undefined) },
    serverStart: {
      subscribe: (_input, callbacks): { unsubscribe: () => undefined } => {
        queueMicrotask(() => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 1, endpoint: "http://127.0.0.1:8080" },
          });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStart: {
      subscribe: (_input, callbacks): { unsubscribe: () => undefined } => {
        queueMicrotask(() => {
          callbacks.onData({ type: "done", result: { ok: true } });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStop: { mutate: () => Promise.resolve(undefined) },
    modelHostStatus: { query: () => Promise.resolve({ state: "Stopped", pid: null }) },
    rpcServerStart: {
      subscribe: (_input, callbacks): { unsubscribe: () => undefined } => {
        queueMicrotask(() => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 1, endpoint: "127.0.0.1:50052" },
          });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    rpcServerStop: { mutate: () => Promise.resolve(undefined) },
    rpcServerDoctor: {
      query: () => Promise.resolve({ ok: true, path: "/bin/rpc-server", llamaCppBin: "/bin" }),
    },
  };
}

const autoManifest = {
  apiVersion: "llamactl/v1",
  kind: "ModelRun",
  metadata: { name: "test-run", labels: {}, annotations: {} },
  spec: {
    node: "auto",
    enabled: true,
    gateway: false,
    target: { kind: "rel", value: TARGET },
    extraArgs: [],
    workers: [],
    restartPolicy: "Always",
    allowExternalBind: false,
    timeoutSeconds: 60,
  },
};

describe("placement staleness filtering", () => {
  test("default path (no staleCutoffMs) excludes stale node, picks fresh node", async () => {
    const staleTs = new Date(Date.now() - 300_000).toISOString(); // 5 min ago
    const freshTs = new Date(Date.now() - 5_000).toISOString(); // 5 s ago

    const db = openAggregatorDb(dbPath);
    // stale node has MORE free memory so without filtering it would win
    writeSnapshot(db, "stale-node", makeSnapshot("stale-node", staleTs, 16_000));
    writeSnapshot(db, "fresh-node", makeSnapshot("fresh-node", freshTs, 8_000));
    db.close();

    let chosenNode = "";

    const result = await applyManifest({
      manifest: autoManifest,
      placement: { dbPath, journalPath },
      getClient: (node) => {
        chosenNode = node;
        return makeMockClient(TARGET);
      },
    });

    expect(result.ok).toBe(true);
    expect(chosenNode).toBe("fresh-node");
  });

  test("staleCutoffMs: 0 disables filtering — stale node can be chosen", async () => {
    const staleTs = new Date(Date.now() - 300_000).toISOString();
    const freshTs = new Date(Date.now() - 5_000).toISOString();

    const db = openAggregatorDb(dbPath);
    // stale node has MORE free memory — without filtering it wins
    writeSnapshot(db, "stale-node", makeSnapshot("stale-node", staleTs, 16_000));
    writeSnapshot(db, "fresh-node", makeSnapshot("fresh-node", freshTs, 8_000));
    db.close();

    let chosenNode = "";

    const result = await applyManifest({
      manifest: autoManifest,
      placement: { dbPath, journalPath, staleCutoffMs: 0 },
      getClient: (node) => {
        chosenNode = node;
        return makeMockClient(TARGET);
      },
    });

    expect(result.ok).toBe(true);
    // With filtering disabled, stale node wins (more free memory)
    expect(chosenNode).toBe("stale-node");
  });

  test("when only stale nodes exist and staleCutoffMs is default, placement fails", async () => {
    const staleTs = new Date(Date.now() - 300_000).toISOString();

    const db = openAggregatorDb(dbPath);
    writeSnapshot(db, "stale-node", makeSnapshot("stale-node", staleTs, 16_000));
    db.close();

    const result = await applyManifest({
      manifest: autoManifest,
      placement: { dbPath, journalPath },
      getClient: () => makeMockClient(TARGET),
    });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("no viable placement node");
  });
});
