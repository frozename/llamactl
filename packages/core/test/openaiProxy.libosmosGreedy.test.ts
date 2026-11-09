// #557 S5: engine-gated libosmos greedy sanitiser. osmos-api decodes
// greedy-only and answers HTTP 400 for temperature != 0, top_p != 1, any
// `stop` key, or n != 1, so the proxy must rewrite those sampling fields
// on libosmos routes before forwarding. R1-R3 pin the rewrite contract
// and fail by assertion at base (the 400 passthrough, the unrewritten
// body, the missing log); G1-G2 are non-regression pins proving
// already-greedy bodies and every other engine stay byte-identical.

import { afterEach, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";

import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

function tempEnv(): { env: ResolvedEnv; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-libosmos-"));
  return {
    env: resolveEnv({
      DEV_STORAGE: dir,
      LOCAL_AI_RUNTIME_DIR: dir,
      LLAMA_CPP_MODELS: join(dir, "models"),
    }),
    dir,
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const LIBOSMOS_WORKLOAD = "libosmos-ds41";
const LIBOSMOS_ALIAS = "DeepSeek-V4.1-Flash-1017-UD-IQ1_M-00001-of-00005.gguf";
const LIBOSMOS_PORT = 8185;
const GUFO_PORT = 8191;
const MODELRUN_PORT = 8192;

function writeModelHostRoute(dir: string, workload: string, state: Record<string, unknown>): void {
  const workloadDir = join(dir, "workloads", workload);
  mkdirSync(workloadDir, { recursive: true });
  writeFileSync(join(workloadDir, "modelhost.pid"), `${String(process.pid)}\n`);
  writeFileSync(join(workloadDir, "modelhost.state"), JSON.stringify(state));
}

function seedLibosmosHost(dir: string): void {
  writeModelHostRoute(dir, LIBOSMOS_WORKLOAD, {
    kind: "ModelHost",
    engine: "libosmos",
    pid: process.pid,
    host: "127.0.0.1",
    port: LIBOSMOS_PORT,
    modelAliases: [LIBOSMOS_ALIAS],
    startedAt: "2026-11-08T00:00:00.000Z",
  });
}

function writeLlamaServerWorkload(
  runtimeRoot: string,
  workload: string,
  state: { rel: string; port: number; extraArgs?: string[] },
): void {
  const dir = join(runtimeRoot, "workloads", workload);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify({
      rel: state.rel,
      extraArgs: state.extraArgs ?? [],
      host: "127.0.0.1",
      port: state.port,
      binary: "/x/llama-server",
      pid: process.pid,
      startedAt: "2026-05-24T00:00:00.000Z",
      tunedProfile: null,
    }),
  );
}

interface ForwardedCall {
  url: string;
  body: string | null;
}

function hasKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

// Fake upstream: port 8185 is the greedy-only libosmos decoder — it 400s
// any body carrying a non-greedy sampling field and 200s otherwise. Every
// other port is a generic 200 upstream with no sampling check.
function installUpstreamStub(calls: ForwardedCall[]): void {
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, body });
    if (new URL(url).port !== String(LIBOSMOS_PORT) || body === null) {
      return Response.json({ ok: true });
    }
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const nonGreedy =
      (hasKey(parsed, "temperature") && parsed["temperature"] !== 0) ||
      (hasKey(parsed, "top_p") && parsed["top_p"] !== 1) ||
      hasKey(parsed, "stop") ||
      (hasKey(parsed, "n") && parsed["n"] !== 1);
    if (nonGreedy) {
      return Response.json({ error: { message: "greedy only" } }, { status: 400 });
    }
    return Response.json({
      id: "chatcmpl-libosmos",
      object: "chat.completion",
      created: 0,
      model: typeof parsed["model"] === "string" ? parsed["model"] : "",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }) as unknown as typeof fetch;
}

function chatCompletionRequest(bodyText: string): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bodyText,
  });
}

// Compact JSON.stringify output only: stripVendorFieldsFromBody
// re-serialises any body whose parsed form does not reproduce the exact
// request bytes, so non-compact bodies would fail the byte-identical pins
// for reasons unrelated to the sanitiser.
function nonGreedyBody(model: string): string {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.7,
    top_p: 0.9,
    stop: ["\n"],
    n: 2,
  });
}

function forwardedTo(calls: readonly ForwardedCall[], port: number): ForwardedCall | undefined {
  return calls.filter((call) => call.url.includes(`:${String(port)}/`)).at(-1);
}

function greedyRewriteEvents(calls: readonly (readonly unknown[])[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const call of calls) {
    const arg: unknown = call[0];
    if (typeof arg !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(arg);
    } catch {
      continue;
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (record["event"] === "libosmos_greedy_rewrite") out.push(record);
    }
  }
  return out;
}

