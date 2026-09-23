import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";
import type { PeerSnapshot } from "../src/workloadRuntime.js";

import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import { KvRegistry, openKvStorage } from "../src/kvstore/index.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { installConditionalChatUpstream } from "./conditionalUpstream.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

function tempEnv(): { env: ResolvedEnv; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-responses-"));
  return {
    env: resolveEnv({
      DEV_STORAGE: dir,
      LOCAL_AI_RUNTIME_DIR: dir,
      LLAMA_CPP_MODELS: join(dir, "models"),
      LLAMA_CPP_MACHINE_PROFILE: "balanced",
      LLAMA_CPP_QWEN_CTX_SIZE: "32768",
    }),
    dir,
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function pidText(): string {
  return `${String(process.pid)}\n`;
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

function shaForBody(body: string): string {
  return createHash("sha1").update(body).digest("hex");
}

function slotActionResponse(
  parsed: URL,
  init: RequestInit | undefined,
  events: string[],
  slotBaseDir: string,
): Response {
  const action = parsed.searchParams.get("action");
  if (action === "save") {
    events.push("slot-save");
    const body = typeof init?.body === "string" ? init.body : "";
    const parsedBody = JSON.parse(body) as { filename?: string };
    const filename = parsedBody.filename ?? "slot.kvslot";
    writeFileSync(join(slotBaseDir, filename), "slot");
    return Response.json({ n_saved: 321 });
  }
  return Response.json({ ok: true });
}

function kvAwareFetchMock(events: string[], slotBaseDir: string): typeof fetch {
  return ((input: Request | URL | string, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url);
    const method =
      init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    if (method === "POST" && parsed.pathname === "/v1/chat/completions") {
      events.push("chat-forward");
      return Response.json({
        id: "chatcmpl-1",
        object: "chat.completion",
        model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello world" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });
    }
    if (method === "POST" && parsed.pathname.startsWith("/slots/")) {
      return slotActionResponse(parsed, init, events, slotBaseDir);
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

/**
 * /v1/responses POST must be translated to /v1/chat/completions and flow
 * through the KV-gated path. The proof is that a KV slot is saved after
 * the request — slot save only fires when shouldUseKvPath returns true
 * (which requires pathname === "/v1/chat/completions" after the rewrite).
 */
test("/v1/responses POST reaches the KV path and saves a slot", async () => {
  const t = tempEnv();
  try {
    const port = 19510;
    writeModelRunWorkload(t.dir, "wl-a", port);

    const events: string[] = [];
    const slotBaseDir = join(t.dir, "kvstore", "slots", "wl-a");
    globalThis.fetch = kvAwareFetchMock(events, slotBaseDir);

    const requestBody = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      input: "hello",
    });
    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      }),
      t.env,
    );
    expect(res.status).toBe(200);

    expect(events).toContain("chat-forward");
    expect(events).toContain("slot-save");

    const storage = openKvStorage(t.dir);
    const registry = new KvRegistry(storage);
    const allEntries = registry.listAll();
    expect(allEntries.length).toBeGreaterThanOrEqual(1);
    const savedEntry = allEntries.find((e) => e.workload === "wl-a");
    expect(savedEntry).toBeDefined();
    expect(savedEntry?.state).toBe("idle");
    storage.close();
  } finally {
    t.cleanup();
  }
});

/**
 * /v1/responses request body must be translated to chat-completions shape.
 * The upstream should receive a body with `messages` array, not `input`.
 */
test("/v1/responses translates request body to chat-completions shape", async () => {
  const t = tempEnv();
  try {
    let capturedBody: string | null = null;
    let capturedUrl: string | null = null;
    globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      capturedUrl = url;
      capturedBody = typeof init?.body === "string" ? init.body : null;
      return Response.json({
        id: "chatcmpl-1",
        object: "chat.completion",
        model: "test-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello back" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      });
    }) as unknown as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          input: "Tell me a joke",
          instructions: "You are a comedian",
        }),
      }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(capturedUrl!).toContain("/v1/chat/completions");
    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody!) as { messages?: unknown; model?: unknown };
    expect(parsed).toHaveProperty("messages");
    expect(parsed).not.toHaveProperty("input");
    expect(parsed.messages).toEqual([
      { role: "system", content: "You are a comedian" },
      { role: "user", content: "Tell me a joke" },
    ]);
    expect(parsed.model).toBe("test-model");
  } finally {
    t.cleanup();
  }
});

