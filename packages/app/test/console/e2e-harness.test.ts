// packages/app/test/console/e2e-harness.test.ts
// Issue frozename/llamactl#410 (plan P5b part 1) — Bun-side contract
// for the Playwright e2e harness. packages/app/bunfig.toml must keep
// e2e specs out of `bun test`; e2e/harness/{serve.ts,
// fixture-backend.ts,fixtures/seed.ts} must exist; the fixture
// backend must expose exactly the CONSOLE_ALLOWLIST procedures; and
// startFixtureConsole must boot the REAL console server — Host /
// same-origin / session guards, the procedure allowlist, response
// projections and the serverStop precheck — over the fixture backend,
// plus a loopback control server that records calls per node and
// drives reachability flips, serverStop modes, log emit/drop and
// stream state. Every case fails by assertion at the base commit —
// never by import error — through the existsSync-then-dynamic-import
// pattern from web-entry.test.ts. No real network beyond loopback,
// no processes, no sleeps: every wait is a bounded poll of at most
// 2 s, and env/temp state is restored in afterEach.

import { CONSOLE_ALLOWLIST } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { E2E_KUBECONFIG_YAML } from "../../e2e/harness/fixtures/seed.js";
import { logsSubscriptionInput } from "../../src/console/logs-scope.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

const APP_DIR = join(import.meta.dir, "..", "..");
const BUNFIG = join(APP_DIR, "bunfig.toml");
const HARNESS = join(APP_DIR, "e2e", "harness", "serve.ts");
const BACKEND = join(APP_DIR, "e2e", "harness", "fixture-backend.ts");
const SEED = join(APP_DIR, "e2e", "harness", "fixtures", "seed.ts");

const INDEX_HTML = '<!doctype html><html><body><div id="root">e2e fixture</div></body></html>\n';

const SENTINEL_VALUES = [
  "sentinel-arg",
  "sentinel-bearer",
  "sentinel-cli",
  "sentinel-hf",
  "sentinel-kube",
  "sentinel-lm",
  "sentinel-log",
  "sentinel-pg",
];

interface FixtureHarness {
  console: { url: string };
  control: { hostname: string; url: string };
  stop: () => Promise<void>;
}

type StartFixtureConsole = (opts: {
  controlPort: number;
  distPath: string;
  port: number;
}) => Promise<FixtureHarness>;

interface ServeModule {
  startFixtureConsole?: StartFixtureConsole;
}

interface FixtureBackendModule {
  createFixtureBackend?: () => {
    router: { _def: { procedures: Record<string, unknown> } };
  };
}

interface SeedModule {
  E2E_SENTINEL_VALUES?: readonly string[];
}

interface ConsoleHandle {
  apiBase: string;
  controlBase: string;
  cookie: string;
  port: string;
}

interface QueryResult {
  json: unknown;
  res: Response;
  text: string;
}

interface QueryOpts {
  headers?: Record<string, string>;
  input?: unknown;
  signal?: AbortSignal;
}

interface RecordedCall {
  input: unknown;
  node: string;
  procedure: string;
}

interface StreamEntry {
  node: string;
  open?: boolean;
  workload: string;
}

const tempDirs: string[] = [];
const harnesses: FixtureHarness[] = [];
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeDistDir(): string {
  const dir = makeTempDir("llamactl-e2e-dist-");
  writeFileSync(join(dir, "index.html"), INDEX_HTML);
  return dir;
}

