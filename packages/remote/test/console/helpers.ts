// Shared fixtures + harness for the #410 P2b console RED tests: a spy
// tRPC backend that records ctx/input per call, kubeconfig + dist
// writers under per-test temp dirs, and the bounded HTTP/SSE readers
// the guard and teardown cases wait on. Env vars touched through
// `setEnv`, started servers and temp dirs are all restored/removed by
// `cleanupConsoleTest()` from each suite's afterEach — nothing here
// touches live operator state.

import type { AnyProcedure } from "@trpc/server/unstable-core-do-not-import";

import { initTRPC } from "@trpc/server";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { z } from "zod";

import { mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

export const INDEX_HTML =
  '<!doctype html><html><body><div id="root">console fixture</div></body></html>\n';

export const SENTINELS = {
  adv: "sentinel-adv",
  arg: "sentinel-arg",
  bearer: "sentinel-bearer",
  cli: "sentinel-cli",
  cloud: "sentinel-cloud",
  dsn: "sentinel-dsn",
  ep: "sentinel-ep",
  facts: "sentinel-facts",
  fu: "sentinel-fu",
  hf: "sentinel-hf",
  kube: "sentinel-kube",
  lm: "sentinel-lm",
  log: "sentinel-log",
  pg: "sentinel-pg",
} as const;

const tmpDirs: string[] = [];
const servers: { stop: () => Promise<void> }[] = [];
const savedEnv = new Map<string, string | undefined>();

export function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

export function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

export function makeDistDir(): string {
  const dir = tmpDir("llamactl-console-dist-");
  writeFileSync(join(dir, "index.html"), INDEX_HTML);
  return dir;
}

export function useTempDevStorage(): string {
  const dir = tmpDir("llamactl-console-storage-");
  setEnv("DEV_STORAGE", dir);
  return dir;
}

export async function cleanupConsoleTest(): Promise<void> {
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
  for (const [key, value] of savedEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export interface KubeUserSpec {
  name: string;
  token?: string;
  tokenRef?: string;
}

export interface KubeSpec {
  /** Raw file contents; when set the rest of the spec is ignored. */
  raw?: string;
  defaultNode?: string;
  contextUser?: string;
  users?: KubeUserSpec[];
  nodes?: Record<string, unknown>[];
}

export function writeKubeconfig(spec: KubeSpec = {}): string {
  const dir = tmpDir("llamactl-console-cfg-");
  const cfg = {
    apiVersion: "llamactl/v1",
    kind: "Config",
    currentContext: "default",
    contexts: [
      {
        name: "default",
        cluster: "home",
        user: spec.contextUser ?? "me",
        defaultNode: spec.defaultNode ?? "local",
      },
    ],
    clusters: [
      {
        name: "home",
        nodes: [{ name: "local", endpoint: "inproc://local" }, ...(spec.nodes ?? [])],
      },
    ],
    users: spec.users ?? [{ name: "me", token: "tok-console-test" }],
  };
  const path = join(dir, "config");
  writeFileSync(path, spec.raw ?? stringify(cfg));
  setEnv("LLAMACTL_CONFIG", path);
  return path;
}

/** Temp kubeconfig + temp DEV_STORAGE + temp dist dir in one call. */
export function consoleTestFixture(spec: KubeSpec = {}): {
  distPath: string;
  configPath: string;
} {
  useTempDevStorage();
  const configPath = writeKubeconfig(spec);
  return { configPath, distPath: makeDistDir() };
}

// ---- spy backend -----------------------------------------------------------

export interface SpyCall {
  path: string;
  ctx: unknown;
  input: unknown;
}

export interface SpyState {
  finallyRan: boolean;
  sawAbortSignal: boolean;
}

export interface SpyBackend {
  router: unknown;
  calls: SpyCall[];
  state: SpyState;
}

/**
 * A tRPC router with the same ctx shape the console dispatch router
 * uses ({ node: string | null }). Every procedure records {path, ctx,
 * input} before returning its fixture so tests can assert exactly what
 * crossed the guard — and what did not. `serverLogs` yields one fixture
 * item, then parks on the AbortSignal the caller forwards through
 * createCaller(ctx, {signal}) and flags `finallyRan` on teardown.
 */
export function makeSpyBackend(fixtures: Record<string, unknown> = {}): SpyBackend {
  const calls: SpyCall[] = [];
  const state: SpyState = { finallyRan: false, sawAbortSignal: false };
  const t = initTRPC.context<{ node: string | null }>().create();
  const query = (path: string): AnyProcedure =>
    t.procedure.input(z.unknown()).query(({ ctx, input }) => {
      calls.push({ path, ctx, input });
      return fixtures[path];
    });
  const mutation = (path: string): AnyProcedure =>
    t.procedure.input(z.unknown()).mutation(({ ctx, input }) => {
      calls.push({ path, ctx, input });
      return fixtures[path];
    });
  const router = t.router({
    env: query("env"),
    keepAliveStart: mutation("keepAliveStart"),
    nodeFacts: query("nodeFacts"),
    nodeList: query("nodeList"),
    nodeOpenAIConfig: query("nodeOpenAIConfig"),
    nodeTest: query("nodeTest"),
    pullFile: t.procedure.input(z.unknown()).subscription(async function* ({ ctx, input }) {
      calls.push({ path: "pullFile", ctx, input });
      await Promise.resolve();
      yield fixtures["pullFile"];
    }),
    reconcilerStart: mutation("reconcilerStart"),
    serverLogs: t.procedure.input(z.unknown()).subscription(async function* ({
      ctx,
      input,
      signal,
    }) {
      calls.push({ path: "serverLogs", ctx, input });
      state.sawAbortSignal = signal instanceof AbortSignal;
      try {
        yield fixtures["serverLogs"];
        await new Promise<void>((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
      } finally {
        state.finallyRan = true;
      }
    }),
    serverStatus: query("serverStatus"),
    serverStop: mutation("serverStop"),
    uiPickDirectory: query("uiPickDirectory"),
    workloadDescribe: query("workloadDescribe"),
    workloadList: query("workloadList"),
    workloadsDir: query("workloadsDir"),
  });
  return { calls, router, state };
}

// ---- fixtures ---------------------------------------------------------------

export function ragNodeFixture(): Record<string, unknown> {
  return {
    effectiveKind: "rag",
    kind: "rag",
    name: "ragdb",
    rag: {
      auth: { tokenEnv: "RAGDB_PASS" },
      endpoint: `postgres://rag:${SENTINELS.pg}@db.local:5432/rag`,
      provider: "pgvector",
    },
  };
}

export function agentCliNodeFixture(): Record<string, unknown> {
  return {
    advertisedEndpoint: `http://u:${SENTINELS.adv}@adv.local:4`,
    certificate: "PEM-DATA",
    certificateFingerprint: "sha256:abc123",
    cli: [
      {
        env: { ANTHROPIC_API_KEY: SENTINELS.cli, CLAUDE_MODEL: "opus" },
        name: "claude",
        preset: "claude",
      },
    ],
    effectiveKind: "agent",
    endpoint: `https://u:${SENTINELS.ep}@127.0.0.1:9`,
    kind: "agent",
    name: "agent1",
  };
}

export function workloadArgsFixture(): string[] {
  return ["--api-key", SENTINELS.arg, `--hf-token=${SENTINELS.hf}`];
}

/** Sentinel-laden fixture set covering every procedure the spy serves. */
export function spyFixtures(): Record<string, unknown> {
  return {
    env: {
      DEV_STORAGE: "/tmp/dev",
      LM_API_TOKEN: SENTINELS.lm,
      LOCAL_AI_API_KEY: SENTINELS.lm,
      LOCAL_AI_PROVIDER: "lmstudio",
      OPENAI_API_KEY: SENTINELS.lm,
    },
    keepAliveStart: { ok: true },
    nodeFacts: {
      gpu: { name: "M4" },
      hostname: "h1",
      probe: { apiToken: SENTINELS.facts, url: `http://u:${SENTINELS.fu}@h:1/` },
    },
    nodeList: {
      cluster: "home",
      context: "default",
      defaultNode: "agent1",
      nodes: [
        { effectiveKind: "agent", endpoint: "inproc://local", name: "local" },
        ragNodeFixture(),
        agentCliNodeFixture(),
      ],
    },
    nodeOpenAIConfig: { baseUrl: "http://127.0.0.1:1/v1", model: "m" },
    nodeTest: { nodes: [ragNodeFixture(), agentCliNodeFixture()], ok: true },
    pullFile: { status: "done", type: "done" },
    reconcilerStart: { started: true },
    serverLogs: {
      line: `--api-key ${SENTINELS.log} --hf-token=${SENTINELS.hf} Authorization: Bearer ${SENTINELS.bearer} dsn=postgres://u:${SENTINELS.dsn}@db:1/x logmark-41c0`,
      type: "line",
    },
    serverStatus: {
      args: workloadArgsFixture(),
      extraArgs: workloadArgsFixture(),
      pid: 4242,
      state: "up",
      workload: "w1",
    },
    serverStop: { stopped: true },
    uiPickDirectory: { path: "/tmp/pick" },
    workloadDescribe: { extraArgs: workloadArgsFixture(), name: "w1", node: "local" },
    workloadList: [
      {
        extraArgs: workloadArgsFixture(),
        name: "w1",
        node: "local",
        phase: "Running",
        rel: "m.gguf",
      },
    ],
    workloadsDir: { path: "/tmp/wl" },
  };
}

// ---- HTTP helpers -----------------------------------------------------------

export interface ConsoleHandle {
  port: number;
  url: string;
  /** The consumed `GET /` response — read headers only. */
  index: Response;
  cookieName: string;
  nonce: string;
  /** `"<name>=<nonce>"`, or "" when no session cookie was issued. */
  cookie: string;
}

export interface ConsoleStarter {
  startConsoleServer: (opts: {
    port: number;
    distPath: string;
    hostname?: string;
    backend?: unknown;
    lookupWorkload?: unknown;
  }) => Promise<{ port: number; url: string; stop(): Promise<void> }>;
}

export async function startConsole(
  r: ConsoleStarter,
  opts: { distPath: string; backend?: unknown },
): Promise<ConsoleHandle> {
  const server = await r.startConsoleServer({
    port: 0,
    distPath: opts.distPath,
    ...(opts.backend === undefined ? {} : { backend: opts.backend }),
  });
  servers.push(server);
  const index = await fetch(`${server.url}/`);
  const session = parseSessionCookie(index);
  return {
    cookie: session === null ? "" : `${session.name}=${session.value}`,
    cookieName: session?.name ?? "",
    index,
    nonce: session?.value ?? "",
    port: server.port,
    url: server.url,
  };
}

export interface SessionCookie {
  name: string;
  value: string;
  raw: string;
}

export function parseSessionCookie(res: Response): SessionCookie | null {
  for (const line of res.headers.getAll("set-cookie")) {
    const pair = (line.split(";", 1)[0] ?? "").trim();
    const eq = pair.indexOf("=");
    const name = eq > 0 ? pair.slice(0, eq).trim() : "";
    if (name.startsWith("llamactl_console_")) {
      return { name, raw: line, value: pair.slice(eq + 1).trim() };
    }
  }
  return null;
}

export function trpcUrl(
  handle: { port: number },
  path: string,
  opts: { input?: unknown; batch?: boolean } = {},
): string {
  const params: string[] = [];
  if (opts.batch === true) params.push("batch=1");
  if (opts.input !== undefined)
    params.push(`input=${encodeURIComponent(JSON.stringify(opts.input))}`);
  const qs = params.length > 0 ? `?${params.join("&")}` : "";
  return `http://127.0.0.1:${String(handle.port)}/api/trpc/${path}${qs}`;
}

/** Host + Sec-Fetch-Site + session cookie; `extra` wins on conflicts. */
export function apiHeaders(
  handle: { port: number; cookie: string },
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    host: `127.0.0.1:${String(handle.port)}`,
    "sec-fetch-site": "same-origin",
  };
  if (handle.cookie) headers["cookie"] = handle.cookie;
  return { ...headers, ...extra };
}

// ---- bounded waits ----------------------------------------------------------

async function raceDeadline<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(
          () => {
            resolve("timeout");
          },
          Math.max(1, ms),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface SseReadResult {
  found: boolean;
  transcript: string;
}

function nextSseFrame(buf: string): { frame: string; rest: string } | null {
  const cut = buf.indexOf("\n\n");
  if (cut < 0) return null;
  return { frame: buf.slice(0, cut), rest: buf.slice(cut + 2) };
}

function sseFrameEvent(frame: string): string {
  const line = frame.split("\n").find((l) => l.startsWith("event:"));
  return line === undefined ? "message" : line.slice("event:".length).trim();
}

/**
 * Read SSE frames until a non-connected, non-ping frame contains
 * `needle` or `deadlineMs` elapses. tRPC 11.16 always emits
 * `event: connected` before pulling the first item, so a plain
 * first-frame match would fire on the handshake instead of the data.
 */
export async function readSseFor(
  res: Response,
  needle: string,
  deadlineMs: number,
): Promise<SseReadResult> {
  const body = res.body;
  if (body === null) return { found: false, transcript: "" };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + deadlineMs;
  let buf = "";
  let transcript = "";
  try {
    while (Date.now() < deadline) {
      const chunk = await raceDeadline(reader.read(), deadline - Date.now());
      if (chunk === "timeout" || chunk.done) break;
      const decoded = decoder.decode(chunk.value, { stream: true });
      buf += decoded;
      transcript += decoded;
      for (let part = nextSseFrame(buf); part !== null; part = nextSseFrame(buf)) {
        buf = part.rest;
        const event = sseFrameEvent(part.frame);
        if (event !== "connected" && event !== "ping" && part.frame.includes(needle)) {
          return { found: true, transcript };
        }
      }
    }
    return { found: false, transcript };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function pollUntil(cond: () => boolean, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 15);
    });
  }
  return cond();
}
