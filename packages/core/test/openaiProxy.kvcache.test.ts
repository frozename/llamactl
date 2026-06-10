import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";

import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import {
  EXT_FLAG_TOOL_MAP,
  type KvEntry,
  KvRegistry,
  openKvStorage,
  readTrailer,
  readWorkloadEpoch,
  writeTrailer,
} from "../src/kvstore/index.js";
import {
  __getOpenAIProxyKvModelMismatchTotalForTests,
  isRouteKvEligible,
} from "../src/openaiProxy.js";

interface TempRuntime {
  root: string;
  env: ResolvedEnv;
  cleanup: () => void;
}

interface TestUpstream {
  baseUrl: string;
  events: string[];
  close: () => Promise<void>;
}

interface SpyCalls {
  mock: { calls: unknown[][] };
}

function pidText(): string {
  return `${String(process.pid)}\n`;
}

function filenameFromBody(body: string): string {
  if (body.length === 0) return "";
  const parsed = JSON.parse(body) as { filename?: unknown };
  return typeof parsed.filename === "string" ? parsed.filename : "";
}

function makeTempRuntime(): TempRuntime {
  const root = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-kv-"));
  return {
    root,
    env: resolveEnv({
      DEV_STORAGE: root,
      LOCAL_AI_RUNTIME_DIR: root,
      LLAMA_CPP_MODELS: join(root, "models"),
      LLAMA_CPP_MACHINE_PROFILE: "balanced",
      LLAMA_CPP_QWEN_CTX_SIZE: "32768",
    }),
    cleanup: () => {
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
  const slotDir = join(runtimeRoot, "kvstore", "slots", workload);
  mkdirSync(dir, { recursive: true });
  mkdirSync(slotDir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), pidText());
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify({
      rel,
      extraArgs: [],
      slotSavePath: slotDir,
      host: "127.0.0.1",
      port,
      binary: "/x/llama-server",
      pid: process.pid,
      startedAt: "2026-05-24T00:00:00.000Z",
      tunedProfile: null,
    }),
  );
}

