/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- RED contract tests for #410 P5a: the serverStop allowlist entry and its server-side precheck do not exist yet, so every test reaches the console through the untyped `api()` shim and fails on its expects rather than on an import error or a TypeError. */
// Issue frozename/llamactl#410 (plan P5a) — serverStop on the console
// surface with a server-side precheck ahead of the wrapped backend. A
// single-node ModelRun on the request's node produces exactly one
// inner call carrying the caller's input; a missing manifest 404s, a
// ModelHost 409s, a node mismatch 409s and a multi-node ModelRun 409s
// — each before the inner serverStop runs. Names that cannot name a
// manifest are refused 400 bad_input ahead of the lookup seam, and a
// GET batch segment rides tRPC's own METHOD_NOT_SUPPORTED check. The
// lookupWorkload seam is injected so no case touches the real
// workloads dir.

import { afterEach, describe, expect, test } from "bun:test";

import * as remote from "../../src/index.js";
import {
  apiHeaders,
  cleanupConsoleTest,
  consoleTestFixture,
  makeLookupSpy,
  makeSpyBackend,
  modelHostFixture,
  modelRunFixture,
  type SpyCall,
  spyFixtures,
  startConsole,
  trpcUrl,
} from "./helpers.js";

function api(): any {
  expect(typeof remote.startConsoleServer).toBe("function");
  return remote as any;
}

interface StopResult {
  body: any;
  lookupSpy: ReturnType<typeof makeLookupSpy>;
  res: Response;
  stopCalls: SpyCall[];
}

/**
 * The shared P5a path: console up over the spy backend with the
 * recording lookup seam, then one non-batch POST of
 * serverStop({workload, graceSeconds: 5}) on node "local".
 */
async function postServerStop(
  manifests: Record<string, unknown>,
  workload: string,
  fixtures: Record<string, unknown> = spyFixtures(),
): Promise<StopResult> {
  const r = api();
  const spy = makeSpyBackend(fixtures);
  const lookupSpy = makeLookupSpy(manifests);
  const h = await startConsole(r, {
    backend: spy.router,
    distPath: consoleTestFixture().distPath,
    lookupWorkload: lookupSpy.lookup,
  });
  const res = await fetch(trpcUrl(h, "serverStop"), {
    body: JSON.stringify({ workload, graceSeconds: 5 }),
    headers: apiHeaders(h, { "content-type": "application/json" }),
    method: "POST",
  });
  const body = await res.json();
  return {
    body,
    lookupSpy,
    res,
    stopCalls: spy.calls.filter((c) => c.path === "serverStop"),
  };
}

afterEach(async () => {
  await cleanupConsoleTest();
});

describe("console serverStop precheck", () => {
  test("(P5a) missing manifest → 404 workload_not_found, zero stop calls", async () => {
    const { res, body, lookupSpy, stopCalls } = await postServerStop({}, "ghost");
    expect(res.status).toBe(404);
    expect(body.error.message).toBe("workload_not_found");
    expect(stopCalls).toHaveLength(0);
    expect(lookupSpy.calls).toEqual(["ghost"]);
  });

  test("(P5a) ModelHost manifest → 409 unsupported_workload_kind, zero stop calls", async () => {
    const { res, body, lookupSpy, stopCalls } = await postServerStop(
      { h1: modelHostFixture("h1", "local") },
      "h1",
    );
    expect(res.status).toBe(409);
    expect(body.error.message).toBe("unsupported_workload_kind");
    expect(stopCalls).toHaveLength(0);
    expect(lookupSpy.calls).toEqual(["h1"]);
  });

  test("(P5a) ModelRun on another node → 409 workload_node_mismatch", async () => {
    const { res, body, stopCalls } = await postServerStop(
      { w1: modelRunFixture("w1", "agent-1") },
      "w1",
    );
    expect(res.status).toBe(409);
    expect(body.error.message).toBe("workload_node_mismatch");
    expect(stopCalls).toHaveLength(0);
  });

  test("(P5a) multi-node ModelRun → 409 multi_node_workload, zero stop calls", async () => {
    const { res, body, stopCalls } = await postServerStop(
      {
        w1: modelRunFixture("w1", "local", [
          {
            extraArgs: [],
            node: "agent-1",
            rpcHost: "10.0.0.2",
            rpcPort: 50052,
            timeoutSeconds: 30,
          },
        ]),
      },
      "w1",
    );
    expect(res.status).toBe(409);
    expect(body.error.message).toBe("multi_node_workload");
    expect(stopCalls).toHaveLength(0);
  });

  test("(P5a) single-node ModelRun on the request node → exactly one stop call", async () => {
    const { res, body, lookupSpy, stopCalls } = await postServerStop(
      { w1: modelRunFixture("w1", "local") },
      "w1",
    );
    expect(res.status).toBe(200);
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]?.input).toEqual({ workload: "w1", graceSeconds: 5 });
    expect(stopCalls[0]?.ctx).toEqual({ node: "local" });
    expect(body.result.data).toEqual({ stopped: true });
    expect(lookupSpy.calls).toEqual(["w1"]);
  });

  test("(P5a) stopped:false passes through the projection unchanged", async () => {
    const { res, body, stopCalls } = await postServerStop(
      { w1: modelRunFixture("w1", "local") },
      "w1",
      { ...spyFixtures(), serverStop: { stopped: false, pid: 4242, killed: false } },
    );
    expect(res.status).toBe(200);
    expect(body.result.data).toEqual({ stopped: false, pid: 4242, killed: false });
    expect(stopCalls).toHaveLength(1);
  });

  test("(P5a) GET batch serverStatus,serverStop → METHOD_NOT_SUPPORTED, zero stop calls", async () => {
    const r = api();
    const spy = makeSpyBackend(spyFixtures());
    const lookupSpy = makeLookupSpy({ w1: modelRunFixture("w1", "local") });
    const h = await startConsole(r, {
      backend: spy.router,
      distPath: consoleTestFixture().distPath,
      lookupWorkload: lookupSpy.lookup,
    });
    const res = await fetch(
      trpcUrl(h, "serverStatus,serverStop", {
        batch: true,
        input: { "0": { workload: "w1" }, "1": { workload: "w1", graceSeconds: 5 } },
      }),
      { headers: apiHeaders(h) },
    );
    const body = await res.json();
    expect(body).not.toEqual({ error: "procedure_not_exposed" });
    const rows = body as { error?: { data?: { code?: string } } }[];
    expect(rows).toHaveLength(2);
    expect(rows[1]?.error?.data?.code).toBe("METHOD_NOT_SUPPORTED");
    expect(spy.calls.filter((c) => c.path === "serverStop")).toHaveLength(0);
  });

  test("(P5a) path-traversal workload name → 400 bad_input before the lookup", async () => {
    const { res, body, lookupSpy, stopCalls } = await postServerStop(
      { "../x": modelRunFixture("x", "local") },
      "../x",
    );
    expect(res.status).toBe(400);
    expect(body.error.message).toBe("bad_input");
    expect(stopCalls).toHaveLength(0);
    expect(lookupSpy.calls).toEqual([]);
  });
});