/**
 * /v1/responses response must be translated back to the Responses API shape.
 */
test("/v1/responses translates non-streaming JSON response back to responses shape", async () => {
  const t = tempEnv();
  try {
    globalThis.fetch = (() =>
      Response.json(
        {
          id: "chatcmpl-1",
          object: "chat.completion",
          model: "test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello back" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        },
        { headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          input: "hi",
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["object"]).toBe("response");
    expect(body["status"]).toBe("completed");
    expect(body["model"]).toBe("test-model");
    expect(body["output"]).toEqual([
      {
        type: "message",
        id: "msg_chatcmpl-1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello back" }],
      },
    ]);
    expect(body["usage"]).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
    });
  } finally {
    t.cleanup();
  }
});

/**
 * /v1/responses with tool_calls in the response translates to function_call output items.
 */
test("/v1/responses translates tool_calls in response to function_call output items", async () => {
  const t = tempEnv();
  try {
    globalThis.fetch = (() =>
      Response.json(
        {
          id: "chatcmpl-1",
          object: "chat.completion",
          model: "test-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "get_weather", arguments: '{"city":"SF"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 10 },
        },
        { headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          input: "what's the weather?",
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      status: string;
      output: { type: string; name?: string; arguments?: string; call_id?: string }[];
    };
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    const fnCall = body.output.find((o) => o.type === "function_call");
    expect(fnCall).toBeDefined();
    expect(fnCall?.name).toBe("get_weather");
    expect(fnCall?.arguments).toBe('{"city":"SF"}');
    expect(fnCall?.call_id).toBe("call_1");
  } finally {
    t.cleanup();
  }
});

/**
 * /v1/responses with array input items (conversation history) translates correctly.
 */
test("/v1/responses translates array input items to chat messages", async () => {
  const t = tempEnv();
  try {
    let capturedBody: string | null = null;
    globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? init.body : null;
      return Response.json({
        id: "chatcmpl-1",
        object: "chat.completion",
        model: "test-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }) as unknown as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "hello" }],
            },
            {
              role: "assistant",
              content: [{ type: "output_text", text: "hi there" }],
            },
            {
              role: "user",
              content: [{ type: "input_text", text: "how are you?" }],
            },
          ],
        }),
      }),
      t.env,
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(capturedBody!) as { messages?: unknown; model?: unknown };
    expect(parsed.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "how are you?" },
    ]);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Regression tests: existing paths must behave identically after the change.
// ---------------------------------------------------------------------------

test("regression: /v1/chat/completions forwards body unchanged", async () => {
  const t = tempEnv();
  try {
    let capturedBody: string | null = null;
    let capturedUrl: string | null = null;
    globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      capturedUrl = url;
      capturedBody = typeof init?.body === "string" ? init.body : null;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    const body = JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
    });
    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(capturedUrl!).toContain("/v1/chat/completions");
    expect(capturedBody!).toBe(body);
  } finally {
    t.cleanup();
  }
});

test("regression: /v1/messages translates to /v1/chat/completions and response back to anthropic shape", async () => {
  const t = tempEnv();
  try {
    const calls: { url: string; body: string | null }[] = [];
    globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, body: typeof init?.body === "string" ? init.body : null });
      return Response.json(
        {
          id: "msg_1",
          model: "claude-3-7-sonnet",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        },
        { headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-7-sonnet",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 64,
        }),
      }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/v1/chat/completions");
    expect(calls[0]!.body).toBe(
      JSON.stringify({
        model: "claude-3-7-sonnet",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 64,
      }),
    );
    expect(await res.json()).toEqual({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      model: "claude-3-7-sonnet",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
  } finally {
    t.cleanup();
  }
});

