import { afterEach, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AnthropicMessagesRequest } from "../../src/anthropic/types.js";
import type { PeerNode } from "../../src/config/peers.js";
import type { ResolvedEnv } from "../../src/types.js";
import type { PeerSnapshot } from "../../src/workloadRuntime.js";

import { translateAnthropicRequest } from "../../src/anthropic/translateRequest.js";
import { resolveEnv } from "../../src/env.js";
import { openaiProxy } from "../../src/index.js";
import { readWorkloadEpoch } from "../../src/kvstore/index.js";
import {
  canonicalRequestSha,
  openResponseCacheStorage,
  ResponseCacheRegistry,
} from "../../src/responsecache/index.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

interface TempRuntime {
  root: string;
  env: ResolvedEnv;
  cleanup: () => void;
}

type LookupScope = {
  readonly sha: string;
  readonly model: string;
  readonly workload: string;
  readonly workloadEpoch: string;
  readonly protocolVariant: "openai" | "anthropic";
};

interface TestUpstream {
  baseUrl: string;
  calls: number;
  close: () => Promise<void>;
}

function makeTempRuntime(): TempRuntime {
  const root = mkdtempSync(join(tmpdir(), "llamactl-responsecache-proxy-"));
  return {
    root,
    env: resolveEnv({
      ...process.env,
      DEV_STORAGE: root,
      LOCAL_AI_RUNTIME_DIR: root,
      LLAMA_CPP_MODELS: join(root, "models"),
    }),
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeModelRunWorkload(
  runtimeRoot: string,
  workload: string,
  port: number,
  rel = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
): void {
  const dir = join(runtimeRoot, "workloads", workload);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify({
      rel,
      extraArgs: [],
      host: "127.0.0.1",
      port,
      binary: "/x/llama-server",
      pid: process.pid,
      startedAt: "2026-05-24T00:00:00.000Z",
      tunedProfile: null,
    }),
  );
}

function workloadEpochFor(runtime: TempRuntime, workload: string): string {
  const epoch = readWorkloadEpoch({ name: workload }, runtime.env);
  if (!epoch) throw new Error(`missing workload epoch for ${workload}`);
  return epoch;
}

function lookupScope(params: {
  sha: string;
  model: string;
  workload: string;
  workloadEpoch: string;
  protocolVariant?: "openai" | "anthropic";
}): LookupScope {
  return {
    sha: params.sha,
    model: params.model,
    workload: params.workload,
    workloadEpoch: params.workloadEpoch,
    protocolVariant: params.protocolVariant ?? "openai",
  } as const;
}

function chatResponseForMode(
  mode: "json" | "sse" | "json_error" | "sse_partial",
  calls: number,
  body: string,
): Response {
  if (mode === "sse") {
    return new Response(
      `data: ${JSON.stringify({ id: String(calls), echoed: body })}\n\ndata: [DONE]\n\n`,
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );
  }
  if (mode === "sse_partial") {
    return new Response(`data: ${JSON.stringify({ id: String(calls), echoed: body })}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }
  if (mode === "json_error") {
    return Response.json({
      error: {
        message: "upstream failure",
        type: "upstream_error",
      },
    });
  }
  return Response.json({
    id: `chatcmpl-${String(calls)}`,
    object: "chat.completion",
    model: "claude-compatible",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: `hit-${String(calls)}` },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
    echoed: body,
  });
}

function startUpstream(mode: "json" | "sse" | "json_error" | "sse_partial"): Promise<TestUpstream> {
  let calls = 0;
  const baseUrl = "http://127.0.0.1:19501";
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method =
      init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    const parsed = new URL(url);
    if (method === "POST" && parsed.pathname === "/v1/chat/completions") {
      calls += 1;
      const body = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(chatResponseForMode(mode, calls, body));
    }
    return Promise.resolve(new Response("", { status: 404 }));
  }) as typeof fetch;

  return Promise.resolve({
    baseUrl,
    get calls() {
      return calls;
    },
    close: () => Promise.resolve(),
  });
}

const originalBudget = process.env["LLAMACTL_RESPONSE_CACHE_BUDGET_MB"];
const originalMaxEntry = process.env["LLAMACTL_RESPONSE_CACHE_MAX_ENTRY_MB"];
const originalTtlHours = process.env["LLAMACTL_RESPONSE_CACHE_TTL_HOURS"];
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBudget === undefined) delete process.env["LLAMACTL_RESPONSE_CACHE_BUDGET_MB"];
  else process.env["LLAMACTL_RESPONSE_CACHE_BUDGET_MB"] = originalBudget;
  if (originalMaxEntry === undefined) delete process.env["LLAMACTL_RESPONSE_CACHE_MAX_ENTRY_MB"];
  else process.env["LLAMACTL_RESPONSE_CACHE_MAX_ENTRY_MB"] = originalMaxEntry;
  if (originalTtlHours === undefined) delete process.env["LLAMACTL_RESPONSE_CACHE_TTL_HOURS"];
  else process.env["LLAMACTL_RESPONSE_CACHE_TTL_HOURS"] = originalTtlHours;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

test("cold miss saves and warm hit serves cached JSON without upstream call", async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream("json");
  try {
    const url = new URL(upstream.baseUrl);
    const model = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf";
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10), model);
    const workloadEpoch = workloadEpochFor(runtime, "wl-a");
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "cached json" }],
      temperature: 0,
    });

    const first = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    expect(first.status).toBe(200);
    expect(upstream.calls).toBe(1);

    const second = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    const secondJson = (await second.json()) as { id: string };
    expect(second.status).toBe(200);
    expect(secondJson.id).toBe("chatcmpl-1");
    expect(upstream.calls).toBe(1);
    expect(openaiProxy.__getOpenAIProxyResponseCacheHitTotalForTests(runtime.env)).toBe(1);

    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    const entry = registry.findBySha(
      lookupScope({
        sha: canonicalRequestSha(body),
        model,
        workload: "wl-a",
        workloadEpoch,
      }),
    );
    expect(entry).not.toBeNull();
    storage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("SSE responses are cached and replayed on warm hit", async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream("sse");
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "cached sse" }],
      stream: true,
      temperature: 0,
    });

    const first = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    const firstText = await first.text();
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/event-stream");
    expect(firstText).toContain("[DONE]");
    expect(upstream.calls).toBe(1);

    const second = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    const secondText = await second.text();
    expect(second.status).toBe(200);
    expect(second.headers.get("content-type")).toContain("text/event-stream");
    expect(secondText).toBe(firstText);
    expect(upstream.calls).toBe(1);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("non-deterministic request bypasses response cache", async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream("json");
  try {
    const url = new URL(upstream.baseUrl);
    const model = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf";
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10), model);
    const workloadEpoch = workloadEpochFor(runtime, "wl-a");
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "sampled" }],
      temperature: 0.7,
    });

    const first = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    const second = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(upstream.calls).toBe(2);

    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    expect(
      registry.findBySha(
        lookupScope({
          sha: canonicalRequestSha(body),
          model,
          workload: "wl-a",
          workloadEpoch,
        }),
      ),
    ).toBeNull();
    storage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("eviction trims entries under configured response-cache budget", async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream("json");
  process.env["LLAMACTL_RESPONSE_CACHE_BUDGET_MB"] = "1";
  try {
    const url = new URL(upstream.baseUrl);
    const model = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf";
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10), model);
    const workloadEpoch = workloadEpochFor(runtime, "wl-a");

    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    const now = Date.now() - 20_000_000;
    const blobA = new Uint8Array(450_000);
    const blobB = new Uint8Array(420_000);
    registry.insert({
      sha: "old-a",
      model,
      workload: "wl-a",
      workloadEpoch,
      protocolVariant: "openai",
      contentType: "application/json",
      statusCode: 200,
      responseBody: blobA,
      requestBodyBytes: 120_000,
      responseBodyBytes: blobA.byteLength,
      createdAt: now,
      lastUsed: now,
      hits: 0,
    });
    registry.insert({
      sha: "old-b",
      model,
      workload: "wl-a",
      workloadEpoch,
      protocolVariant: "openai",
      contentType: "application/json",
      statusCode: 200,
      responseBody: blobB,
      requestBodyBytes: 100_000,
      responseBodyBytes: blobB.byteLength,
      createdAt: now,
      lastUsed: now,
      hits: 0,
    });
    storage.close();

    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "evict if needed" }],
      temperature: 0,
    });
    const response = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    expect(response.status).toBe(200);

    const afterStorage = openResponseCacheStorage(runtime.root);
    const afterRegistry = new ResponseCacheRegistry(afterStorage);
    const entries = afterRegistry.listForModel(model);
    const totalBytes = entries.reduce(
      (sum, entry) => sum + entry.requestBodyBytes + entry.responseBodyBytes,
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(1 * 1024 * 1024);
    expect(
      afterRegistry.findBySha(
        lookupScope({
          sha: canonicalRequestSha(body),
          model,
          workload: "wl-a",
          workloadEpoch,
        }),
      ),
    ).not.toBeNull();
    expect(
      openaiProxy.__getOpenAIProxyResponseCacheEvictTotalForTests(runtime.env),
    ).toBeGreaterThan(0);
    afterStorage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("error-envelope JSON responses are not cached and emit skip log", async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream("json_error");
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const url = new URL(upstream.baseUrl);
    const model = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf";
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10), model);
    const workloadEpoch = workloadEpochFor(runtime, "wl-a");
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "error envelope" }],
      temperature: 0,
    });
    const response = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    expect(response.status).toBe(200);
    expect(upstream.calls).toBe(1);
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes('"event":"response_cache_skip_error_envelope"'),
      ),
    ).toBe(true);

    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    expect(
      registry.findBySha(
        lookupScope({
          sha: canonicalRequestSha(body),
          model,
          workload: "wl-a",
          workloadEpoch,
        }),
      ),
    ).toBeNull();
    storage.close();
  } finally {
    warnSpy.mockRestore();
    await upstream.close();
    runtime.cleanup();
  }
});

test("partial SSE responses are not cached and emit skip log", async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream("sse_partial");
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const url = new URL(upstream.baseUrl);
    const model = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf";
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10), model);
    const workloadEpoch = workloadEpochFor(runtime, "wl-a");
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "partial sse" }],
      stream: true,
      temperature: 0,
    });
    const response = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    expect(response.status).toBe(200);
    expect(upstream.calls).toBe(1);
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes('"event":"response_cache_skip_partial_sse"'),
      ),
    ).toBe(true);

    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    expect(
      registry.findBySha(
        lookupScope({
          sha: canonicalRequestSha(body),
          model,
          workload: "wl-a",
          workloadEpoch,
        }),
      ),
    ).toBeNull();
    storage.close();
  } finally {
    warnSpy.mockRestore();
    await upstream.close();
    runtime.cleanup();
  }
});

test("TTL-expired response-cache entries are treated as misses and deleted", async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream("json_error");
  process.env["LLAMACTL_RESPONSE_CACHE_TTL_HOURS"] = "24";
  try {
    const url = new URL(upstream.baseUrl);
    const model = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf";
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10), model);
    const workloadEpoch = workloadEpochFor(runtime, "wl-a");
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "ttl expired" }],
      temperature: 0,
    });
    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    const now = Date.now();
    registry.insert({
      sha: canonicalRequestSha(body),
      model,
      workload: "wl-a",
      workloadEpoch,
      protocolVariant: "openai",
      contentType: "application/json",
      statusCode: 200,
      responseBody: new Uint8Array(Buffer.from('{"ok":true}', "utf8")),
      requestBodyBytes: Buffer.byteLength(body, "utf8"),
      responseBodyBytes: Buffer.byteLength('{"ok":true}', "utf8"),
      createdAt: now - 25 * 60 * 60 * 1000,
      lastUsed: now - 25 * 60 * 60 * 1000,
      hits: 0,
    });
    storage.close();

    const response = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    expect(response.status).toBe(200);
    expect(upstream.calls).toBe(1);
    expect(openaiProxy.__getOpenAIProxyResponseCacheHitTotalForTests(runtime.env)).toBe(0);
    expect(openaiProxy.__getOpenAIProxyResponseCacheMissTotalForTests(runtime.env)).toBe(1);

    const afterStorage = openResponseCacheStorage(runtime.root);
    const afterRegistry = new ResponseCacheRegistry(afterStorage);
    expect(
      afterRegistry.findBySha(
        lookupScope({
          sha: canonicalRequestSha(body),
          model,
          workload: "wl-a",
          workloadEpoch,
        }),
      ),
    ).toBeNull();
    afterStorage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("fresh response-cache entries are served as hits before TTL expiry", async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream("json");
  process.env["LLAMACTL_RESPONSE_CACHE_TTL_HOURS"] = "24";
  try {
    const url = new URL(upstream.baseUrl);
    const model = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf";
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10), model);
    const workloadEpoch = workloadEpochFor(runtime, "wl-a");
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "ttl fresh" }],
      temperature: 0,
    });
    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    const now = Date.now();
    registry.insert({
      sha: canonicalRequestSha(body),
      model,
      workload: "wl-a",
      workloadEpoch,
      protocolVariant: "openai",
      contentType: "application/json",
      statusCode: 200,
      responseBody: new Uint8Array(Buffer.from('{"id":"cached"}', "utf8")),
      requestBodyBytes: Buffer.byteLength(body, "utf8"),
      responseBodyBytes: Buffer.byteLength('{"id":"cached"}', "utf8"),
      createdAt: now - 60 * 60 * 1000,
      lastUsed: now - 60 * 60 * 1000,
      hits: 0,
    });
    storage.close();

    const response = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    const payload = (await response.json()) as { id?: string };
    expect(response.status).toBe(200);
    expect(payload.id).toBe("cached");
    expect(upstream.calls).toBe(0);
    expect(openaiProxy.__getOpenAIProxyResponseCacheHitTotalForTests(runtime.env)).toBe(1);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("response cache misses when workload scope differs", async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream("json");
  try {
    const model = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf";
    writeModelRunWorkload(
      runtime.root,
      "wl-a",
      Number.parseInt(new URL(upstream.baseUrl).port, 10),
      model,
    );
    const workloadEpoch = workloadEpochFor(runtime, "wl-a");
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "scope workload mismatch" }],
      temperature: 0,
    });
    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    registry.insert({
      sha: canonicalRequestSha(body),
      model,
      workload: "wl-b",
      workloadEpoch,
      protocolVariant: "openai",
      contentType: "application/json",
      statusCode: 200,
      responseBody: new TextEncoder().encode('{"id":"wrong-workload"}'),
      requestBodyBytes: Buffer.byteLength(body, "utf8"),
      responseBodyBytes: Buffer.byteLength('{"id":"wrong-workload"}', "utf8"),
      createdAt: Date.now(),
      lastUsed: Date.now(),
      hits: 0,
    });
    storage.close();

    const response = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    expect(response.status).toBe(200);
    expect(upstream.calls).toBe(1);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("response cache misses when workload epoch differs", async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream("json");
  try {
    const model = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf";
    writeModelRunWorkload(
      runtime.root,
      "wl-a",
      Number.parseInt(new URL(upstream.baseUrl).port, 10),
      model,
    );
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "scope epoch mismatch" }],
      temperature: 0,
    });
    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    registry.insert({
      sha: canonicalRequestSha(body),
      model,
      workload: "wl-a",
      workloadEpoch: "stale-epoch",
      protocolVariant: "openai",
      contentType: "application/json",
      statusCode: 200,
      responseBody: new TextEncoder().encode('{"id":"stale-epoch"}'),
      requestBodyBytes: Buffer.byteLength(body, "utf8"),
      responseBodyBytes: Buffer.byteLength('{"id":"stale-epoch"}', "utf8"),
      createdAt: Date.now(),
      lastUsed: Date.now(),
      hits: 0,
    });
    storage.close();

    const response = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    expect(response.status).toBe(200);
    expect(upstream.calls).toBe(1);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("response cache hits when workload and epoch match", async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream("json");
  try {
    const model = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf";
    writeModelRunWorkload(
      runtime.root,
      "wl-a",
      Number.parseInt(new URL(upstream.baseUrl).port, 10),
      model,
    );
    const workloadEpoch = workloadEpochFor(runtime, "wl-a");
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "scope hit" }],
      temperature: 0,
    });
    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    registry.insert({
      sha: canonicalRequestSha(body),
      model,
      workload: "wl-a",
      workloadEpoch,
      protocolVariant: "openai",
      contentType: "application/json",
      statusCode: 200,
      responseBody: new TextEncoder().encode('{"id":"scope-hit"}'),
      requestBodyBytes: Buffer.byteLength(body, "utf8"),
      responseBodyBytes: Buffer.byteLength('{"id":"scope-hit"}', "utf8"),
      createdAt: Date.now(),
      lastUsed: Date.now(),
      hits: 0,
    });
    storage.close();

    const response = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "scope-hit" });
    expect(upstream.calls).toBe(0);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("/v1/messages persists anthropic variant with post-translation bytes", async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream("json");
  try {
    const model = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf";
    writeModelRunWorkload(
      runtime.root,
      "wl-a",
      Number.parseInt(new URL(upstream.baseUrl).port, 10),
      model,
    );
    const workloadEpoch = workloadEpochFor(runtime, "wl-a");
    const anthropicRequest: AnthropicMessagesRequest = {
      model,
      max_tokens: 64,
      temperature: 0,
      messages: [{ role: "user", content: "cache anthropic bytes" }],
    } as const;

    const response = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(anthropicRequest),
      }),
      runtime.env,
    );
    expect(response.status).toBe(200);
    const responsePayload = (await Promise.resolve(response.json())) as { type?: string };
    expect(responsePayload.type).toBe("message");

    const translatedBody = JSON.stringify(translateAnthropicRequest(anthropicRequest));
    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    const entry = registry.findBySha(
      lookupScope({
        sha: canonicalRequestSha(translatedBody),
        model,
        workload: "wl-a",
        workloadEpoch,
        protocolVariant: "anthropic",
      }),
    );
    expect(entry).not.toBeNull();
    const cachedPayload = JSON.parse(Buffer.from(entry!.responseBody).toString("utf8")) as {
      type?: string;
      id?: string;
    };
    expect(cachedPayload.type).toBe("message");
    expect(cachedPayload.id).toBe("chatcmpl-1");
    storage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("/v1/messages misses when only openai protocol variant exists for matching sha", async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream("json");
  try {
    const model = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf";
    writeModelRunWorkload(
      runtime.root,
      "wl-a",
      Number.parseInt(new URL(upstream.baseUrl).port, 10),
      model,
    );
    const workloadEpoch = workloadEpochFor(runtime, "wl-a");
    const anthropicRequest: AnthropicMessagesRequest = {
      model,
      max_tokens: 64,
      temperature: 0,
      messages: [{ role: "user", content: "protocol mismatch" }],
    };
    const translatedBody = JSON.stringify(translateAnthropicRequest(anthropicRequest));
    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    registry.insert({
      sha: canonicalRequestSha(translatedBody),
      model,
      workload: "wl-a",
      workloadEpoch,
      protocolVariant: "openai",
      contentType: "application/json",
      statusCode: 200,
      responseBody: new TextEncoder().encode('{"id":"openai-shape"}'),
      requestBodyBytes: Buffer.byteLength(translatedBody, "utf8"),
      responseBodyBytes: Buffer.byteLength('{"id":"openai-shape"}', "utf8"),
      createdAt: Date.now(),
      lastUsed: Date.now(),
      hits: 0,
    });
    storage.close();

    const response = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(anthropicRequest),
      }),
      runtime.env,
    );
    expect(response.status).toBe(200);
    expect(upstream.calls).toBe(1);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("/v1/messages warm-hit returns cached anthropic bytes without translation", async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream("json");
  try {
    const model = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf";
    writeModelRunWorkload(
      runtime.root,
      "wl-a",
      Number.parseInt(new URL(upstream.baseUrl).port, 10),
      model,
    );
    const workloadEpoch = workloadEpochFor(runtime, "wl-a");
    const anthropicRequest: AnthropicMessagesRequest = {
      model,
      max_tokens: 64,
      temperature: 0,
      messages: [{ role: "user", content: "anthropic warm hit" }],
    };
    const translatedBody = JSON.stringify(translateAnthropicRequest(anthropicRequest));
    const cachedAnthropic = {
      id: "msg_cached",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "cached anthropic body" }],
      model,
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    registry.insert({
      sha: canonicalRequestSha(translatedBody),
      model,
      workload: "wl-a",
      workloadEpoch,
      protocolVariant: "anthropic",
      contentType: "application/json",
      statusCode: 200,
      responseBody: new TextEncoder().encode(JSON.stringify(cachedAnthropic)),
      requestBodyBytes: Buffer.byteLength(translatedBody, "utf8"),
      responseBodyBytes: Buffer.byteLength(JSON.stringify(cachedAnthropic), "utf8"),
      createdAt: Date.now(),
      lastUsed: Date.now(),
      hits: 0,
    });
    storage.close();

    const response = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(anthropicRequest),
      }),
      runtime.env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(cachedAnthropic);
    expect(upstream.calls).toBe(0);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

const PEER_NODE_ID = "mac-mini";
const PEER_MODEL = "peer/granite-3b.gguf";

// A cross-node (peer) route advertised through __setOpenAIProxyClusterRoutingForTests.
// listClusterRoutes derives the route host/port from the peer endpoint and synthesises
// workload=`<node>:<model>`, engine=llamacpp, kind=ModelRun, isPeer=true. The response
// cache then keys on the synthetic epoch `peer:<node>:<model>` (no local workload epoch
// exists for a peer). endpoint === the test upstream so the cold-miss forward is mockable.
function peerClusterRouting(
  upstreamBaseUrl: string,
  port: number,
  fetchedAt: number,
  revision: string | null = null,
): { clusterPeers: PeerNode[]; peerSnapshots: Map<string, PeerSnapshot> } {
  const clusterPeers: PeerNode[] = [{ id: PEER_NODE_ID, endpoint: upstreamBaseUrl }];
  const snapshot: PeerSnapshot = {
    workloads: [{ modelId: PEER_MODEL, port, revision }],
    pressure: "NORMAL",
    fetchedAt,
  };
  return { clusterPeers, peerSnapshots: new Map([[PEER_NODE_ID, snapshot]]) };
}

test("peer route response cache: cold miss forwards, warm hit served under synthetic peer epoch", async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream("json");
  try {
    const port = Number.parseInt(new URL(upstream.baseUrl).port, 10);
    // No local workload is written, so PEER_MODEL routes only via the peer snapshot.
    openaiProxy.__setOpenAIProxyClusterRoutingForTests(
      peerClusterRouting(upstream.baseUrl, port, Date.now()),
    );
    const body = JSON.stringify({
      model: PEER_MODEL,
      messages: [{ role: "user", content: "peer cached json" }],
      temperature: 0,
    });

    // Cold miss: forwarded across the node boundary exactly once.
    const first = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    expect(first.status).toBe(200);
    expect(upstream.calls).toBe(1);

    // Warm hit: served from THIS proxy's cache without a second cross-node round-trip.
    const second = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    const secondJson = (await second.json()) as { id: string };
    expect(second.status).toBe(200);
    expect(secondJson.id).toBe("chatcmpl-1");
    expect(upstream.calls).toBe(1);
    expect(openaiProxy.__getOpenAIProxyResponseCacheHitTotalForTests(runtime.env)).toBe(1);

    // The entry is keyed on the synthetic peer epoch `peer:<node>:<model>` and the
    // peer workload id `<node>:<model>` — not a local/empty workload epoch.
    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    const peerScope = lookupScope({
      sha: canonicalRequestSha(body),
      model: PEER_MODEL,
      workload: `${PEER_NODE_ID}:${PEER_MODEL}`,
      workloadEpoch: `peer:${PEER_NODE_ID}:${PEER_MODEL}`,
    });
    expect(registry.findBySha(peerScope)).not.toBeNull();
    // A lookup under any other epoch must miss — proves the key is the synthetic
    // peer epoch and not an accidental local/empty one.
    expect(registry.findBySha({ ...peerScope, workloadEpoch: "local-style-epoch" })).toBeNull();
    storage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("peer route cache survives a peer re-poll (stable synthetic epoch, no re-forward)", async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream("json");
  try {
    const port = Number.parseInt(new URL(upstream.baseUrl).port, 10);
    openaiProxy.__setOpenAIProxyClusterRoutingForTests(
      peerClusterRouting(upstream.baseUrl, port, Date.now()),
    );
    const body = JSON.stringify({
      model: PEER_MODEL,
      messages: [{ role: "user", content: "peer survives repoll" }],
      temperature: 0,
    });

    const first = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    expect(first.status).toBe(200);
    expect(upstream.calls).toBe(1);

    // The poller refreshes the snapshot (new fetchedAt) — modelling a peer-side
    // restart of the SAME model. The synthetic epoch keys on node+model only, so
    // the cached deterministic response is still served (documents the trade-off:
    // a different model swapped under the same peer alias would need a manual flush).
    openaiProxy.__setOpenAIProxyClusterRoutingForTests(
      peerClusterRouting(upstream.baseUrl, port, Date.now()),
    );

    const second = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    expect(second.status).toBe(200);
    expect(((await second.json()) as { id: string }).id).toBe("chatcmpl-1");
    expect(upstream.calls).toBe(1);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("a response-cache DB failure on lookup degrades to upstream pass-through (no 500)", async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream("json");
  // findBySha is the bare DB read inside maybeResponseCacheLookup. A concurrent
  // WAL writer raises SQLITE_BUSY; the proxy must degrade to a cold miss, not 500.
  const findSpy = spyOn(ResponseCacheRegistry.prototype, "findBySha").mockImplementation(() => {
    throw new Error("SQLITE_BUSY: database is locked");
  });
  try {
    const url = new URL(upstream.baseUrl);
    const model = "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf";
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10), model);
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "db busy lookup" }],
      temperature: 0,
    });

    const response = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    expect(response.status).toBe(200);
    expect(upstream.calls).toBe(1);
  } finally {
    findSpy.mockRestore();
    await upstream.close();
    runtime.cleanup();
  }
});

test("peer route cache invalidates when the peer revision changes (restart/swap)", async () => {
  const runtime = makeTempRuntime();
  const upstream = await startUpstream("json");
  try {
    const port = Number.parseInt(new URL(upstream.baseUrl).port, 10);
    // Boot 1 advertises revision rev-1.
    openaiProxy.__setOpenAIProxyClusterRoutingForTests(
      peerClusterRouting(upstream.baseUrl, port, Date.now(), "rev-1"),
    );
    const body = JSON.stringify({
      model: PEER_MODEL,
      messages: [{ role: "user", content: "peer revision invalidation" }],
      temperature: 0,
    });
    const mkReq = (): Request =>
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

    // Cold miss then warm hit under rev-1 — exactly one cross-node forward.
    expect((await openaiProxy.proxyOpenAI(mkReq(), runtime.env)).status).toBe(200);
    expect((await openaiProxy.proxyOpenAI(mkReq(), runtime.env)).status).toBe(200);
    expect(upstream.calls).toBe(1);

    // The peer restarts with a new boot token (rev-2) — e.g. a model/quant swap
    // under the same alias. The revision-qualified epoch changes, so the identical
    // request misses the rev-1 entry and is re-forwarded (automatic invalidation).
    openaiProxy.__setOpenAIProxyClusterRoutingForTests(
      peerClusterRouting(upstream.baseUrl, port, Date.now(), "rev-2"),
    );
    expect((await openaiProxy.proxyOpenAI(mkReq(), runtime.env)).status).toBe(200);
    expect(upstream.calls).toBe(2);

    // Each boot's entry is stored under its own revision-qualified epoch.
    const storage = openResponseCacheStorage(runtime.root);
    const registry = new ResponseCacheRegistry(storage);
    const scopeFor = (rev: string): LookupScope =>
      lookupScope({
        sha: canonicalRequestSha(body),
        model: PEER_MODEL,
        workload: `${PEER_NODE_ID}:${PEER_MODEL}`,
        workloadEpoch: `peer:${PEER_NODE_ID}:${PEER_MODEL}:${rev}`,
      });
    expect(registry.findBySha(scopeFor("rev-1"))).not.toBeNull();
    expect(registry.findBySha(scopeFor("rev-2"))).not.toBeNull();
    storage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

function writeModelHostWorkload(
  runtimeRoot: string,
  workload: string,
  port: number,
  engine: "omlx" | "llamacpp",
  modelAliases: string[],
): void {
  const dir = join(runtimeRoot, "workloads", workload);
  const slotDir = join(runtimeRoot, "kvstore", "slots", workload);
  mkdirSync(dir, { recursive: true });
  mkdirSync(slotDir, { recursive: true });
  writeFileSync(join(dir, "modelhost.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(dir, "modelhost.state"),
    JSON.stringify({
      kind: "ModelHost",
      engine,
      pid: process.pid,
      host: "127.0.0.1",
      port,
      modelAliases,
      startedAt: "2026-05-24T00:00:00.000Z",
      slotSavePath: slotDir,
    }),
  );
}

test("oMLX save-handle: response-cache key normalized to stream:false so stream:true and stream:false share a cache entry", async () => {
  const runtime = makeTempRuntime();
  const model = "mlx-community/Qwen3-8B-MLX-4bit";
  const port = 19503;
  writeModelHostWorkload(runtime.root, "wl-omlx", port, "omlx", [model]);

  let upstreamChatCalls = 0;
  const capturedStreamValues: unknown[] = [];
  function omlxUpstreamResponse(pathname: string, method: string, init?: RequestInit): Response {
    if (method === "GET" && pathname === "/v1/slots/capabilities") {
      return Response.json({
        slots: { api_version: 2, supports_request_handle: true, supports_save_handle: true },
      });
    }
    if (method === "POST" && pathname === "/v1/chat/completions") {
      upstreamChatCalls += 1;
      const body = typeof init?.body === "string" ? init.body : "";
      try {
        capturedStreamValues.push((JSON.parse(body) as { stream?: unknown }).stream);
      } catch {
        /* ignore */
      }
      return Response.json({
        id: "chatcmpl-omlx",
        object: "chat.completion",
        model,
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }
    return new Response("", { status: 404 });
  }
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method =
      init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    return Promise.resolve(omlxUpstreamResponse(new URL(url).pathname, method, init));
  }) as typeof fetch;

  try {
    const baseMessages = [{ role: "user", content: "omlx cache normalize stream" }];

    // Request 1: stream:true — the save-handle path forces stream:false upstream.
    // The response-cache key must be computed over the normalized (stream:false)
    // body so request 2 can produce the same key and get a cache hit.
    const resp1 = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: baseMessages,
          temperature: 0,
          stream: true,
        }),
      }),
      runtime.env,
    );
    expect(resp1.status).toBe(200);
    expect(upstreamChatCalls).toBe(1);
    // The proxy must have sent stream:false to upstream (save-handle forces it).
    expect(capturedStreamValues[0]).toBe(false);

    // Request 2: stream:false — identical logical content. After the fix the
    // cache key (SHA over stream:false body) matches the entry from request 1.
    const resp2 = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: baseMessages,
          temperature: 0,
          stream: false,
        }),
      }),
      runtime.env,
    );
    const resp2Json = (await resp2.json()) as { id?: string };
    expect(resp2.status).toBe(200);
    // Upstream must NOT be called a second time — this is a cache hit.
    expect(upstreamChatCalls).toBe(1);
    expect(resp2Json.id).toBe("chatcmpl-omlx");
    expect(openaiProxy.__getOpenAIProxyResponseCacheHitTotalForTests(runtime.env)).toBe(1);
  } finally {
    runtime.cleanup();
  }
});
