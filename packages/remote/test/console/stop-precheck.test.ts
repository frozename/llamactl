/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- RED contract tests for #410 P5a: the serverStop allowlist entry and its server-side precheck do not exist yet, so every test reaches the console through the untyped `api()` shim and fails on its expects rather than on an import error or a TypeError. */
// Issue frozename/llamactl#410 (plan P5a) — serverStop on the console
// surface with a server-side precheck ahead of the wrapped backend. A
// single-node ModelRun on the request's node produces exactly one
// inner call carrying the caller's input; a missing manifest 404s, a
// ModelHost 409s, a node mismatch 409s and a multi-node ModelRun 409s
// — each before the inner serverStop runs. Names that cannot name a
// manifest are refused 400 bad_input ahead of the lookup seam, and a
// GET batch segment rides tRPC's own METHOD_NOT_SUPPORTED check. The
// lookupWorkload seam is injected so no injected-seam case touches the
// real workloads dir; the default-lookup cases point
// LLAMACTL_WORKLOADS_DIR at a temp dir (restored in a finally) so
// defaultLookupWorkload itself — the not-found-to-null mapping that
// turns a missing manifest into a 404 instead of a path-leaking 500 —
// is exercised against real YAML on disk.

import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/unstable-core-do-not-import";

import { TRPCError } from "@trpc/server";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { stringify } from "yaml";

import { defaultLookupWorkload, serverStopPrecheck } from "../../src/console/allowlist.js";
import * as remote from "../../src/index.js";
import { writeFileSync } from "../../src/safe-fs.js";
import {
  apiHeaders,
  cleanupConsoleTest,
  consoleTestFixture,
  makeLookupSpy,
  makeSpyBackend,
  modelHostFixture,
  modelRunFixture,
  setEnv,
  type SpyCall,
  spyFixtures,
  startConsole,
  tmpDir,
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

interface DefaultLookupResult {
  body: any;
  dir: string;
  res: Response;
  stopCalls: SpyCall[];
  text: string;
}

/**
 * The default-lookup path: no lookupWorkload seam is passed, so the
 * precheck runs defaultLookupWorkload against a temp
 * LLAMACTL_WORKLOADS_DIR (env restored in a finally). The raw body
 * text is returned so cases can assert the absolute workloads dir
 * never reaches the client.
 */
async function postServerStopDefaultLookup(
  workload: string,
  files: Record<string, string> = {},
): Promise<DefaultLookupResult> {
  const dir = tmpDir("llamactl-console-wl-");
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, `${name}.yaml`), text);
  }
  const previous = process.env["LLAMACTL_WORKLOADS_DIR"];
  process.env["LLAMACTL_WORKLOADS_DIR"] = dir;
  try {
    const r = api();
    const spy = makeSpyBackend(spyFixtures());
    const h = await startConsole(r, {
      backend: spy.router,
      distPath: consoleTestFixture().distPath,
    });
    const res = await fetch(trpcUrl(h, "serverStop"), {
      body: JSON.stringify({ workload, graceSeconds: 5 }),
      headers: apiHeaders(h, { "content-type": "application/json" }),
      method: "POST",
    });
    const text = await res.text();
    return {
      body: JSON.parse(text),
      dir,
      res,
      stopCalls: spy.calls.filter((c) => c.path === "serverStop"),
      text,
    };
  } finally {
    if (previous === undefined) delete process.env["LLAMACTL_WORKLOADS_DIR"];
    else process.env["LLAMACTL_WORKLOADS_DIR"] = previous;
  }
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

  test("(P5a) default lookup, missing manifest → 404 workload_not_found, no path leak", async () => {
    const { body, dir, res, stopCalls, text } = await postServerStopDefaultLookup("ghost");
    expect(res.status).toBe(404);
    expect(body.error.message).toBe("workload_not_found");
    expect(stopCalls).toHaveLength(0);
    expect(text).not.toContain(dir);
  });

  test("(P5a) default lookup, ModelHost YAML → 409 unsupported_workload_kind", async () => {
    const host = {
      apiVersion: "llamactl/v1",
      kind: "ModelHost",
      metadata: { name: "host1" },
      spec: {
        binary: "/usr/local/bin/llama-server",
        endpoint: { host: "127.0.0.1", port: 8123 },
        engine: "llamacpp",
        hostedModels: [{ rel: "m.gguf" }],
        node: "local",
      },
    };
    const { body, dir, res, stopCalls, text } = await postServerStopDefaultLookup("host1", {
      host1: stringify(host),
    });
    expect(res.status).toBe(409);
    expect(body.error.message).toBe("unsupported_workload_kind");
    expect(stopCalls).toHaveLength(0);
    expect(text).not.toContain(dir);
  });

  test("(P5a) default lookup, ModelRun YAML on another node → 409 workload_node_mismatch", async () => {
    const { body, dir, res, stopCalls, text } = await postServerStopDefaultLookup("w1", {
      w1: stringify(modelRunFixture("w1", "agent-1")),
    });
    expect(res.status).toBe(409);
    expect(body.error.message).toBe("workload_node_mismatch");
    expect(stopCalls).toHaveLength(0);
    expect(text).not.toContain(dir);
  });

  test("(P5a) default lookup, malformed YAML → 500 workload_lookup_failed, no manifest or path leak", async () => {
    const { body, dir, res, stopCalls, text } = await postServerStopDefaultLookup("w1", {
      w1: "kind: ModelRun\nmetadata: {name: w1}\nspec: {node: local, target: {kind: rel, value:",
    });
    expect(res.status).toBe(500);
    expect(body.error.message).toBe("workload_lookup_failed");
    expect(stopCalls).toHaveLength(0);
    expect(text).not.toContain(dir);
    expect(text).not.toContain("ModelRun");
    expect(text).not.toContain("target");
  });
});

