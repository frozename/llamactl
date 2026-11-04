/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- RED contract tests for #410 P3: the node-scoped console mount does not exist yet, so every case reaches the server through the untyped `api()` shim and fails on its expects rather than on an import error or a TypeError. */
// Issue frozename/llamactl#410 (plan P3) — tab-scoped node selection,
// server half. The console mounts `/api/n/:node/trpc/*` and validates
// the node segment against the kubeconfig before any procedure runs:
// agent nodes (plus the in-process "local") dispatch, gateway/RAG
// nodes 400, synthesized `<gateway>.<provider>` and unknown names 404,
// encoded separators in the segment 400. The resolved node binds into
// ctx so concurrent tabs cannot redirect each other, the kubeconfig
// defaultNode never substitutes for the path node, and CONTROL_PLANE_ONLY
// procedures still run locally under a remote node — while an invalid
// node segment is refused regardless. The bare `/api/trpc` mount is
// gone (404 not_found) and the session guard still runs first.

import { afterEach, describe, expect, test } from "bun:test";

import * as remote from "../../src/index.js";
import {
  apiHeaders,
  cleanupConsoleTest,
  consoleTestFixture,
  gatewayNodeFixture,
  makeFakeRemote,
  makeLocalSpy,
  ragNodeFixture,
  rawUrl,
  remoteNodeFixture,
  SENTINELS,
  setEnv,
  startConsole,
  trpcUrl,
} from "./helpers.js";

function api(): any {
  expect(typeof remote.startConsoleServer).toBe("function");
  expect(typeof remote.buildDispatchRouter).toBe("function");
  expect(remote.CONTROL_PLANE_ONLY).toBeDefined();
  return remote as any;
}

/**
 * The console-side dispatch seam: a recording local caller plus a
 * recording pinned-fetch factory standing in for remote1, wired through
 * buildDispatchRouter exactly the way server.ts wires its backend.
 */
function routingBackend(): {
  backend: unknown;
  fake: ReturnType<typeof makeFakeRemote>;
  spy: ReturnType<typeof makeLocalSpy>;
} {
  const fake = makeFakeRemote();
  const spy = makeLocalSpy();
  const backend = remote.buildDispatchRouter({
    fetchFactory: fake.fetchFactory,
    localCallerFactory: spy.localCallerFactory,
    nodeFromCtx: (c: { node?: string | null }) => c.node ?? null,
    onUnresolvable: "error",
  });
  return { backend, fake, spy };
}

/** Cluster with one dispatchable agent, one gateway and one RAG node. */
function routingFixture(): { distPath: string } {
  return consoleTestFixture({
    nodes: [remoteNodeFixture(), gatewayNodeFixture(), ragNodeFixture()],
    users: [{ name: "me", token: "tok-routing" }],
  });
}

afterEach(async () => {
  await cleanupConsoleTest();
});