test("regression: /v1/chat/completions KV path still saves a slot", async () => {
  const t = tempEnv();
  try {
    const port = 19511;
    writeModelRunWorkload(t.dir, "wl-a", port);

    const events: string[] = [];
    const slotBaseDir = join(t.dir, "kvstore", "slots", "wl-a");
    globalThis.fetch = kvAwareFetchMock(events, slotBaseDir);

    const body = JSON.stringify({
      model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
      messages: [{ role: "user", content: "hello" }],
    });
    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(events).toContain("chat-forward");
    expect(events).toContain("slot-save");

    const storage = openKvStorage(t.dir);
    const registry = new KvRegistry(storage);
    const entry = registry.get(shaForBody(body));
    expect(entry).not.toBeNull();
    expect(entry?.state).toBe("idle");
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("regression: /v1/messages KV path still saves a slot", async () => {
  const t = tempEnv();
  try {
    const port = 19512;
    writeModelRunWorkload(t.dir, "wl-a", port);

    const events: string[] = [];
    const slotBaseDir = join(t.dir, "kvstore", "slots", "wl-a");
    globalThis.fetch = kvAwareFetchMock(events, slotBaseDir);

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 64,
        }),
      }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(events).toContain("chat-forward");
    expect(events).toContain("slot-save");
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P0.1 (#129) characterization — /v1/responses ingress: local + peer routing,
// upstream-observed model/stream, and the fail-closed streaming envelope.
// ---------------------------------------------------------------------------

function writeKvFreeModelRun(runtimeRoot: string, workload: string, port: number, rel: string): void {
  // No slotSavePath: resolveRouteKvMetadata returns null, keeping this a
  // pure routing test (no KV slot machinery).
  const dir = join(runtimeRoot, "workloads", workload);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), pidText());
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

test("/v1/responses routes a local routable model to its workload endpoint", async () => {
  const t = tempEnv();
  try {
    writeKvFreeModelRun(t.dir, "wl-resp", 8145, "org/responses-model.gguf");
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "org/responses-model.gguf",
          input: "route me",
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:8145/v1/chat/completions");
    expect(call.body).toEqual({
      model: "org/responses-model.gguf",
      messages: [{ role: "user", content: "route me" }],
    });
  } finally {
    t.cleanup();
  }
});

test("/v1/responses routes a peer-only model to the peer endpoint", async () => {
  const t = tempEnv();
  try {
    openaiProxy.__setOpenAIProxyClusterRoutingForTests({
      clusterPeers: [
        { id: "peer-c", endpoint: "https://peer-c.local:7843", token: "peer-token-abc" },
      ],
      peerSnapshots: new Map<string, PeerSnapshot>([
        [
          "peer-c",
          {
            workloads: [{ modelId: "responses-peer-model", port: 9444 }],
            pressure: "NORMAL",
            fetchedAt: Date.now(),
          },
        ],
      ]),
    });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "responses-peer-model",
          input: "peer route me",
          instructions: "You are terse",
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0]!;
    expect(call.url).toBe("https://peer-c.local:7843/v1/chat/completions");
    expect(call.body).toEqual({
      model: "responses-peer-model",
      messages: [
        { role: "system", content: "You are terse" },
        { role: "user", content: "peer route me" },
      ],
    });
    expect(call.headers["authorization"]).toBe("Bearer peer-token-abc");
  } finally {
    t.cleanup();
  }
});

test("/v1/responses stream:true reaches upstream and the SSE answer fails closed with 501", async () => {
  const t = tempEnv();
  try {
    // Unlike the anthropic path, translateResponsesRequest DOES forward
    // `stream` — the honest upstream therefore returns SSE, which
    // maybeTranslateResponse refuses with the explicit 501 envelope
    // (responsesTranslationErrorResponse). This pins both halves:
    // stream propagation AND the documented streaming-unsupported surface.
    const upstream = installConditionalChatUpstream();
    writeKvFreeModelRun(t.dir, "wl-resp-stream", 8146, "org/stream-model.gguf");

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "org/stream-model.gguf",
          input: "stream me",
          stream: true,
        }),
      }),
      t.env,
    );

    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.body?.["stream"]).toBe(true);
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      error: {
        message: "streaming is not supported for /v1/responses",
        type: "responses_translation_error",
      },
    });
  } finally {
    t.cleanup();
  }
});