// Unit-level coverage of the same precheck contract: every reject path
// pinned at the serverStopPrecheck boundary itself, so a regression in
// the fixed-message mapping fails in milliseconds instead of hiding
// behind an HTTP boot. The malformed-YAML contract is additionally
// exercised end-to-end through defaultLookupWorkload below.

const LOCAL_NODE = { node: "local" } as const;

function modelRunWithSpec(spec: unknown): Record<string, unknown> {
  return { apiVersion: "llamactl/v1", kind: "ModelRun", metadata: { name: "w1" }, spec };
}

async function capturePrecheck(
  ctx: { node: string | null },
  input: unknown,
  lookupWorkload: (name: string) => unknown,
): Promise<unknown> {
  try {
    await serverStopPrecheck(ctx, input, { lookupWorkload });
    return undefined;
  } catch (err) {
    return err;
  }
}

function expectTrpcError(err: unknown, code: TRPC_ERROR_CODE_KEY, message: string): void {
  if (!(err instanceof TRPCError)) {
    throw new Error(`expected TRPCError(${code}: ${message}), got ${String(err)}`);
  }
  expect(err.code).toBe(code);
  expect(err.message).toBe(message);
}

function throwingLookup(calls: string[], thrown: unknown): (name: string) => unknown {
  return (name: string): unknown => {
    calls.push(name);
    throw thrown;
  };
}

const MALFORMED_YAML =
  "kind: ModelRun\nmetadata: {name: w1}\nspec: {node: local, target: {kind: rel, value:";

const REAL_MODEL_HOST: Record<string, unknown> = {
  apiVersion: "llamactl/v1",
  kind: "ModelHost",
  metadata: { name: "host1" },
  spec: {
    binary: "/usr/local/bin/llama-server",
    endpoint: { host: "127.0.0.1", port: 8123 },
    engine: "llamacpp",
    hostedModels: [{ rel: "m.gguf" }],
    node: "local",
  },
};

const BAD_WORKLOAD_NAMES: readonly string[] = [
  "",
  "-lead",
  ".hidden",
  "a b",
  "a/b",
  "a\\b",
  "../x",
  "..\\x",
  "a:b",
  "a;b",
  "$(cmd)",
  "a|b",
  "a*b",
  "a?b",
  "a[b]",
  "a{b}",
  "café",
  "a\tb",
  "a\nb",
  "a%b",
];