function writeModelHostWorkload(
  runtimeRoot: string,
  workload: string,
  port: number,
  engine: "omlx" | "llamacpp",
  modelAliases: string[] = ["Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf"],
): void {
  const dir = join(runtimeRoot, "workloads", workload);
  const slotDir = join(runtimeRoot, "kvstore", "slots", workload);
  mkdirSync(dir, { recursive: true });
  mkdirSync(slotDir, { recursive: true });
  writeFileSync(join(dir, "modelhost.pid"), pidText());
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

function startUpstream(opts: {
  slotBaseDir: string;
  saveMode?: "ok" | "invalid";
  restoreMode?: "ok" | "http_error";
  supportsRequestHandle?: boolean;
  supportsSaveHandle?: boolean;
  restoreEpoch?: string | null;
  chatMode?: "json" | "sse";
  firstJsonToken?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
}): Promise<TestUpstream> {
  const events: string[] = [];
  const saveMode = opts.saveMode ?? "ok";
  const restoreMode = opts.restoreMode ?? "ok";
  const supportsRequestHandle = opts.supportsRequestHandle ?? false;
  const supportsSaveHandle = opts.supportsSaveHandle ?? false;
  const restoreEpoch = opts.restoreEpoch ?? null;
  const chatMode = opts.chatMode ?? "json";
  const firstJsonToken = opts.firstJsonToken ?? "Hello";
  const toolCalls = opts.toolCalls ?? [];
  const slotBaseDir = opts.slotBaseDir;
  const baseUrl = "http://127.0.0.1:19502";
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method =
      init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    const parsed = new URL(url);
    if (method === "POST" && parsed.pathname.startsWith("/slots/")) {
      const action = parsed.searchParams.get("action");
      const body = typeof init?.body === "string" ? init.body : "";
      const filename = filenameFromBody(body);
      const absPath = join(slotBaseDir, filename);
      if (action === "restore") {
        events.push("slot-restore");
        if (restoreMode === "http_error")
          return Promise.resolve(Response.json({ error: "restore-fail" }, { status: 500 }));
        if (!existsSync(absPath))
          return Promise.resolve(Response.json({ error: "missing" }, { status: 404 }));
        return Promise.resolve(Response.json({ n_restored: 123, restore_epoch: restoreEpoch }));
      }
      if (action === "save") {
        events.push("slot-save");
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, "slot");
        if (saveMode === "invalid") return Promise.resolve(Response.json({ ok: true }));
        return Promise.resolve(Response.json({ n_saved: 321 }));
      }
      return Promise.resolve(Response.json({ error: "bad action" }, { status: 400 }));
    }
    if (method === "POST" && parsed.pathname === "/v1/chat/completions") {
      events.push("chat-forward");
      const body = typeof init?.body === "string" ? init.body : "";
      if (chatMode === "sse") {
        return Promise.resolve(
          new Response(`data: ${JSON.stringify({ id: "evt", body })}\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          id: "chatcmpl-1",
          object: "chat.completion",
          model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: [{ type: "text", text: `${firstJsonToken} world` }],
                ...(toolCalls.length > 0
                  ? {
                      tool_calls: toolCalls.map((call) => ({
                        id: call.id,
                        type: "function",
                        function: {
                          name: call.name,
                          arguments: call.arguments,
                        },
                      })),
                    }
                  : {}),
              },
              finish_reason: "stop",
            },
          ],
          echoed: body,
        }),
      );
    }
    if (method === "GET" && parsed.pathname === "/props") {
      return Promise.resolve(
        Response.json({
          slots: {
            api_version: supportsRequestHandle ? 2 : 1,
            supports_request_handle: supportsRequestHandle,
          },
        }),
      );
    }
    // oMLX advertises slot capabilities here instead of /props.
    if (method === "GET" && parsed.pathname === "/v1/slots/capabilities") {
      return Promise.resolve(
        Response.json({
          slots: {
            api_version: 2,
            supports_request_handle: true,
            supports_save_handle: supportsSaveHandle,
          },
        }),
      );
    }
    return Promise.resolve(new Response("", { status: 404 }));
  }) as typeof fetch;

  return Promise.resolve({
    baseUrl,
    events,
    close: () => Promise.resolve(),
  });
}

function shaForBody(body: string): string {
  return createHash("sha1").update(body).digest("hex");
}

function parsedConsoleDebugEvents(spy: SpyCalls): Record<string, unknown>[] {
  return spy.mock.calls
    .map((call: unknown[]) => {
      const [message] = call;
      if (typeof message !== "string") return null;
      try {
        return JSON.parse(message) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(
      (entry: Record<string, unknown> | null): entry is Record<string, unknown> => entry !== null,
    );
}

function entryTemplate(overrides: Partial<KvEntry>): KvEntry {
  return {
    sha: "sha",
    workload: "wl-a",
    model: null,
    upstreamSlotFile: "/tmp/file.kvslot",
    quantBits: 8,
    tokens: 128,
    ctxSize: 32768,
    hits: 0,
    createdAt: 1716576000000,
    lastUsed: 1716576000000,
    payloadBytes: 1024,
    textBytes: 1024,
    reason: "cold",
    prefixByteLength: 128,
    workloadEpoch: "epoch",
    quarantined: 0,
    state: "idle",
    firstResponseToken: null,
    extFlags: 0,
    ...overrides,
  };
}

const originalBudget = process.env.LLAMACTL_KV_WORKLOAD_BUDGET_MB;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBudget === undefined) delete process.env.LLAMACTL_KV_WORKLOAD_BUDGET_MB;
  else process.env.LLAMACTL_KV_WORKLOAD_BUDGET_MB = originalBudget;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

test("cold miss saves a new idle kv entry", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({ slotBaseDir });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));

    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "hello" }],
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

    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    const entry = registry.get(shaForBody(body));
    expect(entry).not.toBeNull();
    expect(entry?.state).toBe("idle");
    expect(entry?.workload).toBe("wl-a");
    expect(entry?.firstResponseToken).toBe("Hello world");
    storage.close();

    expect(upstream.events).toEqual(["chat-forward", "slot-save"]);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("uses ModelHost slotSavePath from state when persisting kv", async () => {
  const runtime = makeTempRuntime();
  const slotDir = join(runtime.root, "custom-slots");
  const upstream = await startUpstream({ slotBaseDir: slotDir, supportsSaveHandle: true });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelHostWorkload(runtime.root, "mlx-host", Number.parseInt(url.port, 10), "omlx");
    writeFileSync(
      join(runtime.root, "workloads", "mlx-host", "modelhost.state"),
      JSON.stringify({
        kind: "ModelHost",
        engine: "omlx",
        pid: process.pid,
        host: "127.0.0.1",
        port: Number.parseInt(url.port, 10),
        modelAliases: ["Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf"],
        startedAt: "2026-05-24T00:00:00.000Z",
        slotSavePath: slotDir,
      }),
    );

    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "hi" }],
    });
    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      runtime.env,
    );
    expect(res.status).toBe(200);
    expect(existsSync(join(slotDir, `${shaForBody(body)}.kvslot`))).toBe(true);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("ModelHost omlx without save-handle capability performs no cold-miss save (capability probe guards)", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  // No supportsSaveHandle: this upstream advertises no save-by-handle capability.
  const upstream = await startUpstream({ slotBaseDir });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelHostWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10), "omlx", [
      "mlx-community/Qwen3-8B-MLX-4bit",
    ]);
    writeFileSync(
      join(runtime.root, "workloads", "wl-a", "modelhost.state"),
      JSON.stringify({
        kind: "ModelHost",
        engine: "omlx",
        pid: process.pid,
        host: "127.0.0.1",
        port: Number.parseInt(url.port, 10),
        modelAliases: ["mlx-community/Qwen3-8B-MLX-4bit"],
        startedAt: "2026-05-24T00:00:00.000Z",
        slotSavePath: slotBaseDir,
        rel: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      }),
    );

    const body = JSON.stringify({
      model: "mlx-community/Qwen3-8B-MLX-4bit",
      messages: [{ role: "user", content: "hello" }],
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

    // oMLX is KV-eligible now, but this upstream advertises no supports_save_handle,
    // so the cold-miss save bails on the capability probe — nothing is saved.
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    expect(registry.get(shaForBody(body))).toBeNull();
    storage.close();

    expect(upstream.events).toEqual(["chat-forward"]);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("ModelHost omlx with save-handle capability saves a cold-miss kv entry (always-on)", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  // This upstream advertises supports_save_handle via /v1/slots/capabilities.
  const upstream = await startUpstream({ slotBaseDir, supportsSaveHandle: true });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelHostWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10), "omlx", [
      "mlx-community/Qwen3-8B-MLX-4bit",
    ]);
    writeFileSync(
      join(runtime.root, "workloads", "wl-a", "modelhost.state"),
      JSON.stringify({
        kind: "ModelHost",
        engine: "omlx",
        pid: process.pid,
        host: "127.0.0.1",
        port: Number.parseInt(url.port, 10),
        modelAliases: ["mlx-community/Qwen3-8B-MLX-4bit"],
        startedAt: "2026-05-24T00:00:00.000Z",
        slotSavePath: slotBaseDir,
        rel: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      }),
    );

    const body = JSON.stringify({
      model: "mlx-community/Qwen3-8B-MLX-4bit",
      messages: [{ role: "user", content: "hello" }],
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

    expect(upstream.events).toEqual(["chat-forward", "slot-save"]);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("kv eligibility: llamacpp ModelRun and oMLX ModelHost always participate; other arms excluded", () => {
  // oMLX ModelHosts are eligible unconditionally (symmetric with llama.cpp);
  // the supports_save_handle capability probe is the only runtime guard.
  expect(isRouteKvEligible({ kind: "ModelHost", engine: "omlx" })).toBe(true);
  expect(isRouteKvEligible({ kind: "ModelRun", engine: "llamacpp" })).toBe(true);
  // The other engine/kind combinations stay excluded.
  expect(isRouteKvEligible({ kind: "ModelHost", engine: "llamacpp" })).toBe(false);
  expect(isRouteKvEligible({ kind: "ModelRun", engine: "omlx" })).toBe(false);
});

test("anthropic cold save writes trailer toolMap and ext_flags when upstream returns tool_calls", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({
    slotBaseDir,
    toolCalls: [
      {
        id: "toolu_1",
        name: "lookup_weather",
        arguments: '{\n  "city": "Sao Paulo",\n  "units": "c"\n}',
      },
    ],
  });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const anthropicBody = {
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: [{ type: "text", text: "Use a tool" }] }],
      max_tokens: 32,
    };
    const response = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(anthropicBody),
      }),
      runtime.env,
    );
    expect(response.status).toBe(200);

    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    const entries = registry.listAll();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect((entry.extFlags & EXT_FLAG_TOOL_MAP) !== 0).toBe(true);
    const trailer = readTrailer(entry.upstreamSlotFile);
    expect(trailer?.toolMap?.toolu_1).toBe(
      '{"id":"toolu_1","type":"function","function":{"name":"lookup_weather","arguments":"{\\n  \\"city\\": \\"Sao Paulo\\",\\n  \\"units\\": \\"c\\"\\n}"}}',
    );
    storage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("warm hit restores slot before upstream forward", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({ slotBaseDir });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "warm" }],
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(body, "utf8"),
        prefixByteLength: Buffer.byteLength(body, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(body, "utf8"),
        textBytes: Buffer.byteLength(body, "utf8"),
        lastUsed: Date.now() - 10_000,
        createdAt: Date.now() - 10_000,
        firstResponseToken: "Hello world",
      }),
    );
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
    expect(upstream.events.indexOf("slot-restore")).toBeLessThan(
      upstream.events.indexOf("chat-forward"),
    );
    expect(upstream.events).toEqual(["slot-restore", "chat-forward"]);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("KV restore is skipped when the saved entry model differs from the request model (defense-in-depth)", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({ slotBaseDir });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "warm" }],
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    // Seed a hit whose stored model does NOT match the request's model.
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        model: "a-different-model",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(body, "utf8"),
        prefixByteLength: Buffer.byteLength(body, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(body, "utf8"),
        textBytes: Buffer.byteLength(body, "utf8"),
        lastUsed: Date.now() - 10_000,
        createdAt: Date.now() - 10_000,
        firstResponseToken: "Hello world",
      }),
    );
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
    // The model mismatch must prevent a restore; the request falls through to cold prefill.
    expect(upstream.events).not.toContain("slot-restore");
    expect(__getOpenAIProxyKvModelMismatchTotalForTests(runtime.env)).toBe(1);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("proxy injects x_omlx_request_handle and x_omlx_restore_epoch after successful restore", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({
    slotBaseDir,
    supportsRequestHandle: true,
    restoreEpoch: "abc",
  });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "warm inject" }],
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(body, "utf8"),
        prefixByteLength: Buffer.byteLength(body, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(body, "utf8"),
        textBytes: Buffer.byteLength(body, "utf8"),
        firstResponseToken: "Hello world",
      }),
    );
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
    const responseJson = (await response.json()) as { echoed?: string };
    const echoed = JSON.parse(responseJson.echoed ?? "{}") as Record<string, unknown>;
    expect(echoed.x_omlx_request_handle).toBe(sha);
    expect(echoed.x_omlx_restore_epoch).toBe("abc");
    expect(upstream.events).toEqual(["slot-restore", "chat-forward"]);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("proxy does not inject vendor fields when request-handle capability is unsupported", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({
    slotBaseDir,
    supportsRequestHandle: false,
    restoreEpoch: "abc",
  });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "warm unsupported" }],
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(body, "utf8"),
        prefixByteLength: Buffer.byteLength(body, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(body, "utf8"),
        textBytes: Buffer.byteLength(body, "utf8"),
        firstResponseToken: "Hello world",
      }),
    );
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
    const responseJson = (await response.json()) as { echoed?: string };
    const echoed = JSON.parse(responseJson.echoed ?? "{}") as Record<string, unknown>;
    expect(echoed.x_omlx_request_handle).toBeUndefined();
    expect(echoed.x_omlx_restore_epoch).toBeUndefined();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("proxy does not inject vendor fields when restore fails", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({
    slotBaseDir,
    restoreMode: "http_error",
    supportsRequestHandle: true,
    restoreEpoch: "abc",
  });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "restore fail no inject" }],
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(body, "utf8"),
        prefixByteLength: Buffer.byteLength(body, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(body, "utf8"),
        textBytes: Buffer.byteLength(body, "utf8"),
        firstResponseToken: "Hello world",
      }),
    );
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
    const responseJson = (await response.json()) as { echoed?: string };
    const echoed = JSON.parse(responseJson.echoed ?? "{}") as Record<string, unknown>;
    expect(echoed.x_omlx_request_handle).toBeUndefined();
    expect(echoed.x_omlx_restore_epoch).toBeUndefined();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("proxy does not inject vendor fields when restore_epoch is null", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({
    slotBaseDir,
    supportsRequestHandle: true,
    restoreEpoch: null,
  });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "restore epoch null" }],
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(body, "utf8"),
        prefixByteLength: Buffer.byteLength(body, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(body, "utf8"),
        textBytes: Buffer.byteLength(body, "utf8"),
        firstResponseToken: "Hello world",
      }),
    );
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
    const responseJson = (await response.json()) as { echoed?: string };
    const echoed = JSON.parse(responseJson.echoed ?? "{}") as Record<string, unknown>;
    expect(echoed.x_omlx_request_handle).toBeUndefined();
    expect(echoed.x_omlx_restore_epoch).toBeUndefined();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("proxy injects vendor fields at top-level only", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({
    slotBaseDir,
    supportsRequestHandle: true,
    restoreEpoch: "abc",
  });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "top-level only" }],
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(body, "utf8"),
        prefixByteLength: Buffer.byteLength(body, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(body, "utf8"),
        textBytes: Buffer.byteLength(body, "utf8"),
        firstResponseToken: "Hello world",
      }),
    );
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
    const responseJson = (await response.json()) as { echoed?: string };
    const echoed = JSON.parse(responseJson.echoed ?? "{}") as {
      x_omlx_request_handle?: unknown;
      x_omlx_restore_epoch?: unknown;
      messages?: { x_omlx_request_handle?: unknown; x_omlx_restore_epoch?: unknown }[];
    };
    expect(echoed.x_omlx_request_handle).toBe(sha);
    expect(echoed.x_omlx_restore_epoch).toBe("abc");
    expect(Array.isArray(echoed.messages)).toBe(true);
    expect(echoed.messages?.[0]?.x_omlx_request_handle).toBeUndefined();
    expect(echoed.messages?.[0]?.x_omlx_restore_epoch).toBeUndefined();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("phase4b logs slot injection applied event on success", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({
    slotBaseDir,
    supportsRequestHandle: true,
    restoreEpoch: "abc",
  });
  const debugSpy = spyOn(console, "debug").mockImplementation(() => undefined);
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "apply event" }],
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(body, "utf8"),
        prefixByteLength: Buffer.byteLength(body, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(body, "utf8"),
        textBytes: Buffer.byteLength(body, "utf8"),
        firstResponseToken: "Hello world",
      }),
    );
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

    expect(parsedConsoleDebugEvents(debugSpy)).toContainEqual({
      event: "slot_injection_applied",
      workload: "wl-a",
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      request_handle: sha,
      restore_epoch_prefix: "abc...",
    });
  } finally {
    debugSpy.mockRestore();
    await upstream.close();
    runtime.cleanup();
  }
});

test("phase4b logs slot injection skipped with capability_missing reason", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({
    slotBaseDir,
    supportsRequestHandle: false,
    restoreEpoch: "abc",
  });
  const debugSpy = spyOn(console, "debug").mockImplementation(() => undefined);
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "skip capability" }],
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(body, "utf8"),
        prefixByteLength: Buffer.byteLength(body, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(body, "utf8"),
        textBytes: Buffer.byteLength(body, "utf8"),
        firstResponseToken: "Hello world",
      }),
    );
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

    expect(parsedConsoleDebugEvents(debugSpy)).toContainEqual({
      event: "slot_injection_skipped",
      workload: "wl-a",
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      reason: "capability_missing",
    });
  } finally {
    debugSpy.mockRestore();
    await upstream.close();
    runtime.cleanup();
  }
});

test("phase4b logs slot injection skipped with no_restore_epoch reason", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({
    slotBaseDir,
    supportsRequestHandle: true,
    restoreEpoch: null,
  });
  const debugSpy = spyOn(console, "debug").mockImplementation(() => undefined);
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "skip epoch" }],
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(body, "utf8"),
        prefixByteLength: Buffer.byteLength(body, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(body, "utf8"),
        textBytes: Buffer.byteLength(body, "utf8"),
        firstResponseToken: "Hello world",
      }),
    );
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

    expect(parsedConsoleDebugEvents(debugSpy)).toContainEqual({
      event: "slot_injection_skipped",
      workload: "wl-a",
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      reason: "no_restore_epoch",
    });
  } finally {
    debugSpy.mockRestore();
    await upstream.close();
    runtime.cleanup();
  }
});

test("proxy strips user supplied x_omlx_request_handle at ingress", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({
    slotBaseDir,
    supportsRequestHandle: true,
    restoreEpoch: "abc",
  });
  const debugSpy = spyOn(console, "debug").mockImplementation(() => undefined);
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "strip handle" }],
      x_omlx_request_handle: "user-handle",
    });
    const strippedBody = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "strip handle" }],
    });
    const sha = shaForBody(strippedBody);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(strippedBody, "utf8"),
        prefixByteLength: Buffer.byteLength(strippedBody, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(strippedBody, "utf8"),
        textBytes: Buffer.byteLength(strippedBody, "utf8"),
        firstResponseToken: "Hello world",
      }),
    );
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
    const responseJson = (await response.json()) as { echoed?: string };
    const echoed = JSON.parse(responseJson.echoed ?? "{}") as Record<string, unknown>;
    expect(echoed.x_omlx_request_handle).toBe(sha);
    expect(echoed.x_omlx_restore_epoch).toBe("abc");
    expect(parsedConsoleDebugEvents(debugSpy)).toContainEqual({
      event: "slot_injection_user_supplied_stripped",
      workload: "wl-a",
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      had_handle: true,
      had_epoch: false,
      had_save_handle: false,
    });
  } finally {
    debugSpy.mockRestore();
    await upstream.close();
    runtime.cleanup();
  }
});

test("proxy strips user supplied x_omlx_restore_epoch at ingress", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({
    slotBaseDir,
    supportsRequestHandle: true,
    restoreEpoch: "abc",
  });
  const debugSpy = spyOn(console, "debug").mockImplementation(() => undefined);
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "strip epoch" }],
      x_omlx_restore_epoch: "user-epoch",
    });
    const strippedBody = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "strip epoch" }],
    });
    const sha = shaForBody(strippedBody);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(strippedBody, "utf8"),
        prefixByteLength: Buffer.byteLength(strippedBody, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(strippedBody, "utf8"),
        textBytes: Buffer.byteLength(strippedBody, "utf8"),
        firstResponseToken: "Hello world",
      }),
    );
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
    const responseJson = (await response.json()) as { echoed?: string };
    const echoed = JSON.parse(responseJson.echoed ?? "{}") as Record<string, unknown>;
    expect(echoed.x_omlx_request_handle).toBe(sha);
    expect(echoed.x_omlx_restore_epoch).toBe("abc");
    expect(parsedConsoleDebugEvents(debugSpy)).toContainEqual({
      event: "slot_injection_user_supplied_stripped",
      workload: "wl-a",
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      had_handle: false,
      had_epoch: true,
      had_save_handle: false,
    });
  } finally {
    debugSpy.mockRestore();
    await upstream.close();
    runtime.cleanup();
  }
});

test("proxy injection overwrites user supplied vendor fields", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({
    slotBaseDir,
    supportsRequestHandle: true,
    restoreEpoch: "abc",
  });
  const debugSpy = spyOn(console, "debug").mockImplementation(() => undefined);
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "overwrite handle" }],
      x_omlx_request_handle: "user-handle",
      x_omlx_restore_epoch: "user-epoch",
    });
    const strippedBody = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "overwrite handle" }],
    });
    const sha = shaForBody(strippedBody);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(strippedBody, "utf8"),
        prefixByteLength: Buffer.byteLength(strippedBody, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(strippedBody, "utf8"),
        textBytes: Buffer.byteLength(strippedBody, "utf8"),
        firstResponseToken: "Hello world",
      }),
    );
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
    const responseJson = (await response.json()) as { echoed?: string };
    const echoed = JSON.parse(responseJson.echoed ?? "{}") as Record<string, unknown>;
    expect(echoed.x_omlx_request_handle).toBe(sha);
    expect(echoed.x_omlx_restore_epoch).toBe("abc");
    const debugEvents = parsedConsoleDebugEvents(debugSpy);
    expect(debugEvents).toContainEqual({
      event: "slot_injection_user_supplied_stripped",
      workload: "wl-a",
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      had_handle: true,
      had_epoch: true,
      had_save_handle: false,
    });
    expect(parsedConsoleDebugEvents(debugSpy)).toContainEqual({
      event: "slot_injection_applied",
      workload: "wl-a",
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      request_handle: sha,
      restore_epoch_prefix: "abc...",
    });
    expect(debugEvents).not.toContainEqual({
      event: "slot_injection_overwrote_user_field",
      workload: "wl-a",
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      user_value: "user-handle",
      proxy_value: "abc",
    });
  } finally {
    debugSpy.mockRestore();
    await upstream.close();
    runtime.cleanup();
  }
});

test("warm-hit lease is released when response-cache buffering throws before kv persist", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({ slotBaseDir });
  const nativeFetch = globalThis.fetch;
  const nativeArrayBuffer = (response: Response): Promise<ArrayBuffer> =>
    Response.prototype.arrayBuffer.call(response);
  const arrayBufferSpy = spyOn(Response.prototype, "arrayBuffer").mockImplementation(function (
    this: Response,
  ): Promise<ArrayBuffer> {
    if (this.headers.get("x-fail-buffer") === "1") {
      return Promise.reject(new Error("simulated arrayBuffer failure"));
    }
    return nativeArrayBuffer(this);
  });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((
    ...args: Parameters<typeof fetch>
  ) => {
    const [input, init] = args;
    const target =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (target.includes("/v1/chat/completions")) {
      const failing = new Response('{"id":"chatcmpl-throw"}', {
        status: 200,
        headers: { "content-type": "application/json", "x-fail-buffer": "1" },
      });
      return Promise.resolve(failing);
    }
    return nativeFetch(input, init);
  }) as typeof fetch);
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "lease release on throw" }],
      temperature: 0,
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(body, "utf8"),
        prefixByteLength: Buffer.byteLength(body, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(body, "utf8"),
        textBytes: Buffer.byteLength(body, "utf8"),
        firstResponseToken: "Hello world",
      }),
    );
    storage.close();

    let thrown: unknown;
    try {
      await Promise.resolve().then(() =>
        openaiProxy.proxyOpenAI(
          new Request("http://localhost/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
          runtime.env,
        ),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("simulated arrayBuffer failure");

    const afterStorage = openKvStorage(runtime.root);
    const afterRegistry = new KvRegistry(afterStorage);
    expect(afterRegistry.get(sha)?.state).toBe("idle");
    afterStorage.close();
  } finally {
    arrayBufferSpy.mockRestore();
    fetchSpy.mockRestore();
    await upstream.close();
    runtime.cleanup();
  }
});

test("anthropic warm hit replays with trailer toolMap bytes and keeps warm path when sha matches", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({ slotBaseDir });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const anthropicBody = {
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "tool call" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "lookup_weather",
              input: { city: "Sao Paulo" },
            },
          ],
        },
      ],
      max_tokens: 16,
    };
    const translatedBody = JSON.stringify({
      model: anthropicBody.model,
      messages: [
        {
          role: "assistant",
          content: "tool call",
          tool_calls: [
            {
              id: "toolu_1",
              type: "function",
              function: {
                name: "lookup_weather",
                arguments: '{"city":"Sao Paulo"}',
              },
            },
          ],
        },
      ],
      max_tokens: 16,
    });
    const sha = shaForBody(translatedBody);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(translatedBody, "utf8"),
        prefixByteLength: Buffer.byteLength(translatedBody, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(translatedBody, "utf8"),
        textBytes: Buffer.byteLength(translatedBody, "utf8"),
        firstResponseToken: "Hello world",
        extFlags: EXT_FLAG_TOOL_MAP,
      }),
    );
    expect(
      writeTrailer(slotFile, {
        extFlags: EXT_FLAG_TOOL_MAP,
        toolMap: {
          toolu_1:
            '{"id":"toolu_1","type":"function","function":{"name":"lookup_weather","arguments":"{\\"city\\":\\"Sao Paulo\\"}"}}',
        },
      }),
    ).toEqual({ ok: true });
    storage.close();

    const response = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(anthropicBody),
      }),
      runtime.env,
    );
    expect(response.status).toBe(200);
    expect(upstream.events).toEqual(["slot-restore", "chat-forward"]);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("anthropic warm-hit trailer mismatch falls back to cold prefill and increments replay-mismatch counter", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({ slotBaseDir });
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const anthropicBody = {
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "tool call" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "lookup_weather",
              input: { city: "Sao Paulo" },
            },
          ],
        },
      ],
      max_tokens: 16,
    };
    const translatedBody = JSON.stringify({
      model: anthropicBody.model,
      messages: [
        {
          role: "assistant",
          content: "tool call",
          tool_calls: [
            {
              id: "toolu_1",
              type: "function",
              function: {
                name: "lookup_weather",
                arguments: '{"city":"Sao Paulo"}',
              },
            },
          ],
        },
      ],
      max_tokens: 16,
    });
    const sha = shaForBody(translatedBody);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(translatedBody, "utf8"),
        prefixByteLength: Buffer.byteLength(translatedBody, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(translatedBody, "utf8"),
        textBytes: Buffer.byteLength(translatedBody, "utf8"),
        firstResponseToken: "Hello world",
        extFlags: EXT_FLAG_TOOL_MAP,
      }),
    );
    expect(
      writeTrailer(slotFile, {
        extFlags: EXT_FLAG_TOOL_MAP,
        toolMap: {
          toolu_1:
            '{"id":"toolu_1","type":"function","function":{"name":"lookup_weather","arguments":"{\\n  \\"city\\": \\"Sao Paulo\\"\\n}"}}',
        },
      }),
    ).toEqual({ ok: true });
    storage.close();

    const response = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(anthropicBody),
      }),
      runtime.env,
    );
    expect(response.status).toBe(200);
    expect(openaiProxy.__getOpenAIProxyKvReplayMismatchTotalForTests(runtime.env)).toBe(1);
    expect(upstream.events).toEqual(["slot-restore", "chat-forward", "slot-save"]);
    expect(
      warnSpy.mock.calls.some((call) => String(call[0]).includes('"event":"kv_replay_mismatch"')),
    ).toBe(true);
  } finally {
    warnSpy.mockRestore();
    await upstream.close();
    runtime.cleanup();
  }
});

test("warm-hit mismatch on deterministic request increments false-hit counter and invalidates entry", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({ slotBaseDir, firstJsonToken: "Goodbye" });
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "deterministic false-hit" }],
      temperature: 0,
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(body, "utf8"),
        prefixByteLength: Buffer.byteLength(body, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(body, "utf8"),
        textBytes: Buffer.byteLength(body, "utf8"),
        firstResponseToken: "Hello world",
      }),
    );
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
    expect(openaiProxy.__getOpenAIProxyKvFalseHitTotalForTests(runtime.env)).toBe(1);

    const afterStorage = openKvStorage(runtime.root);
    const afterRegistry = new KvRegistry(afterStorage);
    expect(afterRegistry.get(sha)).toBeNull();
    afterStorage.close();
    expect(
      warnSpy.mock.calls.some((call) => String(call[0]).includes('"event":"kv_false_hit"')),
    ).toBe(true);
  } finally {
    warnSpy.mockRestore();
    await upstream.close();
    runtime.cleanup();
  }
});

test("warm-hit match on deterministic request keeps entry and counter unchanged", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({ slotBaseDir, firstJsonToken: "Hello" });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "deterministic match" }],
      temperature: 0,
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(body, "utf8"),
        prefixByteLength: Buffer.byteLength(body, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(body, "utf8"),
        textBytes: Buffer.byteLength(body, "utf8"),
        firstResponseToken: "Hello world",
      }),
    );
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
    expect(openaiProxy.__getOpenAIProxyKvFalseHitTotalForTests(runtime.env)).toBe(0);

    const afterStorage = openKvStorage(runtime.root);
    const afterRegistry = new KvRegistry(afterStorage);
    expect(afterRegistry.get(sha)).not.toBeNull();
    afterStorage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("warm-hit mismatch skips check when request is sampled and seed is missing", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({ slotBaseDir, firstJsonToken: "Goodbye" });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "sampled request" }],
      temperature: 0.7,
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(body, "utf8"),
        prefixByteLength: Buffer.byteLength(body, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(body, "utf8"),
        textBytes: Buffer.byteLength(body, "utf8"),
        firstResponseToken: "Hello world",
      }),
    );
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
    expect(openaiProxy.__getOpenAIProxyKvFalseHitTotalForTests(runtime.env)).toBe(0);

    const afterStorage = openKvStorage(runtime.root);
    const afterRegistry = new KvRegistry(afterStorage);
    expect(afterRegistry.get(sha)).not.toBeNull();
    afterStorage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("warm-hit skip when legacy entry has null fingerprint", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({ slotBaseDir, firstJsonToken: "Goodbye" });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "legacy null fingerprint" }],
      temperature: 0,
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(body, "utf8"),
        prefixByteLength: Buffer.byteLength(body, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(body, "utf8"),
        textBytes: Buffer.byteLength(body, "utf8"),
        firstResponseToken: null,
      }),
    );
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
    expect(openaiProxy.__getOpenAIProxyKvFalseHitTotalForTests(runtime.env)).toBe(0);

    const afterStorage = openKvStorage(runtime.root);
    const afterRegistry = new KvRegistry(afterStorage);
    expect(afterRegistry.get(sha)).not.toBeNull();
    afterStorage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("restore failure downgrades to cold prefill and deletes broken entry", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({
    slotBaseDir,
    saveMode: "invalid",
    restoreMode: "http_error",
  });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "broken restore" }],
    });
    const sha = shaForBody(body);
    const missingSlotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(missingSlotFile), { recursive: true });
    writeFileSync(missingSlotFile, "slot");
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: missingSlotFile,
        tokens: Buffer.byteLength(body, "utf8"),
        prefixByteLength: Buffer.byteLength(body, "utf8"),
        workloadEpoch: workloadEpoch!,
        payloadBytes: Buffer.byteLength(body, "utf8"),
        textBytes: Buffer.byteLength(body, "utf8"),
      }),
    );
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
    expect(upstream.events).toEqual(["slot-restore", "chat-forward", "slot-save"]);

    const afterStorage = openKvStorage(runtime.root);
    const afterRegistry = new KvRegistry(afterStorage);
    expect(afterRegistry.get(sha)).toBeNull();
    afterStorage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("epoch mismatch rejects stale hit and proceeds as cold prefill", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({ slotBaseDir });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "stale epoch" }],
    });
    const sha = shaForBody(body);
    const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
    mkdirSync(dirname(slotFile), { recursive: true });
    writeFileSync(slotFile, "slot");
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    registry.insert(
      entryTemplate({
        sha,
        workload: "wl-a",
        upstreamSlotFile: slotFile,
        tokens: Buffer.byteLength(body, "utf8"),
        prefixByteLength: Buffer.byteLength(body, "utf8"),
        workloadEpoch: "stale-epoch",
        payloadBytes: Buffer.byteLength(body, "utf8"),
        textBytes: Buffer.byteLength(body, "utf8"),
      }),
    );
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
    expect(upstream.events).toEqual(["chat-forward", "slot-save"]);
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("eviction trims over-budget workload entries and keeps new cold entry", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({ slotBaseDir });
  process.env.LLAMACTL_KV_WORKLOAD_BUDGET_MB = "1";
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    for (const [idx, sha] of ["old-a", "old-b", "old-c"].entries()) {
      const slotFile = join(runtime.root, "kvstore", "slots", "wl-a", `${sha}.kvslot`);
      mkdirSync(dirname(slotFile), { recursive: true });
      writeFileSync(slotFile, "slot");
      registry.insert(
        entryTemplate({
          sha,
          workload: "wl-a",
          upstreamSlotFile: slotFile,
          workloadEpoch: workloadEpoch!,
          payloadBytes: 420_000 + idx * 10_000,
          textBytes: 200_000,
          lastUsed: Date.now() - 10_000_000 - idx * 1_000,
        }),
      );
    }
    storage.close();

    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "evict me not" }],
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

    const afterStorage = openKvStorage(runtime.root);
    const afterRegistry = new KvRegistry(afterStorage);
    const entries = afterRegistry.listAll().filter((entry) => entry.workload === "wl-a");
    const totalBytes = entries.reduce((sum, entry) => sum + entry.payloadBytes, 0);
    expect(totalBytes).toBeLessThanOrEqual(1 * 1024 * 1024);
    expect(afterRegistry.get(shaForBody(body))).not.toBeNull();
    afterStorage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});

test("eviction blocked by active entry keeps active row and emits debug event", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({ slotBaseDir });
  process.env.LLAMACTL_KV_WORKLOAD_BUDGET_MB = "1";
  const debugSpy = spyOn(console, "debug").mockImplementation(() => undefined);
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const workloadEpoch = readWorkloadEpoch({ name: "wl-a" }, runtime.env);
    expect(workloadEpoch).not.toBeNull();
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);

    const activeSlot = join(runtime.root, "kvstore", "slots", "wl-a", "active.kvslot");
    mkdirSync(dirname(activeSlot), { recursive: true });
    writeFileSync(activeSlot, "slot");
    registry.insert(
      entryTemplate({
        sha: "active",
        workload: "wl-a",
        upstreamSlotFile: activeSlot,
        workloadEpoch: workloadEpoch!,
        payloadBytes: 900_000,
        state: "active",
        lastUsed: Date.now() - 9_000_000,
      }),
    );

    const idleSlot = join(runtime.root, "kvstore", "slots", "wl-a", "idle.kvslot");
    writeFileSync(idleSlot, "slot");
    registry.insert(
      entryTemplate({
        sha: "idle",
        workload: "wl-a",
        upstreamSlotFile: idleSlot,
        workloadEpoch: workloadEpoch!,
        payloadBytes: 700_000,
        state: "idle",
        lastUsed: Date.now() - 8_000_000,
      }),
    );
    storage.close();

    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "active stays" }],
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
    expect(debugSpy).toHaveBeenCalled();
    expect(
      debugSpy.mock.calls.some((call) =>
        String(call[0]).includes("slot_eviction_blocked_active_request"),
      ),
    ).toBe(true);

    const afterStorage = openKvStorage(runtime.root);
    const afterRegistry = new KvRegistry(afterStorage);
    expect(afterRegistry.get("active")?.state).toBe("active");
    afterStorage.close();
  } finally {
    debugSpy.mockRestore();
    await upstream.close();
    runtime.cleanup();
  }
});

test("sse response skips kv save", async () => {
  const runtime = makeTempRuntime();
  const slotBaseDir = join(runtime.root, "kvstore", "slots", "wl-a");
  const upstream = await startUpstream({ slotBaseDir, chatMode: "sse" });
  try {
    const url = new URL(upstream.baseUrl);
    writeModelRunWorkload(runtime.root, "wl-a", Number.parseInt(url.port, 10));
    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "stream it" }],
      stream: true,
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
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const storage = openKvStorage(runtime.root);
    const registry = new KvRegistry(storage);
    expect(registry.get(shaForBody(body))).toBeNull();
    storage.close();
  } finally {
    await upstream.close();
    runtime.cleanup();
  }
});