beforeEach(() => {
  const cfgDir = makeTempDir("llamactl-e2e-cfg-");
  writeFileSync(join(cfgDir, "config"), E2E_KUBECONFIG_YAML);
  setEnv("LLAMACTL_CONFIG", join(cfgDir, "config"));
  setEnv("DEV_STORAGE", makeTempDir("llamactl-e2e-dev-"));
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.stop().catch(() => undefined);
  }
  for (const [key, value] of savedEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function sessionCookie(res: Response): string {
  for (const line of res.headers.getAll("set-cookie")) {
    const pair = (line.split(";", 1)[0] ?? "").trim();
    const eq = pair.indexOf("=");
    const name = eq > 0 ? pair.slice(0, eq).trim() : "";
    if (name.startsWith("llamactl_console_")) return pair;
  }
  return "";
}

async function loadServeModule(): Promise<ServeModule> {
  return (await import(pathToFileURL(HARNESS).href)) as ServeModule;
}

async function startHarness(): Promise<ConsoleHandle> {
  const mod = await loadServeModule();
  const start = mod.startFixtureConsole;
  expect(typeof start).toBe("function");
  const harness = await start!({ controlPort: 0, distPath: makeDistDir(), port: 0 });
  harnesses.push(harness);
  expect(harness.console).toBeDefined();
  expect(harness.control).toBeDefined();
  expect(harness.control.hostname).toBe("127.0.0.1");
  expect(typeof harness.stop).toBe("function");
  const apiBase = stripTrailingSlash(harness.console.url);
  const controlBase = stripTrailingSlash(harness.control.url);
  const port = new URL(apiBase).port;
  expect(port).not.toBe("");
  const index = await fetch(`${apiBase}/`);
  return { apiBase, controlBase, cookie: sessionCookie(index), port };
}

function trpcUrl(
  h: ConsoleHandle,
  node: string,
  procPath: string,
  params: Record<string, string> = {},
): string {
  const qs = new URLSearchParams(params).toString();
  return `${h.apiBase}/api/n/${node}/trpc/${procPath}${qs === "" ? "" : `?${qs}`}`;
}

function trpcQueryUrl(h: ConsoleHandle, node: string, proc: string, input?: unknown): string {
  return trpcUrl(h, node, proc, input === undefined ? {} : { input: JSON.stringify(input) });
}

function apiHeaders(
  h: ConsoleHandle,
  opts: { cookie?: string; extra?: Record<string, string> } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    host: `127.0.0.1:${h.port}`,
    "sec-fetch-site": "same-origin",
  };
  const cookie = opts.cookie ?? h.cookie;
  if (cookie !== "") headers["cookie"] = cookie;
  return { ...headers, ...(opts.extra ?? {}) };
}

function mutationHeaders(h: ConsoleHandle): Record<string, string> {
  return apiHeaders(h, {
    extra: {
      "content-type": "application/json",
      origin: `http://127.0.0.1:${h.port}`,
    },
  });
}

function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function getQuery(
  h: ConsoleHandle,
  node: string,
  proc: string,
  opts: QueryOpts = {},
): Promise<QueryResult> {
  const res = await fetch(trpcQueryUrl(h, node, proc, opts.input), {
    headers: { ...apiHeaders(h), ...(opts.headers ?? {}) },
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
  const text = await res.text();
  return { json: parseJsonSafe(text), res, text };
}

async function postTrpc(
  h: ConsoleHandle,
  node: string,
  proc: string,
  input: unknown,
): Promise<QueryResult> {
  const res = await fetch(trpcUrl(h, node, proc), {
    body: JSON.stringify(input),
    headers: mutationHeaders(h),
    method: "POST",
  });
  const text = await res.text();
  return { json: parseJsonSafe(text), res, text };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function dig(value: unknown, ...path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    const record = asRecord(current);
    if (record === null) return undefined;
    current = record[key];
  }
  return current;
}

async function controlGet(h: ConsoleHandle, path: string): Promise<unknown> {
  const res = await fetch(`${h.controlBase}${path}`);
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  return body;
}

async function postControl(h: ConsoleHandle, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${h.controlBase}${path}`, init);
  expect(res.ok).toBe(true);
  return res;
}

function listField(body: unknown, key: string): unknown[] {
  if (Array.isArray(body)) return body as unknown[];
  const record = asRecord(body);
  const value = record?.[key];
  return Array.isArray(value) ? (value as unknown[]) : [];
}

async function controlCalls(h: ConsoleHandle, node: string): Promise<RecordedCall[]> {
  const body = await controlGet(h, `/calls?node=${encodeURIComponent(node)}`);
  return listField(body, "calls") as RecordedCall[];
}

async function controlStreams(h: ConsoleHandle, node: string): Promise<StreamEntry[]> {
  const body = await controlGet(h, `/streams?node=${encodeURIComponent(node)}`);
  return listField(body, "streams") as StreamEntry[];
}

function streamIsOpen(entry: StreamEntry, workload: string): boolean {
  return entry.workload === workload && entry.open !== false;
}

async function pollUntil(cond: () => Promise<boolean>, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 15);
    });
  }
}

async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(
          () => {
            resolve(null);
          },
          Math.max(1, ms),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function sseEventName(frame: string): string {
  const line = frame.split("\n").find((entry) => entry.startsWith("event:"));
  return line === undefined ? "message" : line.slice("event:".length).trim();
}

function drainFrames(buf: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buf;
  for (;;) {
    const cut = rest.indexOf("\n\n");
    if (cut < 0) break;
    const frame = rest.slice(0, cut);
    rest = rest.slice(cut + 2);
    const event = sseEventName(frame);
    if (event !== "connected" && event !== "ping") frames.push(frame);
  }
  return { frames, rest };
}

interface SseRead {
  done: boolean;
  found: boolean;
  frames: string[];
  transcript: string;
}

// One reader held across multiple read phases: cancel-on-exit would
// itself tear the subscription down, so a drop assertion needs a
// reader that stays open until close() is called explicitly.
interface SseFrameReader {
  read(until: (frames: readonly string[]) => boolean, deadlineMs: number): Promise<SseRead>;
  readToDone(deadlineMs: number): Promise<boolean>;
  close(): Promise<void>;
}

function createSseFrameReader(res: Response): SseFrameReader {
  const body = res.body;
  const reader = body === null ? null : body.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let pending = "";
  let transcript = "";
  let done = false;

  const loop = async (
    until: (frames: readonly string[]) => boolean,
    deadlineMs: number,
  ): Promise<SseRead> => {
    if (reader === null) return { done: true, found: false, frames, transcript };
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      if (until(frames)) return { done, found: true, frames, transcript };
      const remaining = deadline - Date.now();
      if (remaining <= 0 || done) return { done, found: until(frames), frames, transcript };
      const chunk = await raceTimeout(reader.read(), remaining);
      if (chunk === null) return { done, found: until(frames), frames, transcript };
      if (chunk.done) {
        done = true;
        return { done, found: until(frames), frames, transcript };
      }
      const text = decoder.decode(chunk.value, { stream: true });
      transcript += text;
      pending += text;
      const drained = drainFrames(pending);
      pending = drained.rest;
      frames.push(...drained.frames);
    }
  };

  return {
    close: async (): Promise<void> => {
      if (reader === null) return;
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    },
    read: loop,
    readToDone: async (deadlineMs: number): Promise<boolean> =>
      (await loop(() => false, deadlineMs)).done,
  };
}

function expectHarnessModules(): void {
  expect(existsSync(HARNESS)).toBe(true);
  expect(existsSync(BACKEND)).toBe(true);
  expect(existsSync(SEED)).toBe(true);
}

describe("e2e harness contract (#410 P5b)", () => {
  test("bunfig.toml roots bun test at test/ so e2e specs stay out", () => {
    const text = existsSync(BUNFIG) ? readFileSync(BUNFIG, "utf8") : "";
    expect(text).toMatch(/\[test\][^[]*\broot\s*=\s*"(?:\.\/)?test"/);
  });

  test("the fixture backend exposes exactly the console allowlist", async () => {
    expect(existsSync(BACKEND)).toBe(true);
    const mod = (await import(pathToFileURL(BACKEND).href)) as FixtureBackendModule;
    const create = mod.createFixtureBackend;
    expect(typeof create).toBe("function");
    const backend = create!();
    const names = Object.keys(backend.router._def.procedures).sort();
    expect(names).toEqual(Object.keys(CONSOLE_ALLOWLIST).sort());
  });

  test("the real console server over the fixture masks every P2b sentinel", async () => {
    expectHarnessModules();
    const h = await startHarness();
    const queries: { id: string; input?: unknown; proc: string }[] = [
      { id: "env", proc: "env" },
      { id: "nodeFacts", proc: "nodeFacts" },
      { id: "nodeList", proc: "nodeList" },
      { id: "nodeTest", input: { name: "agent-1" }, proc: "nodeTest" },
      { id: "status-wA", input: { workload: "wA" }, proc: "serverStatus" },
      { id: "status-wB", input: { workload: "wB" }, proc: "serverStatus" },
      { id: "describe-wB", input: { name: "wB" }, proc: "workloadDescribe" },
      { id: "workloadList", proc: "workloadList" },
      { id: "workloadsDir", proc: "workloadsDir" },
    ];
    const texts = new Map<string, string>();
    const bodies: string[] = [];
    for (const q of queries) {
      const result = await getQuery(h, "local", q.proc, { input: q.input });
      expect(result.res.status).toBe(200);
      texts.set(q.id, result.text);
      bodies.push(result.text);
    }
    const mod = (await import(pathToFileURL(SEED).href)) as SeedModule;
    const sentinels = mod.E2E_SENTINEL_VALUES;
    expect(sentinels).toBeDefined();
    expect([...(sentinels ?? [])].sort()).toEqual(SENTINEL_VALUES);
    const all = bodies.join("\n");
    for (const sentinel of sentinels ?? []) {
      expect(all).not.toContain(sentinel);
    }
    const nodeList = parseJsonSafe(texts.get("nodeList") ?? "");
    const listData = dig(nodeList, "result", "data");
    const nodeRows = Array.isArray(listData) ? listData : dig(listData, "nodes");
    expect(Array.isArray(nodeRows)).toBe(true);
    const names = (nodeRows as unknown[])
      .map((row) => dig(row, "name"))
      .filter((name): name is string => typeof name === "string")
      .sort();
    expect(names).toEqual(["agent-1", "agent-off", "gw-1", "local", "ragdb"]);
    const env = parseJsonSafe(texts.get("env") ?? "");
    expect(dig(env, "result", "data", "LM_API_TOKEN")).toBe("[redacted]");
    expect(texts.get("status-wB") ?? "").toContain("[redacted]");
  }, 30_000);

  test("guard order: session then same-origin then allowlist, batch-aware", async () => {
    expectHarnessModules();
    const h = await startHarness();
    const target = trpcUrl(h, "local", "workloadApply");
    const exposed = await fetch(target, { headers: apiHeaders(h) });
    expect(exposed.status).toBe(404);
    expect(await exposed.text()).toContain("procedure_not_exposed");
    const noCookie = await fetch(target, { headers: apiHeaders(h, { cookie: "" }) });
    expect(noCookie.status).toBe(401);
    expect(await noCookie.text()).toContain("invalid_session");
    const crossSite = await fetch(target, {
      headers: apiHeaders(h, {
        extra: { "sec-fetch-site": "cross-site", origin: "http://evil.example" },
      }),
    });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.text()).toContain("cross_site_request_forbidden");
    const before = (await controlCalls(h, "local")).filter(
      (call) => call.procedure === "nodeList",
    ).length;
    const batch = await fetch(
      trpcUrl(h, "local", "nodeList,workloadApply", { batch: "1", input: "{}" }),
      { headers: apiHeaders(h) },
    );
    expect(batch.status).toBe(404);
    expect(await batch.text()).toContain("procedure_not_exposed");
    const after = (await controlCalls(h, "local")).filter(
      (call) => call.procedure === "nodeList",
    ).length;
    expect(after).toBe(before);
  }, 30_000);

  test("the fixture records calls per node", async () => {
    expectHarnessModules();
    const h = await startHarness();
    const res = await getQuery(h, "agent-1", "workloadList");
    expect(res.res.status).toBe(200);
    const agentCalls = await controlCalls(h, "agent-1");
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0]?.procedure).toBe("workloadList");
    expect(agentCalls[0]?.node).toBe("agent-1");
    const localCalls = await controlCalls(h, "local");
    expect(localCalls.filter((call) => call.procedure === "workloadList")).toHaveLength(0);
  }, 30_000);

  test("reachability control flips nodeTest results", async () => {
    expectHarnessModules();
    const h = await startHarness();
    const nodeTestOk = async (name: string): Promise<unknown> => {
      const result = await getQuery(h, "local", "nodeTest", {
        input: { name },
        signal: AbortSignal.timeout(2000),
      });
      expect(result.res.status).toBe(200);
      return dig(result.json, "result", "data", "ok");
    };
    expect(await nodeTestOk("agent-off")).toBe(false);
    expect(await nodeTestOk("agent-1")).toBe(true);
    await postControl(h, "/reachability", { node: "agent-1", reachable: false });
    expect(await nodeTestOk("agent-1")).toBe(false);
    await postControl(h, "/reset", {});
    expect(await nodeTestOk("agent-1")).toBe(true);
  }, 30_000);

  test("serverStop modes and the workload precheck through the real console", async () => {
    expectHarnessModules();
    const h = await startHarness();
    const stop = (workload: string): Promise<QueryResult> =>
      postTrpc(h, "agent-1", "serverStop", { graceSeconds: 5, workload });
    const first = await stop("wB");
    expect(first.res.status).toBe(200);
    expect(dig(first.json, "result", "data", "stopped")).toBe(true);
    await postControl(h, "/server-stop-mode", { mode: "not-stopped" });
    const second = await stop("wB");
    expect(second.res.status).toBe(200);
    expect(dig(second.json, "result", "data", "stopped")).toBe(false);
    expect(dig(second.json, "result", "data", "pid")).toBe(4242);
    await postControl(h, "/server-stop-mode", { mode: "throw" });
    const third = await stop("wB");
    expect(third.res.status).toBe(500);
    const forged = await stop("wA");
    expect(forged.res.status).toBe(409);
    expect(forged.text).toContain("workload_node_mismatch");
    const multi = await stop("wMulti");
    expect(multi.res.status).toBe(409);
    expect(multi.text).toContain("multi_node_workload");
    const agentStops = (await controlCalls(h, "agent-1")).filter(
      (call) => call.procedure === "serverStop",
    );
    expect(agentStops).toHaveLength(3);
    for (const call of agentStops) {
      expect(call.input).toEqual({ graceSeconds: 5, workload: "wB" });
    }
    const localStops = (await controlCalls(h, "local")).filter(
      (call) => call.procedure === "serverStop",
    );
    expect(localStops).toHaveLength(0);
  }, 30_000);

  test("serverLogs streams masked lines and honors drop-stream", async () => {
    expectHarnessModules();
    const h = await startHarness();
    const input = logsSubscriptionInput("wB");
    const sseUrl = trpcUrl(h, "agent-1", "serverLogs", {
      input: JSON.stringify(input),
    });
    const sse = await fetch(sseUrl, {
      headers: apiHeaders(h, { extra: { accept: "text/event-stream" } }),
    });
    expect(sse.status).toBe(200);
    const open = await pollUntil(async () => {
      const streams = await controlStreams(h, "agent-1");
      return streams.some((entry) => streamIsOpen(entry, "wB"));
    }, 2000);
    expect(open).toBe(true);
    await postControl(h, "/emit-log", {
      line: "--api-key sentinel-log e2e-mark-7",
      node: "agent-1",
      workload: "wB",
    });
    const reader = createSseFrameReader(sse);
    const read = await reader.read(
      (frames) => frames.some((frame) => frame.includes("e2e-mark-7")),
      2000,
    );
    expect(read.found).toBe(true);
    expect(
      read.frames.some((frame) => frame.includes("e2e-mark-7") && frame.includes("[redacted]")),
    ).toBe(true);
    for (const frame of read.frames) {
      expect(frame).not.toContain("sentinel-log");
      expect(frame).not.toContain("sentinel-bearer");
    }
    // Reader never cancelled: a still-open control entry here proves
    // the close below can only come from the drop itself.
    const streamsBeforeDrop = await controlStreams(h, "agent-1");
    expect(streamsBeforeDrop.some((entry) => streamIsOpen(entry, "wB"))).toBe(true);
    await postControl(h, "/drop-stream", { node: "agent-1", workload: "wB" });
    expect(await reader.readToDone(2000)).toBe(true);
    await reader.close();
    const closed = await pollUntil(async () => {
      const streams = await controlStreams(h, "agent-1");
      return !streams.some((entry) => streamIsOpen(entry, "wB"));
    }, 2000);
    expect(closed).toBe(true);
  }, 30_000);

  test("unsetting LLAMACTL_CONFIG + DEV_STORAGE: temp kubeconfig in, env restored, temp dir gone", async () => {
    expectHarnessModules();
    Reflect.deleteProperty(process.env, "LLAMACTL_CONFIG");
    Reflect.deleteProperty(process.env, "DEV_STORAGE");
    const mod = await loadServeModule();
    const start = mod.startFixtureConsole;
    expect(typeof start).toBe("function");
    const harness = await start!({ controlPort: 0, distPath: makeDistDir(), port: 0 });
    harnesses.push(harness);
    const configPath = process.env["LLAMACTL_CONFIG"];
    expect(typeof configPath).toBe("string");
    expect(existsSync(configPath ?? "")).toBe(true);
    const tempDir = dirname(configPath ?? "");
    expect(existsSync(tempDir)).toBe(true);
    const index = await fetch(stripTrailingSlash(harness.console.url));
    expect(index.status).toBe(200);
    await harness.stop();
    expect(process.env["LLAMACTL_CONFIG"]).toBeUndefined();
    expect(process.env["DEV_STORAGE"]).toBeUndefined();
    expect(existsSync(tempDir)).toBe(false);
  }, 30_000);
});