for (const workload of BAD_WORKLOAD_NAMES) {
  test(`(P5a follow-up) workload name ${JSON.stringify(workload)} → bad_input before the lookup`, async () => {
    const spy = makeLookupSpy({ w1: modelRunFixture("w1", "local") });
    const err = await capturePrecheck(LOCAL_NODE, { graceSeconds: 5, workload }, spy.lookup);
    expectTrpcError(err, "BAD_REQUEST", "bad_input");
    expect(spy.calls).toEqual([]);
  });
}

const GOOD_WORKLOAD_NAMES: readonly string[] = ["a", "W9", "x.yaml", "9lives", "a--b..c"];

for (const workload of GOOD_WORKLOAD_NAMES) {
  test(`(P5a follow-up) workload name ${JSON.stringify(workload)} passes the name guard`, async () => {
    const spy = makeLookupSpy({ [workload]: modelRunFixture(workload, "local") });
    const err = await capturePrecheck(LOCAL_NODE, { workload }, spy.lookup);
    expect(err).toBeUndefined();
    expect(spy.calls).toEqual([workload]);
  });
}

const BAD_GRACE_VALUES: readonly unknown[] = [
  0,
  -1,
  -0.5,
  0.5,
  60.5,
  61,
  3600,
  "5",
  true,
  null,
  {},
];

for (const graceSeconds of BAD_GRACE_VALUES) {
  test(`(P5a follow-up) graceSeconds ${JSON.stringify(graceSeconds)} → bad_input before the lookup`, async () => {
    const spy = makeLookupSpy({ w1: modelRunFixture("w1", "local") });
    const err = await capturePrecheck(LOCAL_NODE, { graceSeconds, workload: "w1" }, spy.lookup);
    expectTrpcError(err, "BAD_REQUEST", "bad_input");
    expect(spy.calls).toEqual([]);
  });
}

const GOOD_GRACE_VALUES: readonly unknown[] = [1, 30, 60];

for (const graceSeconds of GOOD_GRACE_VALUES) {
  test(`(P5a follow-up) graceSeconds ${String(graceSeconds)} is accepted and reaches the lookup`, async () => {
    const spy = makeLookupSpy({ w1: modelRunFixture("w1", "local") });
    const err = await capturePrecheck(LOCAL_NODE, { graceSeconds, workload: "w1" }, spy.lookup);
    expect(err).toBeUndefined();
    expect(spy.calls).toEqual(["w1"]);
  });
}

test("(P5a follow-up) omitted graceSeconds is accepted", async () => {
  const spy = makeLookupSpy({ w1: modelRunFixture("w1", "local") });
  const err = await capturePrecheck(LOCAL_NODE, { workload: "w1" }, spy.lookup);
  expect(err).toBeUndefined();
  expect(spy.calls).toEqual(["w1"]);
});

const BAD_INPUT_SHAPES: readonly { label: string; value: unknown }[] = [
  { label: "null", value: null },
  { label: "undefined", value: undefined },
  { label: "bare string", value: "w1" },
  { label: "bare number", value: 7 },
  { label: "bare boolean", value: true },
  { label: "bare array", value: ["w1"] },
  { label: "empty object", value: {} },
  { label: "graceSeconds only", value: { graceSeconds: 5 } },
  { label: "numeric workload", value: { workload: 7 } },
  { label: "null workload", value: { workload: null } },
  { label: "array workload", value: { workload: ["w1"] } },
];

for (const { label, value } of BAD_INPUT_SHAPES) {
  test(`(P5a follow-up) input ${label} → bad_input before the lookup`, async () => {
    const spy = makeLookupSpy({ w1: modelRunFixture("w1", "local") });
    const err = await capturePrecheck(LOCAL_NODE, value, spy.lookup);
    expectTrpcError(err, "BAD_REQUEST", "bad_input");
    expect(spy.calls).toEqual([]);
  });
}

