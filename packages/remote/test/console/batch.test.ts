/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- RED contract tests for #410 P2b: the console surface is an inert 501 stub, so every test reaches it through the untyped `api()` shim and fails on its expects rather than on an import error or a TypeError. */
// Issue frozename/llamactl#410 (plan P2b, §0.12) — the deny-by-default
// procedure allowlist. Single paths outside the list → 404
// procedure_not_exposed (R6), the allowlist snapshot pins the 9
// read-only entries (R6), and tRPC's comma-batching cannot smuggle a
// non-allowlisted segment through: the guard decodes %2C, splits on
// every comma, rejects empty/duplicate segments and >16 segments with
// 400 bad_batch BEFORE checking membership (R7).

import { afterEach, describe, expect, test } from "bun:test";

import * as remote from "../../src/index.js";
import {
  apiHeaders,
  cleanupConsoleTest,
  consoleTestFixture,
  makeSpyBackend,
  spyFixtures,
  startConsole,
  trpcUrl,
} from "./helpers.js";

function api(): any {
  expect(typeof remote.startConsoleServer).toBe("function");
  expect(typeof remote.buildConsoleRouter).toBe("function");
  expect(remote.CONSOLE_ALLOWLIST).toBeDefined();
  expect(typeof remote.checkConsoleTrpcPath).toBe("function");
  return remote as any;
}

const ALLOWED = [
  "env",
  "nodeList",
  "nodeTest",
  "nodeFacts",
  "serverStatus",
  "workloadList",
  "workloadDescribe",
  "workloadsDir",
  "serverLogs",
];

const HIDDEN: { name: string; method: "GET" | "POST"; input?: unknown }[] = [
  { input: { target: "m.gguf" }, method: "POST", name: "keepAliveStart" },
  { input: { file: "f.gguf", repo: "r" }, method: "GET", name: "pullFile" },
  { input: { name: "n1" }, method: "GET", name: "nodeOpenAIConfig" },
  { input: {}, method: "POST", name: "reconcilerStart" },
  { method: "GET", name: "uiPickDirectory" },
  { input: { graceSeconds: 5, workload: "w1" }, method: "POST", name: "serverStop" },
];

afterEach(async () => {
  await cleanupConsoleTest();
});

describe("console allowlist", () => {
  for (const c of HIDDEN) {
    test(`(R6) single path ${c.name} → 404 procedure_not_exposed`, async () => {
      const r = api();
      const spy = makeSpyBackend(spyFixtures());
      const h = await startConsole(r, {
        distPath: consoleTestFixture().distPath,
        backend: spy.router,
      });
      const init: RequestInit = { headers: apiHeaders(h), method: c.method };
      if (c.method === "POST") {
        init.body = JSON.stringify(c.input ?? null);
        (init.headers as Record<string, string>)["content-type"] = "application/json";
      }
      const res = await fetch(
        trpcUrl(h, c.name, c.method === "GET" && c.input !== undefined ? { input: c.input } : {}),
        init,
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "procedure_not_exposed" });
      expect(spy.calls).toEqual([]);
    });
  }

  test("(R6) CONSOLE_ALLOWLIST is exactly the 9 read-only entries, each with a project fn", () => {
    const r = api();
    const allowlist = r.CONSOLE_ALLOWLIST as Record<string, { type?: string; project?: unknown }>;
    const names = Object.keys(allowlist).sort();
    expect(names).toEqual([...ALLOWED].sort());
    const mutations = Object.entries(allowlist)
      .filter(([, entry]) => entry.type === "mutation")
      .map(([name]) => name);
    expect(mutations).toEqual([]);
    const subscriptions = Object.entries(allowlist)
      .filter(([, entry]) => entry.type === "subscription")
      .map(([name]) => name);
    expect(subscriptions).toEqual(["serverLogs"]);
    for (const name of ALLOWED) {
      expect(typeof allowlist[name]?.project).toBe("function");
    }
  });
});

