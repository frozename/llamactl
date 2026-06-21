import { expect, test } from "bun:test";

import type { PeerNode } from "../src/config/peers.js";
import type { LocalRoute, PeerSnapshot } from "../src/workloadRuntime.js";

import { listClusterRoutes } from "../src/workloadRuntime.js";

const localRoute = (model: string, workload = "local-a"): LocalRoute => ({
  workload,
  model,
  host: "127.0.0.1",
  port: 8081,
  engine: "llamacpp",
  kind: "ModelRun",
  pid: process.pid,
});

const config = {
  peers: [
    {
      id: "mac-mini",
      endpoint: "https://macmini.ai:7843",
      certificate: "-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----\\n",
    },
  ],
} satisfies { peers: PeerNode[] };

const now = Date.now();

const normalSnapshot: PeerSnapshot = {
  workloads: [{ modelId: "peer/model.gguf", port: 9001 }],
  pressure: "NORMAL",
  fetchedAt: now,
};

test("T1: listClusterRoutes merges local + peer routes and marks peers", () => {
  const routes = listClusterRoutes(
    [localRoute("local/model.gguf")],
    new Map([["mac-mini", normalSnapshot]]),
    config,
    now,
  );

  expect(routes.map((route) => route.model).sort()).toEqual([
    "local/model.gguf",
    "peer/model.gguf",
  ]);
  const peer = routes.find((route) => route.model === "peer/model.gguf");
  expect(peer && "isPeer" in peer ? peer.isPeer : undefined).toBe(true);
  expect(peer && "targetNodeId" in peer ? peer.targetNodeId : undefined).toBe("mac-mini");
});

test("T2: local route wins on model collision", () => {
  const routes = listClusterRoutes(
    [localRoute("shared/model.gguf")],
    new Map([
      [
        "mac-mini",
        {
          workloads: [{ modelId: "shared/model.gguf", port: 9002 }],
          pressure: "NORMAL",
          fetchedAt: now,
        },
      ],
    ]),
    config,
    now,
  );

  expect(routes.filter((route) => route.model === "shared/model.gguf")).toHaveLength(1);
  const winner = routes.find((route) => route.model === "shared/model.gguf");
  expect(winner && "isPeer" in winner ? winner.isPeer : undefined).toBeUndefined();
});

test("T3: peer in HIGH pressure is excluded", () => {
  const routes = listClusterRoutes(
    [localRoute("local/model.gguf")],
    new Map([
      [
        "mac-mini",
        {
          workloads: [{ modelId: "peer/model.gguf", port: 9002 }],
          pressure: "HIGH",
          fetchedAt: now,
        },
      ],
    ]),
    config,
    now,
  );

  expect(routes.find((route) => route.model === "peer/model.gguf")).toBeUndefined();
});

test("T4: stale peer snapshot (older than 30s) is excluded", () => {
  const routes = listClusterRoutes(
    [localRoute("local/model.gguf")],
    new Map([
      [
        "mac-mini",
        {
          workloads: [{ modelId: "peer/model.gguf", port: 9002 }],
          pressure: "NORMAL",
          fetchedAt: now - 31_000,
        },
      ],
    ]),
    config,
    now,
  );

  expect(routes.find((route) => route.model === "peer/model.gguf")).toBeUndefined();
});

test("T5: empty peers map yields no peer routes", () => {
  const routes = listClusterRoutes([localRoute("local/model.gguf")], new Map(), config, now);
  expect(routes).toHaveLength(1);
  expect(routes[0]?.model).toBe("local/model.gguf");
});

test("T6 FLAG-C: peer route does not include useProxy field", () => {
  const routes = listClusterRoutes(
    [localRoute("local/model.gguf")],
    new Map([["mac-mini", normalSnapshot]]),
    config,
    now,
  );
  const peer = routes.find((route) => route.model === "peer/model.gguf");
  expect(peer).toBeDefined();
  expect(Object.prototype.hasOwnProperty.call(peer!, "useProxy")).toBe(false);
});