const LOOKUP_FAILURES: readonly { label: string; thrown: unknown }[] = [
  {
    label: "yaml parse error quoting the manifest text",
    thrown: new Error(
      `YAMLException: bad indentation of a mapping entry (3:43)\n${MALFORMED_YAML}`,
    ),
  },
  {
    label: "fs error naming the workloads dir",
    thrown: new Error(
      "EACCES: permission denied, open '/Users/operator/.llamactl/workloads/w1.yaml'",
    ),
  },
  { label: "thrown string", thrown: "SN3NTINEL lookup exploded" },
  { label: "thrown plain object", thrown: { code: "ENOENT", detail: "SN3NTINEL" } },
  {
    label: "thrown TRPCError NOT_FOUND",
    thrown: new TRPCError({
      code: "NOT_FOUND",
      message: "workload manifest not found: /Users/operator/.llamactl/workloads/w1.yaml",
    }),
  },
  {
    label: "TypeError from a broken loader",
    thrown: new TypeError("Cannot read properties of undefined (reading 'kind') in /tmp/loader.ts"),
  },
  {
    label: "schema error quoting a manifest key",
    thrown: new Error('Unrecognized key(s) in object: "unapproved" at metadata'),
  },
  {
    label: "error mimicking the not-found prefix with a trailing detail",
    thrown: new Error("workload manifest not found (plus detail at /Users/operator/w1.yaml)"),
  },
];

for (const { label, thrown } of LOOKUP_FAILURES) {
  test(`(P5a follow-up) lookup failure — ${label} → 500 workload_lookup_failed`, async () => {
    const calls: string[] = [];
    const err = await capturePrecheck(
      LOCAL_NODE,
      { graceSeconds: 5, workload: "w1" },
      throwingLookup(calls, thrown),
    );
    expectTrpcError(err, "INTERNAL_SERVER_ERROR", "workload_lookup_failed");
    expect(calls).toEqual(["w1"]);
  });
}

test("(P5a follow-up) lookup failure message is exactly the fixed code, no snippet or path", async () => {
  const err = await capturePrecheck(
    LOCAL_NODE,
    { graceSeconds: 5, workload: "w1" },
    throwingLookup(
      [],
      new Error(`parse failed near "${MALFORMED_YAML}" under /Users/operator/wl/w1.yaml`),
    ),
  );
  expectTrpcError(err, "INTERNAL_SERVER_ERROR", "workload_lookup_failed");
  if (err instanceof TRPCError) {
    expect(err.message).not.toContain("ModelRun");
    expect(err.message).not.toContain("target");
    expect(err.message).not.toContain("/Users/operator");
  }
});

for (const signal of [null, undefined]) {
  test(`(P5a follow-up) lookup returning ${String(signal)} → NOT_FOUND workload_not_found`, async () => {
    const spy = makeLookupSpy({});
    const err = await capturePrecheck(LOCAL_NODE, { graceSeconds: 5, workload: "ghost" }, () => {
      spy.calls.push("ghost");
      return signal;
    });
    expectTrpcError(err, "NOT_FOUND", "workload_not_found");
    expect(spy.calls).toEqual(["ghost"]);
  });
}

const UNSUPPORTED_KINDS: readonly { label: string; manifest: unknown }[] = [
  { label: "ModelHost", manifest: modelHostFixture("w1", "local") },
  { label: "NodeRun", manifest: { ...modelRunFixture("w1", "local"), kind: "NodeRun" } },
  {
    label: "missing kind",
    manifest: { apiVersion: "llamactl/v1", metadata: { name: "w1" }, spec: { node: "local" } },
  },
  { label: "string manifest", manifest: "kind: ModelRun" },
  { label: "array manifest", manifest: [modelRunFixture("w1", "local")] },
  { label: "number manifest", manifest: 42 },
];

for (const { label, manifest } of UNSUPPORTED_KINDS) {
  test(`(P5a follow-up) ${label} → CONFLICT unsupported_workload_kind`, async () => {
    const err = await capturePrecheck(
      LOCAL_NODE,
      { graceSeconds: 5, workload: "w1" },
      () => manifest,
    );
    expectTrpcError(err, "CONFLICT", "unsupported_workload_kind");
  });
}

const NODE_MISMATCH_CASES: readonly { ctxNode: string | null; label: string; manifest: unknown }[] =
  [
    {
      ctxNode: "local",
      label: "manifest without spec",
      manifest: { apiVersion: "llamactl/v1", kind: "ModelRun", metadata: { name: "w1" } },
    },
    { ctxNode: "local", label: "non-record spec", manifest: modelRunWithSpec("local") },
    {
      ctxNode: "local",
      label: "spec on another node",
      manifest: modelRunWithSpec({ node: "agent-1", workers: [] }),
    },
    {
      ctxNode: null,
      label: "null request node",
      manifest: modelRunWithSpec({ node: "local", workers: [] }),
    },
    {
      ctxNode: "local",
      label: "null spec node",
      manifest: modelRunWithSpec({ node: null, workers: [] }),
    },
  ];