describe("console tab-scoped node routing", () => {
  test("(P3.1) 50 interleaved serverStatus calls land on their own node", async () => {
    const r = api();
    const { backend, fake, spy } = routingBackend();
    const h = await startConsole(r, { backend, distPath: routingFixture().distPath });
    const results = await Promise.all(
      Array.from({ length: 50 }, async (_, i) => {
        const node = i % 2 === 1 ? "remote1" : "local";
        const res = await fetch(trpcUrl(h, "serverStatus", { input: { workload: "w1" }, node }), {
          headers: apiHeaders(h),
        });
        return { node, res };
      }),
    );
    for (const { node, res } of results) {
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(node);
    }
    expect(fake.calls.filter((n) => n === "serverStatus")).toHaveLength(25);
    expect(spy.calls.filter((n) => n === "serverStatus")).toHaveLength(25);
  });

  test("(P3.2) /api/n/ghost/… → 404 unknown_node, no local fallback", async () => {
    const r = api();
    const { backend, fake, spy } = routingBackend();
    const h = await startConsole(r, { backend, distPath: routingFixture().distPath });
    const res = await fetch(
      trpcUrl(h, "serverStatus", { input: { workload: "w1" }, node: "ghost" }),
      { headers: apiHeaders(h) },
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "unknown_node" });
    expect(spy.calls).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  test("(P3.3) gateway, RAG and synthesized provider names refuse dispatch", async () => {
    const r = api();
    const { backend, fake, spy } = routingBackend();
    const h = await startConsole(r, { backend, distPath: routingFixture().distPath });
    const cases: { node: string; status: number; error: string }[] = [
      { error: "node_not_dispatchable", node: "gw1", status: 400 },
      { error: "node_not_dispatchable", node: "ragdb", status: 400 },
      { error: "unknown_node", node: "gw1.openai", status: 404 },
    ];
    for (const c of cases) {
      const res = await fetch(
        trpcUrl(h, "serverStatus", { input: { workload: "w1" }, node: c.node }),
        { headers: apiHeaders(h) },
      );
      expect(res.status).toBe(c.status);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ error: c.error });
    }
    expect(spy.calls).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  test("(P3.3b) an inproc://local node with a non-agent kind dispatches locally", async () => {
    // Kills the mutant that drops the `endpoint === LOCAL_NODE_ENDPOINT`
    // branch of validateConsoleNode: without it this node 400s
    // node_not_dispatchable while resolveDispatchTarget would still run
    // it locally — the validator and the dispatcher must agree.
    const r = api();
    const { backend, fake, spy } = routingBackend();
    const { distPath } = consoleTestFixture({
      nodes: [
        {
          endpoint: "inproc://local",
          kind: "rag",
          name: "raglocal",
          rag: {
            auth: { tokenEnv: "RAGLOCAL_PASS" },
            endpoint: `postgres://rag:${SENTINELS.pg}@db.local:5432/rag`,
            provider: "pgvector",
          },
        },
        gatewayNodeFixture(),
        ragNodeFixture(),
        remoteNodeFixture(),
      ],
      users: [{ name: "me", token: "tok-routing" }],
    });
    const h = await startConsole(r, { backend, distPath });
    const res = await fetch(
      trpcUrl(h, "serverStatus", { input: { workload: "w1" }, node: "raglocal" }),
      { headers: apiHeaders(h) },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("local");
    expect(spy.calls).toEqual(["serverStatus"]);
    expect(fake.calls).toEqual([]);
  });

  test("(P3.4) default backend: unresolvable tokenRef → 412 node_credentials_unavailable", async () => {
    const r = api();
    setEnv("LLAMACTL_ROUTING_TEST_UNSET", undefined);
    const { distPath } = consoleTestFixture({
      nodes: [remoteNodeFixture()],
      users: [{ name: "me", tokenRef: "env:LLAMACTL_ROUTING_TEST_UNSET" }],
    });
    const h = await startConsole(r, { distPath });
    const res = await fetch(
      trpcUrl(h, "serverStatus", { input: { workload: "w1" }, node: "remote1" }),
      { headers: apiHeaders(h) },
    );
    expect(res.status).toBe(412);
    expect(await res.text()).toContain("node_credentials_unavailable");
  });

  test("(P3.5) control-plane-only procedures run locally under remote1; ghost still 404s", async () => {
    const r = api();
    const { backend, fake, spy } = routingBackend();
    const h = await startConsole(r, { backend, distPath: routingFixture().distPath });
    for (const proc of ["nodeList", "workloadList"]) {
      const res = await fetch(trpcUrl(h, proc, { node: "remote1" }), {
        headers: apiHeaders(h),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("local");
    }
    expect([...spy.calls].sort()).toEqual(["nodeList", "workloadList"]);
    expect(fake.calls).toEqual([]);
    const ghost = await fetch(trpcUrl(h, "nodeList", { node: "ghost" }), {
      headers: apiHeaders(h),
    });
    expect(ghost.status).toBe(404);
    const body = await ghost.text();
    expect(JSON.parse(body)).toEqual({ error: "unknown_node" });
    expect(spy.calls).toHaveLength(2);
    expect(fake.calls).toEqual([]);
  });

  test("(P3.6) the path node wins over kubeconfig defaultNode", async () => {
    const r = api();
    const { backend, fake, spy } = routingBackend();
    const { distPath } = consoleTestFixture({
      defaultNode: "remote1",
      nodes: [remoteNodeFixture()],
    });
    const h = await startConsole(r, { backend, distPath });
    const res = await fetch(
      trpcUrl(h, "serverStatus", { input: { workload: "w1" }, node: "local" }),
      { headers: apiHeaders(h) },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("local");
    expect(spy.calls).toEqual(["serverStatus"]);
    expect(fake.calls).toEqual([]);
  });

  test("(P3.7) batch guard + node-segment hygiene under the node mount", async () => {
    const r = api();
    const { backend, fake, spy } = routingBackend();
    const h = await startConsole(r, { backend, distPath: routingFixture().distPath });
    const batched = await fetch(
      trpcUrl(h, "serverStatus,keepAliveStart", {
        batch: true,
        input: { "0": { workload: "w1" }, "1": { target: "t" } },
        node: "local",
      }),
      { headers: apiHeaders(h) },
    );
    expect(batched.status).toBe(404);
    const batchedBody = await batched.text();
    expect(JSON.parse(batchedBody)).toEqual({ error: "procedure_not_exposed" });
    for (const path of ["/api/n/lo%2Fcal/trpc/nodeList", "/api/n/local%2C/trpc/nodeList"]) {
      const res = await fetch(rawUrl(h, path), { headers: apiHeaders(h) });
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ error: "bad_node" });
    }
    expect(spy.calls).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  test("(P3.8) the bare /api/trpc mount is gone → 404 not_found", async () => {
    const r = api();
    const { backend, fake, spy } = routingBackend();
    const h = await startConsole(r, { backend, distPath: routingFixture().distPath });
    for (const path of ["/api/trpc/nodeList", "/api/trpc"]) {
      const res = await fetch(rawUrl(h, path), { headers: apiHeaders(h) });
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ error: "not_found" });
    }
    expect(spy.calls).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  test("(P3.9) the session guard runs before node validation", async () => {
    const r = api();
    const { backend, fake, spy } = routingBackend();
    const h = await startConsole(r, { backend, distPath: routingFixture().distPath });
    const res = await fetch(trpcUrl(h, "nodeList", { node: "ghost" }), {
      headers: {
        host: `127.0.0.1:${String(h.port)}`,
        "sec-fetch-site": "same-origin",
      },
    });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "invalid_session" });
    expect(spy.calls).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});