test("R1: libosmos route rewrites non-greedy sampling fields before forwarding", async () => {
  const t = tempEnv();
  const calls: ForwardedCall[] = [];
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    seedLibosmosHost(t.dir);
    installUpstreamStub(calls);

    const res = await openaiProxy.proxyOpenAI(
      chatCompletionRequest(nonGreedyBody(LIBOSMOS_ALIAS)),
      t.env,
    );

    expect(res.status).toBe(200);
    const forwardedBody = forwardedTo(calls, LIBOSMOS_PORT)?.body;
    expect(typeof forwardedBody).toBe("string");
    const parsed = JSON.parse(forwardedBody!) as Record<string, unknown>;
    expect(parsed["temperature"]).toBe(0);
    expect(parsed["top_p"]).toBe(1);
    expect(parsed["n"]).toBe(1);
    expect("stop" in parsed).toBe(false);
    expect(parsed["model"]).toBe(LIBOSMOS_ALIAS);
    expect(parsed["messages"]).toEqual([{ role: "user", content: "hi" }]);
  } finally {
    warnSpy.mockRestore();
    t.cleanup();
  }
});

test("R2: libosmos greedy rewrite logs libosmos_greedy_rewrite with the rewritten fields", async () => {
  const t = tempEnv();
  const calls: ForwardedCall[] = [];
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    seedLibosmosHost(t.dir);
    installUpstreamStub(calls);

    const res = await openaiProxy.proxyOpenAI(
      chatCompletionRequest(nonGreedyBody(LIBOSMOS_ALIAS)),
      t.env,
    );

    expect(res.status).toBe(200);
    const events = greedyRewriteEvents(warnSpy.mock.calls);
    expect(events).toHaveLength(1);
    expect(events[0]?.["workload"]).toBe(LIBOSMOS_WORKLOAD);
    expect(events[0]?.["fields"]).toEqual(["temperature", "top_p", "stop", "n"]);
  } finally {
    warnSpy.mockRestore();
    t.cleanup();
  }
});

test("R3: libosmos sanitiser rewrites only the non-greedy fields present", async () => {
  const t = tempEnv();
  const calls: ForwardedCall[] = [];
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    seedLibosmosHost(t.dir);
    installUpstreamStub(calls);

    const bodyText = JSON.stringify({
      model: LIBOSMOS_ALIAS,
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
    });
    const res = await openaiProxy.proxyOpenAI(chatCompletionRequest(bodyText), t.env);

    expect(res.status).toBe(200);
    const forwardedBody = forwardedTo(calls, LIBOSMOS_PORT)?.body;
    expect(typeof forwardedBody).toBe("string");
    const parsed = JSON.parse(forwardedBody!) as Record<string, unknown>;
    expect(parsed["temperature"]).toBe(0);
    expect("top_p" in parsed).toBe(false);
    expect("n" in parsed).toBe(false);
    expect("stop" in parsed).toBe(false);
    const events = greedyRewriteEvents(warnSpy.mock.calls);
    expect(events).toHaveLength(1);
    expect(events[0]?.["fields"]).toEqual(["temperature"]);
  } finally {
    warnSpy.mockRestore();
    t.cleanup();
  }
});

test("G1: greedy-conformant libosmos bodies forward byte-identical with no rewrite log", async () => {
  const t = tempEnv();
  const calls: ForwardedCall[] = [];
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    seedLibosmosHost(t.dir);
    installUpstreamStub(calls);

    const bodies = [
      JSON.stringify({
        model: LIBOSMOS_ALIAS,
        messages: [{ role: "user", content: "hi" }],
        temperature: 0,
        top_p: 1,
        n: 1,
      }),
      JSON.stringify({
        model: LIBOSMOS_ALIAS,
        messages: [{ role: "user", content: "hi" }],
      }),
    ];
    for (const bodyText of bodies) {
      const res = await openaiProxy.proxyOpenAI(chatCompletionRequest(bodyText), t.env);
      expect(res.status).toBe(200);
      expect(forwardedTo(calls, LIBOSMOS_PORT)?.body).toBe(bodyText);
    }
    expect(greedyRewriteEvents(warnSpy.mock.calls)).toEqual([]);
  } finally {
    warnSpy.mockRestore();
    t.cleanup();
  }
});

test("G2: non-greedy bodies to non-libosmos engines forward byte-identical", async () => {
  const t = tempEnv();
  const calls: ForwardedCall[] = [];
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    writeModelHostRoute(t.dir, "gufo-host", {
      kind: "ModelHost",
      engine: "llamacpp",
      pid: process.pid,
      host: "127.0.0.1",
      port: GUFO_PORT,
      modelAliases: ["gufo-ds41-flash"],
      startedAt: "2026-11-08T00:00:00.000Z",
    });
    writeLlamaServerWorkload(t.dir, "llamacpp-run", {
      rel: "models/ds41-run.gguf",
      port: MODELRUN_PORT,
    });
    installUpstreamStub(calls);

    const gufoBody = nonGreedyBody("gufo-ds41-flash");
    const gufoRes = await openaiProxy.proxyOpenAI(chatCompletionRequest(gufoBody), t.env);
    expect(gufoRes.status).toBe(200);
    expect(forwardedTo(calls, GUFO_PORT)?.body).toBe(gufoBody);

    const runBody = nonGreedyBody("models/ds41-run.gguf");
    const runRes = await openaiProxy.proxyOpenAI(chatCompletionRequest(runBody), t.env);
    expect(runRes.status).toBe(200);
    expect(forwardedTo(calls, MODELRUN_PORT)?.body).toBe(runBody);

    expect(greedyRewriteEvents(warnSpy.mock.calls)).toEqual([]);
  } finally {
    warnSpy.mockRestore();
    t.cleanup();
  }
});