for (const { ctxNode, label, manifest } of NODE_MISMATCH_CASES) {
  test(`(P5a follow-up) ${label} → CONFLICT workload_node_mismatch`, async () => {
    const err = await capturePrecheck(
      { node: ctxNode },
      { graceSeconds: 5, workload: "w1" },
      () => manifest,
    );
    expectTrpcError(err, "CONFLICT", "workload_node_mismatch");
  });
}

const WORKERS_CASES: readonly { accepted: boolean; label: string; workers: unknown }[] = [
  { accepted: true, label: "empty workers array", workers: [] },
  {
    accepted: false,
    label: "one worker",
    workers: [{ extraArgs: [], node: "agent-1", rpcHost: "10.0.0.2", rpcPort: 50052 }],
  },
  { accepted: false, label: "two workers", workers: [{ node: "agent-1" }, { node: "agent-2" }] },
  { accepted: true, label: "non-array workers string", workers: "auto" },
  { accepted: true, label: "non-array workers object", workers: {} },
];

for (const { accepted, label, workers } of WORKERS_CASES) {
  test(`(P5a follow-up) ${label} → ${accepted ? "accept" : "CONFLICT multi_node_workload"}`, async () => {
    const err = await capturePrecheck(LOCAL_NODE, { graceSeconds: 5, workload: "w1" }, () =>
      modelRunWithSpec({ node: "local", workers }),
    );
    if (accepted) {
      expect(err).toBeUndefined();
    } else {
      expectTrpcError(err, "CONFLICT", "multi_node_workload");
    }
  });
}

describe("defaultLookupWorkload", () => {
  test("(P5a follow-up) missing manifest maps to null, not to a path-bearing error", () => {
    setEnv("LLAMACTL_WORKLOADS_DIR", tmpDir("llamactl-default-lookup-"));
    expect(defaultLookupWorkload("ghost")).toBeNull();
  });

  test("(P5a follow-up) malformed YAML is rethrown raw by the seam", () => {
    const dir = tmpDir("llamactl-default-lookup-");
    writeFileSync(join(dir, "w1.yaml"), MALFORMED_YAML);
    setEnv("LLAMACTL_WORKLOADS_DIR", dir);
    expect(() => defaultLookupWorkload("w1")).toThrow();
  });

  test("(P5a follow-up) valid ModelRun YAML returns the parsed manifest", () => {
    const dir = tmpDir("llamactl-default-lookup-");
    writeFileSync(join(dir, "w1.yaml"), stringify(modelRunFixture("w1", "local")));
    setEnv("LLAMACTL_WORKLOADS_DIR", dir);
    expect(JSON.stringify(defaultLookupWorkload("w1"))).toContain("ModelRun");
  });

  test("(P5a follow-up) valid ModelHost YAML returns the parsed manifest", () => {
    const dir = tmpDir("llamactl-default-lookup-");
    writeFileSync(join(dir, "host1.yaml"), stringify(REAL_MODEL_HOST));
    setEnv("LLAMACTL_WORKLOADS_DIR", dir);
    expect(JSON.stringify(defaultLookupWorkload("host1"))).toContain("ModelHost");
  });

  test("(P5a follow-up) traversal name is refused, not mapped to null", () => {
    setEnv("LLAMACTL_WORKLOADS_DIR", tmpDir("llamactl-default-lookup-"));
    expect(() => defaultLookupWorkload("../escape")).toThrow();
  });

  test("(P5a follow-up) precheck over the default seam, malformed YAML → fixed message", async () => {
    const dir = tmpDir("llamactl-console-default-");
    writeFileSync(join(dir, "w1.yaml"), MALFORMED_YAML);
    setEnv("LLAMACTL_WORKLOADS_DIR", dir);
    const err = await capturePrecheck(
      LOCAL_NODE,
      { graceSeconds: 5, workload: "w1" },
      defaultLookupWorkload,
    );
    expectTrpcError(err, "INTERNAL_SERVER_ERROR", "workload_lookup_failed");
  });

  test("(P5a follow-up) precheck over the default seam, missing manifest → NOT_FOUND without the dir", async () => {
    const dir = tmpDir("llamactl-console-default-");
    setEnv("LLAMACTL_WORKLOADS_DIR", dir);
    const err = await capturePrecheck(
      LOCAL_NODE,
      { graceSeconds: 5, workload: "ghost" },
      defaultLookupWorkload,
    );
    expectTrpcError(err, "NOT_FOUND", "workload_not_found");
  });

  test("(P5a follow-up) precheck over the default seam, ModelHost YAML → CONFLICT", async () => {
    const dir = tmpDir("llamactl-console-default-");
    writeFileSync(join(dir, "host1.yaml"), stringify(REAL_MODEL_HOST));
    setEnv("LLAMACTL_WORKLOADS_DIR", dir);
    const err = await capturePrecheck(
      LOCAL_NODE,
      { graceSeconds: 5, workload: "host1" },
      defaultLookupWorkload,
    );
    expectTrpcError(err, "CONFLICT", "unsupported_workload_kind");
  });
});