describe("console batch guard", () => {
  test("(R7) GET serverStatus,keepAliveStart?batch=1 → 404 and neither side runs", async () => {
    const r = api();
    const spy = makeSpyBackend(spyFixtures());
    const h = await startConsole(r, {
      distPath: consoleTestFixture().distPath,
      backend: spy.router,
    });
    const res = await fetch(
      trpcUrl(h, "serverStatus,keepAliveStart", {
        batch: true,
        input: { "0": { workload: "w1" }, "1": { target: "t" } },
      }),
      { headers: apiHeaders(h) },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "procedure_not_exposed" });
    expect(spy.calls).toEqual([]);
  });

  test("(R7) POST workloadList,nodeOpenAIConfig?batch=1 → 404", async () => {
    const r = api();
    const spy = makeSpyBackend(spyFixtures());
    const h = await startConsole(r, {
      distPath: consoleTestFixture().distPath,
      backend: spy.router,
    });
    const res = await fetch(trpcUrl(h, "workloadList,nodeOpenAIConfig", { batch: true }), {
      body: JSON.stringify({ "0": null, "1": { name: "x" } }),
      headers: apiHeaders(h, { "content-type": "application/json" }),
      method: "POST",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "procedure_not_exposed" });
    expect(spy.calls).toEqual([]);
  });

  test("(R7) a %2C-encoded batch separator is decoded before the allowlist check", async () => {
    const r = api();
    const spy = makeSpyBackend(spyFixtures());
    const h = await startConsole(r, {
      distPath: consoleTestFixture().distPath,
      backend: spy.router,
    });
    const res = await fetch(
      trpcUrl(h, "workloadList%2CnodeOpenAIConfig", {
        batch: true,
        input: { "0": null, "1": { name: "x" } },
      }),
      { headers: apiHeaders(h) },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "procedure_not_exposed" });
    expect(spy.calls).toEqual([]);
  });

  for (const path of ["nodeList,,env", ",env", "env,", "env,env"]) {
    test(`(R7) "${path}" → 400 bad_batch`, async () => {
      const r = api();
      const spy = makeSpyBackend(spyFixtures());
      const h = await startConsole(r, {
        distPath: consoleTestFixture().distPath,
        backend: spy.router,
      });
      const res = await fetch(trpcUrl(h, path, { batch: true, input: {} }), {
        headers: apiHeaders(h),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_batch" });
      expect(spy.calls).toEqual([]);
    });
  }

  test("(R7) 17 allowlisted segments (duplicates included) → 400 bad_batch", async () => {
    const r = api();
    const spy = makeSpyBackend(spyFixtures());
    const h = await startConsole(r, {
      distPath: consoleTestFixture().distPath,
      backend: spy.router,
    });
    const segments = [...ALLOWED, ...ALLOWED.slice(0, 8)].join(",");
    expect(segments.split(",")).toHaveLength(17);
    const res = await fetch(trpcUrl(h, segments, { batch: true, input: {} }), {
      headers: apiHeaders(h),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_batch" });
    expect(spy.calls).toEqual([]);
  });

  test("(R7) 17 distinct segments incl. non-allowlisted names → 400 bad_batch, not 404", async () => {
    const r = api();
    const spy = makeSpyBackend(spyFixtures());
    const h = await startConsole(r, {
      distPath: consoleTestFixture().distPath,
      backend: spy.router,
    });
    const segments = [
      ...ALLOWED,
      "keepAliveStart",
      "pullFile",
      "nodeOpenAIConfig",
      "reconcilerStart",
      "uiPickDirectory",
      "serverStop",
      "foo1",
      "foo2",
    ].join(",");
    expect(segments.split(",")).toHaveLength(17);
    const res = await fetch(trpcUrl(h, segments, { batch: true, input: {} }), {
      headers: apiHeaders(h),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_batch" });
    expect(spy.calls).toEqual([]);
  });

  test("(R7) GET nodeList,env,workloadList?batch=1 → 200 with every result projected", async () => {
    const r = api();
    const spy = makeSpyBackend(spyFixtures());
    const h = await startConsole(r, {
      distPath: consoleTestFixture().distPath,
      backend: spy.router,
    });
    const res = await fetch(trpcUrl(h, "nodeList,env,workloadList", { batch: true, input: {} }), {
      headers: apiHeaders(h),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("sentinel");
    const rows = JSON.parse(text) as { result: { data: unknown } }[];
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.result.data).toBeDefined();
    expect(spy.calls.map((c) => c.path)).toEqual(["nodeList", "env", "workloadList"]);
  });
});