describe("console serverStop precheck over HTTP (follow-up)", () => {
  test("(P5a follow-up) HTTP lookup throws → 500 workload_lookup_failed, no snippet or path leak", async () => {
    const r = api();
    const spy = makeSpyBackend(spyFixtures());
    const lookupCalls: string[] = [];
    const h = await startConsole(r, {
      backend: spy.router,
      distPath: consoleTestFixture().distPath,
      lookupWorkload: throwingLookup(
        lookupCalls,
        new Error(
          `YAMLException: bad indentation near "${MALFORMED_YAML}" at /var/folders/SN3NTINELDIR/w1.yaml`,
        ),
      ),
    });
    const res = await fetch(trpcUrl(h, "serverStop"), {
      body: JSON.stringify({ workload: "w1", graceSeconds: 5 }),
      headers: apiHeaders(h, { "content-type": "application/json" }),
      method: "POST",
    });
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).toContain('"workload_lookup_failed"');
    expect(text).not.toContain("SN3NTINELDIR");
    expect(text).not.toContain("ModelRun");
    expect(text).not.toContain("target");
    expect(lookupCalls).toEqual(["w1"]);
    expect(spy.calls.filter((c) => c.path === "serverStop")).toHaveLength(0);
  });

  test("(P5a follow-up) HTTP graceSeconds 61 → 400 bad_input, lookup untouched, zero stop calls", async () => {
    const r = api();
    const spy = makeSpyBackend(spyFixtures());
    const lookupSpy = makeLookupSpy({ w1: modelRunFixture("w1", "local") });
    const h = await startConsole(r, {
      backend: spy.router,
      distPath: consoleTestFixture().distPath,
      lookupWorkload: lookupSpy.lookup,
    });
    const res = await fetch(trpcUrl(h, "serverStop"), {
      body: JSON.stringify({ workload: "w1", graceSeconds: 61 }),
      headers: apiHeaders(h, { "content-type": "application/json" }),
      method: "POST",
    });
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).toContain('"bad_input"');
    expect(lookupSpy.calls).toEqual([]);
    expect(spy.calls.filter((c) => c.path === "serverStop")).toHaveLength(0);
  });

  test("(P5a follow-up) HTTP omitted graceSeconds on a valid manifest → one stop call", async () => {
    const r = api();
    const spy = makeSpyBackend(spyFixtures());
    const lookupSpy = makeLookupSpy({ w1: modelRunFixture("w1", "local") });
    const h = await startConsole(r, {
      backend: spy.router,
      distPath: consoleTestFixture().distPath,
      lookupWorkload: lookupSpy.lookup,
    });
    const res = await fetch(trpcUrl(h, "serverStop"), {
      body: JSON.stringify({ workload: "w1" }),
      headers: apiHeaders(h, { "content-type": "application/json" }),
      method: "POST",
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain('"stopped":true');
    const stopCalls = spy.calls.filter((c) => c.path === "serverStop");
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]?.input).toEqual({ workload: "w1" });
  });
});
