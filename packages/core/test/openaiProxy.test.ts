import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RouteCandidate, RouteCatalog } from "../src/routing/catalog.js";
import type { ResolvedEnv } from "../src/types.js";
import type { PeerSnapshot } from "../src/workloadRuntime.js";

import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import * as routeCatalogModule from "../src/routing/catalog.js";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "../src/safe-fs.js";
import * as workloadRuntimeModule from "../src/workloadRuntime.js";
import { installConditionalChatUpstream } from "./conditionalUpstream.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

function tempEnv(extra?: Record<string, string>): {
  env: ResolvedEnv;
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-core-"));
  return {
    env: resolveEnv({
      DEV_STORAGE: dir,
      LOCAL_AI_RUNTIME_DIR: dir,
      LLAMA_CPP_MODELS: join(dir, "models"),
      ...extra,
    }),
    dir,
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  } satisfies { env: ResolvedEnv; dir: string; cleanup: () => void };
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

function anthropicChatRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("routes chat completions to a ModelHost by rel alias", async () => {
  const t = tempEnv();
  try {
    const workload = join(t.dir, "workloads", "mlx-host");
    mkdirSync(workload, { recursive: true });
    writeFileSync(join(workload, "modelhost.pid"), `${String(process.pid)}\n`);
    writeFileSync(
      join(workload, "modelhost.state"),
      JSON.stringify({
        kind: "ModelHost",
        engine: "omlx",
        pid: process.pid,
        host: "127.0.0.1",
        port: 8123,
        modelAliases: ["mlx-community/Qwen3-8B-MLX-4bit", "Qwen3-8B-MLX-4bit"],
        startedAt: new Date().toISOString(),
      }),
    );

    const calls: { url: string; body: string | null }[] = [];
    globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, body: typeof init?.body === "string" ? init.body : null });
      return Response.json({ echoed: { url } });
    }) as unknown as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mlx-community/Qwen3-8B-MLX-4bit",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      t.env,
    );
    expect(res.status).toBe(200);
    // Filter to the chat forward; omlx ModelHosts also probe /v1/slots/capabilities (KV, orthogonal to routing).
    const chatCalls = calls.filter((c) => c.url.includes("/v1/chat/completions"));
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]!.url).toBe("http://127.0.0.1:8123/v1/chat/completions");
    expect(chatCalls[0]!.body).toContain('"model":"mlx-community/Qwen3-8B-MLX-4bit"');
  } finally {
    t.cleanup();
  }
});

test("route cache invalidates when a workload state file is rewritten in place", async () => {
  const t = tempEnv();
  try {
    const workload = join(t.dir, "workloads", "mlx-host");
    mkdirSync(workload, { recursive: true });
    writeFileSync(join(workload, "modelhost.pid"), `${String(process.pid)}\n`);
    const writeState = (port: number): void => {
      writeFileSync(
        join(workload, "modelhost.state"),
        JSON.stringify({
          kind: "ModelHost",
          engine: "omlx",
          pid: process.pid,
          host: "127.0.0.1",
          port,
          modelAliases: ["mlx-community/Qwen3-8B-MLX-4bit", "Qwen3-8B-MLX-4bit"],
          startedAt: new Date().toISOString(),
        }),
      );
    };
    writeState(8123);

    const calls: string[] = [];
    globalThis.fetch = ((input: Request | URL | string) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    const req = (): Promise<Response> =>
      openaiProxy.proxyOpenAI(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "mlx-community/Qwen3-8B-MLX-4bit",
            messages: [{ role: "user", content: "hi" }],
          }),
        }),
        t.env,
      );

    await req();
    const builds1 = openaiProxy.__getOpenAIProxyRouteMapBuildCountForTests();
    await req();
    expect(openaiProxy.__getOpenAIProxyRouteMapBuildCountForTests()).toBe(builds1); // cached: no change

    // Restart the model on a new port by rewriting modelhost.state IN PLACE.
    // The parent workloads/ dir mtime does NOT change — the old parent-mtime key
    // would keep serving 8123; the per-subdir signature must invalidate.
    await new Promise((resolve) => setTimeout(resolve, 10));
    writeState(8200);

    await req();
    expect(openaiProxy.__getOpenAIProxyRouteMapBuildCountForTests()).toBe(builds1 + 1); // invalidated
    // Filter to chat forwards; omlx ModelHosts also probe /v1/slots/capabilities (KV, orthogonal to routing).
    const chatCalls = calls.filter((u) => u.includes("/v1/chat/completions"));
    expect(chatCalls[chatCalls.length - 1]).toBe("http://127.0.0.1:8200/v1/chat/completions");
  } finally {
    t.cleanup();
  }
});

test("routes chat completions to a ModelHost by basename alias", async () => {
  const t = tempEnv();
  try {
    const workload = join(t.dir, "workloads", "mlx-host");
    mkdirSync(workload, { recursive: true });
    writeFileSync(join(workload, "modelhost.pid"), `${String(process.pid)}\n`);
    writeFileSync(
      join(workload, "modelhost.state"),
      JSON.stringify({
        kind: "ModelHost",
        engine: "omlx",
        pid: process.pid,
        host: "127.0.0.1",
        port: 8124,
        modelAliases: ["mlx-community/Qwen3-8B-MLX-4bit", "Qwen3-8B-MLX-4bit"],
        startedAt: new Date().toISOString(),
      }),
    );

    const calls: { url: string }[] = [];
    globalThis.fetch = ((input: Request | URL | string) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "Qwen3-8B-MLX-4bit",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      t.env,
    );
    expect(res.status).toBe(200);
    // Filter to the chat forward; omlx ModelHosts also probe /v1/slots/capabilities (KV, orthogonal to routing).
    const chatCalls = calls.filter((c) => c.url.includes("/v1/chat/completions"));
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]!.url).toBe("http://127.0.0.1:8124/v1/chat/completions");
  } finally {
    t.cleanup();
  }
});

test("forwards chat completions with the current request shape intact", async () => {
  const t = tempEnv();
  try {
    const workload = join(t.dir, "workloads", "mlx-host");
    mkdirSync(workload, { recursive: true });
    writeFileSync(join(workload, "modelhost.pid"), `${String(process.pid)}\n`);
    writeFileSync(
      join(workload, "modelhost.state"),
      JSON.stringify({
        kind: "ModelHost",
        engine: "omlx",
        pid: process.pid,
        host: "127.0.0.1",
        port: 8125,
        modelAliases: ["mlx-community/Qwen3-8B-MLX-4bit"],
        startedAt: new Date("2026-05-23T00:00:00Z").toISOString(),
      }),
    );

    let observedRequest: Request | null = null;
    globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
      const request =
        typeof input === "string"
          ? new Request(input, init)
          : input instanceof URL
            ? new Request(input.toString(), init)
            : new Request(input, init);
      observedRequest = request;
      return Promise.resolve(request.clone().text()).then((body) =>
        Response.json(
          {
            ok: true,
            url: request.url,
            method: request.method,
            headers: [...request.headers.entries()].sort(),
            body,
          },
          {
            headers: { "x-upstream": "llama-server" },
          },
        ),
      );
    }) as unknown as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions?foo=bar", {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          connection: "keep-alive",
          "content-length": "999",
          "content-type": "application/json",
          host: "localhost",
          "x-test": "preserved",
        },
        body: JSON.stringify({
          model: "mlx-community/Qwen3-8B-MLX-4bit",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      body: '{"model":"mlx-community/Qwen3-8B-MLX-4bit","messages":[{"role":"user","content":"hi"}]}',
      headers: [
        ["content-type", "application/json"],
        ["x-test", "preserved"],
      ],
      method: "POST",
      ok: true,
      url: "http://127.0.0.1:8125/v1/chat/completions?foo=bar",
    });
    expect(res.headers.get("x-upstream")).toBe("llama-server");
    expect(observedRequest).not.toBeNull();
    expect(observedRequest!.headers.get("authorization")).toBeNull();
    expect(observedRequest!.headers.get("connection")).toBeNull();
    expect(observedRequest!.headers.get("content-length")).toBeNull();
    expect(observedRequest!.headers.get("host")).toBeNull();
  } finally {
    t.cleanup();
  }
});

test("/v1/messages translates into /v1/chat/completions and forwards upstream", async () => {
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
      new Request("http://localhost/v1/messages?foo=bar", {
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
    expect(calls[0]!.url).toContain("/v1/chat/completions?foo=bar");
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

test("/v1/messages rejects oversized content-length before reading body", async () => {
  const t = tempEnv();
  try {
    globalThis.fetch = (() => {
      throw new Error("upstream should not be called");
    }) as unknown as typeof fetch;
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "999999999",
      },
      body: "{}",
    });
    const textSpy = spyOn(req, "text");

    const res = await openaiProxy.proxyOpenAI(req, t.env);
    expect(res.status).toBe(413);
    expect(textSpy).not.toHaveBeenCalled();
  } finally {
    t.cleanup();
  }
});

test("/v1/messages translator errors return anthropic_translation_error with status 400", async () => {
  const t = tempEnv();
  try {
    globalThis.fetch = (() => {
      throw new Error("upstream should not be called");
    }) as unknown as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-7-sonnet",
          messages: [
            {
              role: "user",
              content: [{ type: "video", src: "x" }],
            },
          ],
        }),
      }),
      t.env,
    );
    expect(res.status).toBe(400);
    expect(await Promise.resolve(res.json())).toEqual({
      error: {
        message: "unsupported content block type: video",
        type: "anthropic_translation_error",
      },
    });
  } finally {
    t.cleanup();
  }
});

test("/v1/messages response translates non-streaming JSON back to anthropic shape", async () => {
  const t = tempEnv();
  try {
    globalThis.fetch = (() =>
      Response.json(
        {
          id: "msg_1",
          model: "claude-3-7-sonnet",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "hello",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "lookup_weather", arguments: '{"city":"Sao Paulo"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        },
        { headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-7-sonnet",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "hello" },
        {
          type: "tool_use",
          id: "call_1",
          name: "lookup_weather",
          input: { city: "Sao Paulo" },
        },
      ],
      model: "claude-3-7-sonnet",
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 20 },
    });
  } finally {
    t.cleanup();
  }
});

// Defect-tagged at cf60f20d: this only flips green once P1.2 (#132)
// propagates the client's `stream` flag — with the honest fixture an
// unflagged upstream body gets a JSON completion, not SSE.
test.failing("/v1/messages SSE responses translate to anthropic stream events", async () => {
  const t = tempEnv();
  try {
    installConditionalChatUpstream({
      sseBody:
        'data: {"id":"msg_1","choices":[{"delta":{"content":"hello"},"finish_reason":null}],"usage":{"completion_tokens":1}}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n",
    });

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-7-sonnet",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      }),
      t.env,
    );

    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const body = await res.text();
    expect(body.startsWith("event: message_start\n")).toBe(true);
  } finally {
    t.cleanup();
  }
});

test("route map cache build count stays stable across identical requests", async () => {
  const t = tempEnv();
  try {
    const workload = join(t.dir, "workloads", "mlx-host");
    mkdirSync(workload, { recursive: true });
    writeFileSync(join(workload, "modelhost.pid"), `${String(process.pid)}\n`);
    writeFileSync(
      join(workload, "modelhost.state"),
      JSON.stringify({
        kind: "ModelHost",
        engine: "omlx",
        pid: process.pid,
        host: "127.0.0.1",
        port: 8126,
        modelAliases: ["mlx-community/Qwen3-8B-MLX-4bit"],
        startedAt: new Date().toISOString(),
      }),
    );

    const seen: string[] = [];
    globalThis.fetch = ((input: Request | URL | string) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      seen.push(url);
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    const before = openaiProxy.__getOpenAIProxyRouteMapBuildCountForTests();
    for (let i = 0; i < 5; i += 1) {
      const res = await openaiProxy.proxyOpenAI(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "mlx-community/Qwen3-8B-MLX-4bit",
            messages: [{ role: "user", content: "hi" }],
          }),
        }),
        t.env,
      );
      expect(res.status).toBe(200);
    }
    // Filter to chat forwards; omlx ModelHosts also probe /v1/slots/capabilities (KV, orthogonal to routing).
    const chatCalls = seen.filter((u) => u.includes("/v1/chat/completions"));
    expect(chatCalls).toHaveLength(5);
    expect(openaiProxy.__getOpenAIProxyRouteMapBuildCountForTests()).toBe(before + 1);
  } finally {
    t.cleanup();
  }
});

test("listOpenAIModels differentiates host and agent ownership", () => {
  const t = tempEnv();
  try {
    const run = join(t.dir, "workloads", "run");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "llama-server.pid"), `${String(process.pid)}\n`);
    writeFileSync(
      join(run, "llama-server.state"),
      JSON.stringify({
        rel: "org/model.gguf",
        extraArgs: [],
        host: "127.0.0.1",
        port: 8111,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        tunedProfile: null,
      }),
    );

    const host = join(t.dir, "workloads", "host");
    mkdirSync(host, { recursive: true });
    writeFileSync(join(host, "modelhost.pid"), `${String(process.pid)}\n`);
    writeFileSync(
      join(host, "modelhost.state"),
      JSON.stringify({
        kind: "ModelHost",
        engine: "omlx",
        pid: process.pid,
        host: "127.0.0.1",
        port: 8112,
        modelAliases: ["mlx-community/Qwen3-8B-MLX-4bit"],
        startedAt: new Date().toISOString(),
      }),
    );

    const models = openaiProxy.listOpenAIModels(t.env);
    expect(models.data).toHaveLength(2);
    expect(models.data.find((entry) => entry.id === "org/model.gguf")?.owned_by).toBe(
      "llamactl-agent",
    );
    expect(
      models.data.find((entry) => entry.id === "mlx-community/Qwen3-8B-MLX-4bit")?.owned_by,
    ).toBe("llamactl-host");
  } finally {
    t.cleanup();
  }
});

test("basename alias collision prefers ModelRun over ModelHost and warns", () => {
  const t = tempEnv();
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const run = join(t.dir, "workloads", "run");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "llama-server.pid"), `${String(process.pid)}\n`);
    writeFileSync(
      join(run, "llama-server.state"),
      JSON.stringify({
        rel: "Qwen3-8B-MLX-4bit",
        extraArgs: [],
        host: "127.0.0.1",
        port: 8113,
        binary: "/x/llama-server",
        pid: process.pid,
        startedAt: "2026-05-19T00:00:00Z",
        tunedProfile: null,
      }),
    );

    const host = join(t.dir, "workloads", "host");
    mkdirSync(host, { recursive: true });
    writeFileSync(join(host, "modelhost.pid"), `${String(process.pid)}\n`);
    writeFileSync(
      join(host, "modelhost.state"),
      JSON.stringify({
        kind: "ModelHost",
        engine: "omlx",
        pid: process.pid,
        host: "127.0.0.1",
        port: 8114,
        modelAliases: ["Qwen3-8B-MLX-4bit"],
        startedAt: "2026-05-19T00:00:00Z",
      }),
    );

    const models = openaiProxy.listOpenAIModels(t.env);
    expect(models.data).toHaveLength(1);
    expect(models.data[0]?.owned_by).toBe("llamactl-agent");
    expect(warnSpy).toHaveBeenCalledWith(
      "[openaiProxy] route-map collision on model='Qwen3-8B-MLX-4bit': keeping ModelRun:run, ignoring ModelHost:host",
    );
  } finally {
    warnSpy.mockRestore();
    t.cleanup();
  }
});

test("same-kind alias collision keeps the alphabetically earlier workload", async () => {
  const t = tempEnv();
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const alpha = join(t.dir, "workloads", "alpha");
    mkdirSync(alpha, { recursive: true });
    writeFileSync(join(alpha, "modelhost.pid"), `${String(process.pid)}\n`);
    writeFileSync(
      join(alpha, "modelhost.state"),
      JSON.stringify({
        kind: "ModelHost",
        engine: "omlx",
        pid: process.pid,
        host: "127.0.0.1",
        port: 8115,
        modelAliases: ["Qwen3-8B-MLX-4bit"],
        startedAt: "2026-05-19T00:00:00Z",
      }),
    );

    const beta = join(t.dir, "workloads", "beta");
    mkdirSync(beta, { recursive: true });
    writeFileSync(join(beta, "modelhost.pid"), `${String(process.pid)}\n`);
    writeFileSync(
      join(beta, "modelhost.state"),
      JSON.stringify({
        kind: "ModelHost",
        engine: "omlx",
        pid: process.pid,
        host: "127.0.0.1",
        port: 8116,
        modelAliases: ["Qwen3-8B-MLX-4bit"],
        startedAt: "2026-05-19T00:00:00Z",
      }),
    );

    const calls: { url: string }[] = [];
    globalThis.fetch = ((input: Request | URL | string) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "Qwen3-8B-MLX-4bit",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      t.env,
    );
    expect(res.status).toBe(200);
    // Filter to the chat forward; omlx ModelHosts also probe /v1/slots/capabilities (KV, orthogonal to routing).
    const chatCalls = calls.filter((c) => c.url.includes("/v1/chat/completions"));
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]!.url).toBe("http://127.0.0.1:8115/v1/chat/completions");
  } finally {
    warnSpy.mockRestore();
    t.cleanup();
  }
});

test("/v1/models includes local and peer models from peer routing config", () => {
  const t = tempEnv();
  try {
    const workload = join(t.dir, "workloads", "local-run");
    mkdirSync(workload, { recursive: true });
    writeFileSync(join(workload, "llama-server.pid"), `${String(process.pid)}\n`);
    writeFileSync(
      join(workload, "llama-server.state"),
      JSON.stringify({
        rel: "local/model.gguf",
        extraArgs: [],
        host: "127.0.0.1",
        port: 8131,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        tunedProfile: null,
      }),
    );

    const peers = [{ id: "mac-mini", endpoint: "https://macmini.ai:7843" }];
    const peerSnapshots = new Map<string, PeerSnapshot>([
      [
        "mac-mini",
        {
          workloads: [{ modelId: "peer/model.gguf", port: 9200 }],
          pressure: "NORMAL",
          fetchedAt: Date.now(),
        },
      ],
    ]);

    openaiProxy.__setOpenAIProxyClusterRoutingForTests({
      clusterPeers: peers,
      peerSnapshots,
    });

    const models = openaiProxy.listOpenAIModels(t.env);
    expect(new Set(models.data.map((entry) => entry.id))).toEqual(
      new Set(["local/model.gguf", "peer/model.gguf"]),
    );
  } finally {
    t.cleanup();
  }
});

test("POST /v1/chat/completions forwards peer-only model to peer endpoint", async () => {
  const t = tempEnv();
  try {
    const peerToken = "peer-token-123";
    const peers = [
      {
        id: "mac-mini",
        endpoint: "https://macmini.ai:7843",
        certificate: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
        token: peerToken,
        tlsServerName: "mini.test",
      },
    ];
    const peerSnapshots = new Map<string, PeerSnapshot>([
      [
        "mac-mini",
        {
          workloads: [{ modelId: "peer-only/model.gguf", port: 9222 }],
          pressure: "NORMAL",
          fetchedAt: Date.now(),
        },
      ],
    ]);
    openaiProxy.__setOpenAIProxyClusterRoutingForTests({
      clusterPeers: peers,
      peerSnapshots,
    });

    let forwardedAuthorization = "";
    let forwardedCa = "";
    let forwardedServerName: string | undefined;
    const calls: { url: string }[] = [];
    globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.headers) {
        forwardedAuthorization = new Headers(init.headers).get("authorization") ?? "";
      }
      const forwardedInit = init as RequestInit & { tls?: { ca: string; serverName?: string } };
      if (forwardedInit.tls) {
        forwardedCa = forwardedInit.tls.ca;
        forwardedServerName = forwardedInit.tls.serverName;
      }
      calls.push({ url });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "peer-only/model.gguf",
          messages: [{ role: "user", content: "route me" }],
        }),
      }),
      t.env,
    );
    expect(res.status).toBe(200);
    expect(forwardedServerName).toBe("mini.test");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://macmini.ai:7843/v1/chat/completions");
    expect(forwardedAuthorization).toBe(`Bearer ${peerToken}`);
    expect(forwardedCa).toBe("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
  } finally {
    t.cleanup();
  }
});

test("peer route + x_omlx_request_handle returns 400 with exact error message", async () => {
  const t = tempEnv();
  try {
    const peers = [{ id: "mac-mini", endpoint: "https://macmini.ai:7843" }];
    openaiProxy.__setOpenAIProxyClusterRoutingForTests({
      clusterPeers: peers,
      peerSnapshots: new Map([
        [
          "mac-mini",
          {
            workloads: [{ modelId: "peer-only/model.gguf", port: 9222 }],
            pressure: "NORMAL",
            fetchedAt: Date.now(),
          },
        ],
      ]),
    });

    globalThis.fetch = (() => {
      throw new Error("peer fetch should not run for slot ops");
    }) as unknown as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "peer-only/model.gguf",
          messages: [{ role: "user", content: "slot op" }],
          x_omlx_request_handle: "handle-1",
        }),
      }),
      t.env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "cross-node slot ops not supported" });
  } finally {
    t.cleanup();
  }
});

test("peer 502 invalidates route cache so next request refetches routes", async () => {
  const t = tempEnv();
  try {
    const peers = [{ id: "mac-mini", endpoint: "https://macmini.ai:7843" }];
    openaiProxy.__setOpenAIProxyClusterRoutingForTests({
      clusterPeers: peers,
      peerSnapshots: new Map([
        [
          "mac-mini",
          {
            workloads: [{ modelId: "peer-only/model.gguf", port: 9222 }],
            pressure: "NORMAL",
            fetchedAt: Date.now(),
          },
        ],
      ]),
    });

    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return calls === 1
        ? new Response("bad gateway", { status: 502 })
        : Response.json({ ok: true });
    }) as unknown as typeof fetch;

    const before = openaiProxy.__getOpenAIProxyRouteMapBuildCountForTests();
    const first = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "peer-only/model.gguf",
          messages: [{ role: "user", content: "one" }],
        }),
      }),
      t.env,
    );
    expect(first.status).toBe(502);
    expect(openaiProxy.__getOpenAIProxyRouteMapBuildCountForTests()).toBe(before + 1);

    const second = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "peer-only/model.gguf",
          messages: [{ role: "user", content: "two" }],
        }),
      }),
      t.env,
    );
    expect(second.status).toBe(200);
    expect(openaiProxy.__getOpenAIProxyRouteMapBuildCountForTests()).toBe(before + 2);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P0.1 (#129) characterization — pin the wire contract for every supported
// ingress shape: which URL, model, stream flag, and client headers the
// upstream actually receives. Local AND peer coverage for each shape.
// ---------------------------------------------------------------------------

test("/v1/messages routes a local routable model to its workload endpoint", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17999" });
  try {
    writeLlamaServerWorkload(t.dir, "wl-claude", {
      rel: "org/claude-lookalike.gguf",
      port: 8140,
      extraArgs: ["--alias", "claude-alias"],
    });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "sk-ant-test",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "tools-2024-05-16",
          authorization: "Bearer client-token-must-not-leak",
        },
        body: JSON.stringify({
          model: "claude-alias",
          messages: [{ role: "user", content: "route me" }],
          max_tokens: 64,
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0]!;
    // The routable model resolved to its workload endpoint, NOT the
    // LLAMA_CPP_PORT fallback — resolveJsonBodyRoute overrides the default.
    expect(call.url).toBe("http://127.0.0.1:8140/v1/chat/completions");
    expect(call.method).toBe("POST");
    // Translated chat-completions body: the anthropic model alias is
    // forwarded verbatim as the upstream `model`.
    expect(call.body).toEqual({
      model: "claude-alias",
      messages: [{ role: "user", content: "route me" }],
      max_tokens: 64,
    });
    // Anthropic client headers pass through; the client Authorization
    // header is stripped by parseIncoming (no peer bearer on a local
    // route). The x-api-key passthrough is deliberately NOT a contract —
    // see the observed-behavior describe at the bottom of this file.
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.headers["anthropic-beta"]).toBe("tools-2024-05-16");
    expect(call.headers["authorization"]).toBeUndefined();
  } finally {
    t.cleanup();
  }
});

test("/v1/messages routes a peer-only model to the peer endpoint", async () => {
  const t = tempEnv();
  try {
    openaiProxy.__setOpenAIProxyClusterRoutingForTests({
      clusterPeers: [
        { id: "peer-b", endpoint: "https://peer-b.local:7843", token: "peer-token-xyz" },
      ],
      peerSnapshots: new Map<string, PeerSnapshot>([
        [
          "peer-b",
          {
            workloads: [{ modelId: "claude-peer-only", port: 9222 }],
            pressure: "NORMAL",
            fetchedAt: Date.now(),
          },
        ],
      ]),
    });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "sk-ant-test",
          "anthropic-version": "2023-06-01",
          authorization: "Bearer client-token-must-not-leak",
        },
        body: JSON.stringify({
          model: "claude-peer-only",
          messages: [{ role: "user", content: "peer route me" }],
          max_tokens: 32,
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0]!;
    expect(call.url).toBe("https://peer-b.local:7843/v1/chat/completions");
    expect(call.body).toEqual({
      model: "claude-peer-only",
      messages: [{ role: "user", content: "peer route me" }],
      max_tokens: 32,
    });
    // Peer forwarding replaces the client bearer with the peer token —
    // that IS the contract. The client x-api-key reaching the peer is
    // observed behavior only; see the describe at the bottom.
    expect(call.headers["authorization"]).toBe("Bearer peer-token-xyz");
  } finally {
    t.cleanup();
  }
});

test("/v1/chat/completions routes a ModelRun by its --alias and forwards the alias verbatim", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17999" });
  try {
    writeLlamaServerWorkload(t.dir, "wl-alias", {
      rel: "org/real-model.gguf",
      port: 8141,
      extraArgs: ["--alias", "chatty-alias"],
    });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "chatty-alias",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.url).toBe("http://127.0.0.1:8141/v1/chat/completions");
    // The client-supplied alias is forwarded as `model` unchanged —
    // llama-server resolves its own --alias.
    expect(upstream.calls[0]!.body?.["model"]).toBe("chatty-alias");
  } finally {
    t.cleanup();
  }
});

test("a routable model overrides the singleton local fallback endpoint", async () => {
  // LLAMA_CPP_PORT is the legacy default llama-server; a workload-registered
  // model must win over it (resolveJsonBodyRoute).
  const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
  try {
    writeLlamaServerWorkload(t.dir, "wl-routed", {
      rel: "routed/model.gguf",
      port: 8142,
    });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "routed/model.gguf",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.url).toBe("http://127.0.0.1:8142/v1/chat/completions");
  } finally {
    t.cleanup();
  }
});

test("an unknown model with routes configured returns model_not_routed naming it", async () => {
  // #306 operator decision: once the route map is non-empty, a JSON
  // `model` matching no route — and neither the env default alias nor
  // the env default model — is an explicit 404, not a silent fallthrough
  // to the singleton llama-server.
  const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
  try {
    writeLlamaServerWorkload(t.dir, "wl-routed", {
      rel: "routed/model.gguf",
      port: 8142,
    });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "nope/unknown.gguf",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: {
        code: string;
        type: string;
        message: string;
        known_models: string[];
      };
    };
    expect(body.error.code).toBe("model_not_routed");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("nope/unknown.gguf");
    expect(body.error.known_models).toEqual(["routed/model.gguf"]);
    expect(upstream.calls).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("model_not_routed reports known_models sorted regardless of route registration order", async () => {
  // Pins the .sort() in resolveJsonBodyRoute's modelNotRoutedResponse call:
  // three routes registered z-first, m-second, a-last must be reported in
  // ascending order, so a .reverse() (or unsorted) list fails here.
  const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
  try {
    writeLlamaServerWorkload(t.dir, "wl-zeta", { rel: "zeta/z-model.gguf", port: 8143 });
    writeLlamaServerWorkload(t.dir, "wl-mike", { rel: "mike/m-model.gguf", port: 8144 });
    writeLlamaServerWorkload(t.dir, "wl-alpha", { rel: "alpha/a-model.gguf", port: 8145 });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "nope/unknown.gguf",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: {
        code: string;
        known_models: string[];
      };
    };
    expect(body.error.code).toBe("model_not_routed");
    expect(body.error.known_models).toEqual([
      "alpha/a-model.gguf",
      "mike/m-model.gguf",
      "zeta/z-model.gguf",
    ]);
    expect(upstream.calls).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("/v1/messages with an unknown model and routes configured returns model_not_routed", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
  try {
    writeLlamaServerWorkload(t.dir, "wl-routed", {
      rel: "routed/model.gguf",
      port: 8142,
    });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      anthropicChatRequest({
        model: "claude-vendor-id",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
      }),
      t.env,
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("model_not_routed");
    expect(body.error.message).toContain("claude-vendor-id");
    expect(upstream.calls).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("the default llama-server alias is still forwarded to the default target when routes exist", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777", LLAMA_CPP_SERVER_ALIAS: "default-alias" });
  try {
    writeLlamaServerWorkload(t.dir, "wl-routed", {
      rel: "routed/model.gguf",
      port: 8142,
    });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "default-alias",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.url).toBe("http://127.0.0.1:17777/v1/chat/completions");
  } finally {
    t.cleanup();
  }
});

test("the default model id is still forwarded to the default target when routes exist", async () => {
  const t = tempEnv({
    LLAMA_CPP_PORT: "17777",
    LLAMA_CPP_DEFAULT_MODEL: "default/model.gguf",
  });
  try {
    writeLlamaServerWorkload(t.dir, "wl-routed", {
      rel: "routed/model.gguf",
      port: 8142,
    });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "default/model.gguf",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.url).toBe("http://127.0.0.1:17777/v1/chat/completions");
  } finally {
    t.cleanup();
  }
});

test("with no routes configured an unknown model keeps the default-target fallback", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
  try {
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "nope/unknown.gguf",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.url).toBe("http://127.0.0.1:17777/v1/chat/completions");
  } finally {
    t.cleanup();
  }
});

test("a request with no model field keeps the default-target fallback when routes exist", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
  try {
    writeLlamaServerWorkload(t.dir, "wl-routed", {
      rel: "routed/model.gguf",
      port: 8142,
    });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.url).toBe("http://127.0.0.1:17777/v1/chat/completions");
  } finally {
    t.cleanup();
  }
});

test("an unreachable routed upstream yields the llamactl_upstream_error envelope", async () => {
  const t = tempEnv();
  try {
    writeLlamaServerWorkload(t.dir, "wl-down", {
      rel: "down/model.gguf",
      port: 8143,
    });
    globalThis.fetch = (() => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "down/model.gguf",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      t.env,
    );

    // Frozen public error envelope: 502 + {error:{message,type}}. Pin
    // status + type + the message prefix — the suffix is whatever the
    // fetch rejection carried (mock-owned, not part of the contract).
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("llamactl_upstream_error");
    expect(body.error.message.startsWith("upstream llama-server unreachable:")).toBe(true);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Generic model-routed JSON paths: routedEndpointForModel forwards ANY
// /v1/* path whose body carries a routable `model` — /v1/completions,
// /v1/embeddings, /v1/rerank included (there is no special-cased rerank
// handling; it rides the same transparent forward). Local AND peer.
// ---------------------------------------------------------------------------

test("/v1/completions routes a local routable model to its workload endpoint", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17999" });
  try {
    writeLlamaServerWorkload(t.dir, "wl-comp", { rel: "org/comp-model.gguf", port: 8152 });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/completions?foo=bar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "org/comp-model.gguf", prompt: "once upon" }),
      }),
      t.env,
    );

    // The fixture only serves /v1/chat/completions — a 404 here is the
    // upstream's own answer forwarded verbatim.
    expect(res.status).toBe(404);
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:8152/v1/completions?foo=bar");
    expect(call.method).toBe("POST");
    expect(call.body?.["model"]).toBe("org/comp-model.gguf");
  } finally {
    t.cleanup();
  }
});

test("/v1/completions routes a peer-only model to the peer endpoint", async () => {
  const t = tempEnv();
  try {
    openaiProxy.__setOpenAIProxyClusterRoutingForTests({
      clusterPeers: [
        { id: "peer-b", endpoint: "https://peer-b.local:7843", token: "peer-token-xyz" },
      ],
      peerSnapshots: new Map<string, PeerSnapshot>([
        [
          "peer-b",
          {
            workloads: [{ modelId: "peer-comp-model", port: 9222 }],
            pressure: "NORMAL",
            fetchedAt: Date.now(),
          },
        ],
      ]),
    });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/completions?foo=bar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "peer-comp-model", prompt: "once upon" }),
      }),
      t.env,
    );

    expect(res.status).toBe(404);
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0]!;
    expect(call.url).toBe("https://peer-b.local:7843/v1/completions?foo=bar");
    expect(call.method).toBe("POST");
    expect(call.body?.["model"]).toBe("peer-comp-model");
  } finally {
    t.cleanup();
  }
});

test("/v1/embeddings routes a local routable model to its workload endpoint", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17999" });
  try {
    writeLlamaServerWorkload(t.dir, "wl-emb", { rel: "org/embed-model.gguf", port: 8153 });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/embeddings?foo=bar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "org/embed-model.gguf", input: "embed me" }),
      }),
      t.env,
    );

    expect(res.status).toBe(404);
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:8153/v1/embeddings?foo=bar");
    expect(call.method).toBe("POST");
    expect(call.body?.["model"]).toBe("org/embed-model.gguf");
  } finally {
    t.cleanup();
  }
});

test("/v1/embeddings routes a peer-only model to the peer endpoint", async () => {
  const t = tempEnv();
  try {
    openaiProxy.__setOpenAIProxyClusterRoutingForTests({
      clusterPeers: [
        { id: "peer-b", endpoint: "https://peer-b.local:7843", token: "peer-token-xyz" },
      ],
      peerSnapshots: new Map<string, PeerSnapshot>([
        [
          "peer-b",
          {
            workloads: [{ modelId: "peer-embed-model", port: 9222 }],
            pressure: "NORMAL",
            fetchedAt: Date.now(),
          },
        ],
      ]),
    });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/embeddings?foo=bar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "peer-embed-model", input: "embed me" }),
      }),
      t.env,
    );

    expect(res.status).toBe(404);
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0]!;
    expect(call.url).toBe("https://peer-b.local:7843/v1/embeddings?foo=bar");
    expect(call.method).toBe("POST");
    expect(call.body?.["model"]).toBe("peer-embed-model");
  } finally {
    t.cleanup();
  }
});

test("/v1/rerank routes a local routable model to its workload endpoint", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17999" });
  try {
    writeLlamaServerWorkload(t.dir, "wl-rerank", { rel: "org/rerank-model.gguf", port: 8154 });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/rerank?foo=bar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "org/rerank-model.gguf",
          query: "q",
          documents: ["d1"],
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(404);
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:8154/v1/rerank?foo=bar");
    expect(call.method).toBe("POST");
    expect(call.body?.["model"]).toBe("org/rerank-model.gguf");
  } finally {
    t.cleanup();
  }
});

test("/v1/rerank routes a peer-only model to the peer endpoint", async () => {
  const t = tempEnv();
  try {
    openaiProxy.__setOpenAIProxyClusterRoutingForTests({
      clusterPeers: [
        { id: "peer-b", endpoint: "https://peer-b.local:7843", token: "peer-token-xyz" },
      ],
      peerSnapshots: new Map<string, PeerSnapshot>([
        [
          "peer-b",
          {
            workloads: [{ modelId: "peer-rerank-model", port: 9222 }],
            pressure: "NORMAL",
            fetchedAt: Date.now(),
          },
        ],
      ]),
    });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/rerank?foo=bar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "peer-rerank-model",
          query: "q",
          documents: ["d1"],
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(404);
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0]!;
    expect(call.url).toBe("https://peer-b.local:7843/v1/rerank?foo=bar");
    expect(call.method).toBe("POST");
    expect(call.body?.["model"]).toBe("peer-rerank-model");
  } finally {
    t.cleanup();
  }
});

test("a ModelRun/ModelHost alias collision routes chat to the ModelRun port", async () => {
  // The listOpenAIModels collision test pins the catalog; this pins the
  // actual request path — same precedence, observed on the wire.
  const t = tempEnv({ LLAMA_CPP_PORT: "17999" });
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    writeLlamaServerWorkload(t.dir, "wl-run", { rel: "shared/collide.gguf", port: 8155 });
    const host = join(t.dir, "workloads", "wl-host");
    mkdirSync(host, { recursive: true });
    writeFileSync(join(host, "modelhost.pid"), `${String(process.pid)}\n`);
    writeFileSync(
      join(host, "modelhost.state"),
      JSON.stringify({
        kind: "ModelHost",
        engine: "omlx",
        pid: process.pid,
        host: "127.0.0.1",
        port: 8156,
        modelAliases: ["shared/collide.gguf"],
        startedAt: "2026-05-19T00:00:00Z",
      }),
    );
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "shared/collide.gguf",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      t.env,
    );

    expect(res.status).toBe(200);
    const chatCalls = upstream.calls.filter((c) => c.url.endsWith("/v1/chat/completions"));
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]!.url).toBe("http://127.0.0.1:8155/v1/chat/completions");
    expect(chatCalls[0]!.body?.["model"]).toBe("shared/collide.gguf");
    expect(warnSpy).toHaveBeenCalledWith(
      "[openaiProxy] route-map collision on model='shared/collide.gguf': keeping ModelRun:wl-run, ignoring ModelHost:wl-host",
    );
  } finally {
    warnSpy.mockRestore();
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Observed current behavior — NOT a compatibility guarantee. Credential
// passthrough below is what the proxy does today; a security review may
// change it. Contract assertions (auth stripped locally, peer token on
// peer routes) stay in the tests above.
// ---------------------------------------------------------------------------
describe("observed current behavior, not a compatibility guarantee (security review pending)", () => {
  test("client x-api-key is forwarded to a local workload upstream", async () => {
    const t = tempEnv({ LLAMA_CPP_PORT: "17999" });
    try {
      writeLlamaServerWorkload(t.dir, "wl-key", { rel: "org/keyed-model.gguf", port: 8157 });
      const upstream = installConditionalChatUpstream();

      const res = await openaiProxy.proxyOpenAI(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": "sk-ant-test",
            authorization: "Bearer client-token",
          },
          body: JSON.stringify({
            model: "org/keyed-model.gguf",
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 8,
          }),
        }),
        t.env,
      );

      expect(res.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
      expect(upstream.calls[0]!.headers["x-api-key"]).toBe("sk-ant-test");
    } finally {
      t.cleanup();
    }
  });

  test("client x-api-key is forwarded to a peer endpoint", async () => {
    const t = tempEnv();
    try {
      openaiProxy.__setOpenAIProxyClusterRoutingForTests({
        clusterPeers: [
          { id: "peer-b", endpoint: "https://peer-b.local:7843", token: "peer-token-xyz" },
        ],
        peerSnapshots: new Map<string, PeerSnapshot>([
          [
            "peer-b",
            {
              workloads: [{ modelId: "claude-peer-only", port: 9222 }],
              pressure: "NORMAL",
              fetchedAt: Date.now(),
            },
          ],
        ]),
      });
      const upstream = installConditionalChatUpstream();

      const res = await openaiProxy.proxyOpenAI(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": "sk-ant-test",
            authorization: "Bearer client-token",
          },
          body: JSON.stringify({
            model: "claude-peer-only",
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 8,
          }),
        }),
        t.env,
      );

      expect(res.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
      expect(upstream.calls[0]!.headers["x-api-key"]).toBe("sk-ant-test");
      // Contract half kept here too: the client bearer never reaches the
      // peer — the peer token replaces it.
      expect(upstream.calls[0]!.headers["authorization"]).toBe("Bearer peer-token-xyz");
    } finally {
      t.cleanup();
    }
  });
});

describe("known defects at 7443403 (fix in later slices)", () => {
  // Defect: AnthropicMessagesRequest declares no `stream` member and
  // translateAnthropicRequest never emits it, so a streaming /v1/messages
  // request is silently downgraded to a non-streaming upstream call.
  //   packages/core/src/anthropic/types.ts:72-83 (no `stream` field)
  //   packages/core/src/anthropic/translateRequest.ts:310-337 (no `stream` emitted)
  // Owning slice: P1.2 (#132) — Anthropic stream propagation / native passthrough.
  test.failing("/v1/messages stream:true reaches the upstream request body", async () => {
    const t = tempEnv();
    try {
      const upstream = installConditionalChatUpstream();
      const res = await openaiProxy.proxyOpenAI(
        anthropicChatRequest({
          model: "claude-3-7-sonnet",
          messages: [{ role: "user", content: "stream please" }],
          max_tokens: 64,
          stream: true,
        }),
        t.env,
      );
      expect(upstream.calls).toHaveLength(1);
      expect(upstream.calls[0]!.body?.["stream"]).toBe(true);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
    } finally {
      t.cleanup();
    }
  });

  // Same defect, client-visible half: with an honest upstream the SSE
  // envelope can only arrive if the proxy asked for a stream. When the
  // fixture streams unconditionally (the pre-P0.1 dishonest mode), this
  // test would pass vacuously — that asymmetry is the fixture's proof.
  // Owning slice: P1.2 (#132).
  test.failing("/v1/messages stream:true yields an anthropic SSE response", async () => {
    const t = tempEnv();
    try {
      installConditionalChatUpstream();
      const res = await openaiProxy.proxyOpenAI(
        anthropicChatRequest({
          model: "claude-3-7-sonnet",
          messages: [{ role: "user", content: "stream please" }],
          max_tokens: 64,
          stream: true,
        }),
        t.env,
      );
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const body = await res.text();
      expect(body.startsWith("event: message_start\n")).toBe(true);
      expect(body).toContain("event: message_stop\n");
    } finally {
      t.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// #518 B-4 — experimental qualification in the proxy route builders. The
// catalog join, peer snapshot labels, selectCatalogCandidates and the
// "experimental-excluded" rejection land with the fix; the widened views
// below keep these RED cases typechecking before those exports exist
// (undefined at runtime on the base revision, so the typeof guard fails by
// assertion first).
// ---------------------------------------------------------------------------

const EXPERIMENTAL_CATALOG_TSV =
  'exp-model\tExp test\texp\tcustom\tcustom\texp/model.gguf\torg/exp\tgguf\t{"qualification":{"stage":"experimental"}}\n';

const writeExperimentalCatalog = (dir: string): void => {
  writeFileSync(join(dir, "curated-models.tsv"), EXPERIMENTAL_CATALOG_TSV);
};

const writeQualifiedCatalog = (dir: string, stage: string): void => {
  writeFileSync(
    join(dir, "curated-models.tsv"),
    `exp-model\tExp test\texp\tcustom\tcustom\texp/model.gguf\torg/exp\tgguf\t{"qualification":{"stage":"${stage}"}}\n`,
  );
};

// selectCatalogCandidates lands with #518; the widened view lets the RED
// cases call it before the export exists.
const selectCatalogCandidates = (
  routeCatalogModule as unknown as {
    selectCatalogCandidates?: (
      catalog: RouteCatalog,
      publicModelId: string,
      opts?: { pinned?: boolean },
    ) => {
      eligible: RouteCandidate[];
      rejected: { candidate: RouteCandidate; rejection: { reason: string } }[];
    };
  }
).selectCatalogCandidates;

const adQualificationStage = (ad: unknown): unknown =>
  (ad as { qualification?: { stage?: unknown } } | null | undefined)?.qualification?.stage;

const clusterCatalog = (env: ResolvedEnv): RouteCatalog =>
  routeCatalogModule.buildRouteCatalog({
    routes: workloadRuntimeModule.listClusterRoutes(
      workloadRuntimeModule.listLocalRoutes(env),
      new Map<string, PeerSnapshot>(),
      { peers: [] },
    ),
  });

const chatRequest = (model: string): Request =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hi" }],
    }),
  });

test("an experimental route loses an alias collision", async () => {
  const t = tempEnv();
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    writeExperimentalCatalog(t.dir);
    writeLlamaServerWorkload(t.dir, "a-exp", {
      rel: "exp/model.gguf",
      port: 8321,
      extraArgs: ["--alias", "shared-alias"],
    });
    writeLlamaServerWorkload(t.dir, "b-prod", {
      rel: "prod/model.gguf",
      port: 8322,
      extraArgs: ["--alias", "shared-alias"],
    });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(chatRequest("shared-alias"), t.env);

    expect(res.status).toBe(200);
    const chatCalls = upstream.calls.filter((c) => c.url.endsWith("/v1/chat/completions"));
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]!.url).toBe("http://127.0.0.1:8322/v1/chat/completions");
    expect(warnSpy).toHaveBeenCalledWith(
      "[openaiProxy] route-map collision on model='shared-alias': keeping ModelRun:b-prod, ignoring ModelRun:a-exp",
    );
  } finally {
    warnSpy.mockRestore();
    t.cleanup();
  }
});

test("an experimental exact pin still forwards to its own port", async () => {
  const t = tempEnv();
  try {
    writeExperimentalCatalog(t.dir);
    writeLlamaServerWorkload(t.dir, "a-exp", {
      rel: "exp/model.gguf",
      port: 8321,
      extraArgs: ["--alias", "shared-alias"],
    });
    writeLlamaServerWorkload(t.dir, "b-prod", {
      rel: "prod/model.gguf",
      port: 8322,
      extraArgs: ["--alias", "shared-alias"],
    });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(chatRequest("exp/model.gguf"), t.env);

    expect(res.status).toBe(200);
    const chatCalls = upstream.calls.filter((c) => c.url.endsWith("/v1/chat/completions"));
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]!.url).toBe("http://127.0.0.1:8321/v1/chat/completions");
  } finally {
    t.cleanup();
  }
});

test("an experimental route never captures a default-target id", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777", LLAMA_CPP_SERVER_ALIAS: "default-alias" });
  try {
    writeExperimentalCatalog(t.dir);
    writeLlamaServerWorkload(t.dir, "wl-exp", {
      rel: "exp/model.gguf",
      port: 8331,
      extraArgs: ["--alias", "default-alias"],
    });
    writeLlamaServerWorkload(t.dir, "wl-prod", {
      rel: "prod/model.gguf",
      port: 8332,
    });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(chatRequest("default-alias"), t.env);

    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.url).toBe("http://127.0.0.1:17777/v1/chat/completions");
  } finally {
    t.cleanup();
  }
});

test("/v1/models flags experimental entries", () => {
  const t = tempEnv();
  try {
    writeExperimentalCatalog(t.dir);
    writeLlamaServerWorkload(t.dir, "wl-exp", { rel: "exp/model.gguf", port: 8340 });
    writeLlamaServerWorkload(t.dir, "wl-prod", { rel: "prod/model.gguf", port: 8341 });

    const models = openaiProxy.listOpenAIModels(t.env);
    const byId = new Map(models.data.map((m) => [m.id, m as unknown as Record<string, unknown>]));
    const expEntry = byId.get("exp/model.gguf");
    const prodEntry = byId.get("prod/model.gguf");
    expect(expEntry?.["experimental"]).toBe(true);
    expect(prodEntry !== undefined && "experimental" in prodEntry).toBe(false);
    expect(expEntry?.["capabilities"]).toEqual(["chat"]);
    expect(prodEntry?.["capabilities"]).toEqual(["chat"]);
  } finally {
    t.cleanup();
  }
});

test("a catalog edit invalidates the /v1/models cache without a workload restart", () => {
  const t = tempEnv();
  try {
    const catalogFile = join(t.dir, "curated-models.tsv");
    writeQualifiedCatalog(t.dir, "validated");
    writeLlamaServerWorkload(t.dir, "wl-exp", { rel: "exp/model.gguf", port: 8340 });
    const epoch = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(catalogFile, epoch, epoch);

    const before = openaiProxy.listOpenAIModels(t.env);
    const beforeEntry = before.data.find((m) => m.id === "exp/model.gguf") as unknown as
      | Record<string, unknown>
      | undefined;
    expect(beforeEntry?.["id"]).toBe("exp/model.gguf");
    expect("experimental" in (beforeEntry ?? {})).toBe(false);

    writeQualifiedCatalog(t.dir, "experimental");
    utimesSync(catalogFile, epoch, new Date(epoch.getTime() + 1_000));

    const after = openaiProxy.listOpenAIModels(t.env);
    const afterEntry = after.data.find((m) => m.id === "exp/model.gguf") as unknown as
      | Record<string, unknown>
      | undefined;
    expect(afterEntry?.["experimental"]).toBe(true);
  } finally {
    t.cleanup();
  }
});

test("legacy and unified agree on experimental exclusion", async () => {
  const t = tempEnv();
  try {
    writeExperimentalCatalog(t.dir);
    writeLlamaServerWorkload(t.dir, "a-exp", {
      rel: "exp/model.gguf",
      port: 8321,
      extraArgs: ["--alias", "shared-alias"],
    });
    writeLlamaServerWorkload(t.dir, "b-prod", {
      rel: "prod/model.gguf",
      port: 8322,
      extraArgs: ["--alias", "shared-alias"],
    });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(chatRequest("shared-alias"), t.env);

    expect(res.status).toBe(200);
    const chatCalls = upstream.calls.filter((c) => c.url.endsWith("/v1/chat/completions"));
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]!.url).toBe("http://127.0.0.1:8322/v1/chat/completions");

    const catalog = clusterCatalog(t.env);
    const shared = routeCatalogModule.effectiveCandidate(catalog, "shared-alias");
    expect(shared?.advertisement.endpoint).toBe("http://127.0.0.1:8322");
    const expCand = routeCatalogModule.effectiveCandidate(catalog, "exp/model.gguf");
    expect(adQualificationStage(expCand?.advertisement)).toBe("experimental");
  } finally {
    t.cleanup();
  }
});

test("documented divergence: default-target ids", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777", LLAMA_CPP_SERVER_ALIAS: "default-alias" });
  try {
    writeExperimentalCatalog(t.dir);
    writeLlamaServerWorkload(t.dir, "wl-exp", {
      rel: "exp/model.gguf",
      port: 8331,
      extraArgs: ["--alias", "default-alias"],
    });
    writeLlamaServerWorkload(t.dir, "wl-prod", {
      rel: "prod/model.gguf",
      port: 8332,
    });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(chatRequest("default-alias"), t.env);

    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.url).toBe("http://127.0.0.1:17777/v1/chat/completions");

    const catalog = clusterCatalog(t.env);
    const winner = routeCatalogModule.effectiveCandidate(catalog, "default-alias");
    expect(winner?.legacyWinner).toBe(true);
    expect(winner?.advertisement.deploymentId).toContain("wl-exp");

    expect(typeof selectCatalogCandidates).toBe("function");
    const sel = selectCatalogCandidates?.(catalog, "default-alias", { pinned: false });
    expect(sel?.eligible).toEqual([]);
    expect(sel?.rejected).toHaveLength(1);
    expect(sel?.rejected[0]?.rejection).toEqual({ reason: "experimental-excluded" });
  } finally {
    t.cleanup();
  }
});

test("a local exact pin is not sent to an unlabeled peer", async () => {
  const t = tempEnv();
  try {
    writeExperimentalCatalog(t.dir);
    writeLlamaServerWorkload(t.dir, "wl-exp", { rel: "exp/model.gguf", port: 8341 });
    openaiProxy.__setOpenAIProxyClusterRoutingForTests({
      clusterPeers: [{ id: "peer-x", endpoint: "https://peer-x.test:443" }],
      peerSnapshots: new Map<string, PeerSnapshot>([
        [
          "peer-x",
          {
            workloads: [{ modelId: "exp/model.gguf", port: 9200 }],
            pressure: "NORMAL",
            fetchedAt: Date.now(),
          },
        ],
      ]),
    });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(chatRequest("exp/model.gguf"), t.env);

    expect(res.status).toBe(200);
    const chatCalls = upstream.calls.filter((c) => c.url.endsWith("/v1/chat/completions"));
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]!.url).toBe("http://127.0.0.1:8341/v1/chat/completions");
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// #280 D-2 — declared-unavailable catalog models
// Catalog rows whose availability.declared is "unavailable" must surface as
// a typed 503 model_unavailable rejection — by rel or by catalog id — ahead
// of the #306 model_not_routed 404 and the default-endpoint fallthrough, and
// /v1/models reports them under `unavailable` instead of `data`. That field
// is absent from ModelListResponse at the base revision, so the widened view
// below keeps these RED cases typechecking (undefined at runtime → assertion
// failure, never an import or type error).
// ---------------------------------------------------------------------------

const MIMO_REL =
  "MiMo-V2.6-Flash-MOPD-GGUF-AesSedai/b6e95d58/BPW2.5/MiMo-V2.6-Flash-MOPD-BPW2.5-00001-of-00003.gguf";
const MIMO_ID = "mimo26-flash-mopd-bpw25";

const COLD_UNAVAILABLE_ROW =
  'cold-x\tCold X\tcold\tcustom\tcustom\tcold/x.gguf\torg/cold\tgguf\t{"availability":{"declared":"unavailable","reason":"runtime-unsupported:test"}}';
const COLD_AVAILABLE_ROW =
  'cold-x\tCold X\tcold\tcustom\tcustom\tcold/x.gguf\torg/cold\tgguf\t{"availability":{"declared":"available"}}';
const COLD_UNAVAILABLE_R2_ROW =
  'cold-x\tCold X\tcold\tcustom\tcustom\tcold/x.gguf\torg/cold\tgguf\t{"availability":{"declared":"unavailable","reason":"r2"}}';

interface UnavailableModelListEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  catalogId: string;
  status: string;
  reason: string;
  qualification?: { stage: string };
  routable: boolean;
}

const unavailableEntries = (models: unknown): UnavailableModelListEntry[] | undefined =>
  (models as { unavailable?: UnavailableModelListEntry[] }).unavailable;

test("a declared-unavailable rel returns 503 model_unavailable ahead of model_not_routed", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
  try {
    writeLlamaServerWorkload(t.dir, "wl-routed", { rel: "routed/model.gguf", port: 8142 });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(chatRequest(MIMO_REL), t.env);

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: {
        code: string;
        type: string;
        param: string;
        reason: string;
        message: string;
      };
    };
    expect(body.error.code).toBe("model_unavailable");
    expect(body.error.type).toBe("model_unavailable");
    expect(body.error.param).toBe("model");
    expect(body.error.reason).toBe("artifact-not-downloaded");
    expect(body.error.message).toContain(MIMO_REL);
    expect(body.error.message).toContain("artifact-not-downloaded");
    expect(upstream.calls).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("a declared-unavailable rel is rejected with no routes instead of hitting the default endpoint", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
  try {
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(chatRequest(MIMO_REL), t.env);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_unavailable");
    expect(upstream.calls).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("the catalog id is an exact pin for the unavailable rejection", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
  try {
    writeLlamaServerWorkload(t.dir, "wl-routed", { rel: "routed/model.gguf", port: 8142 });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(chatRequest(MIMO_ID), t.env);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; reason: string } };
    expect(body.error.code).toBe("model_unavailable");
    expect(body.error.reason).toBe("artifact-not-downloaded");
    expect(upstream.calls).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("/v1/messages returns the same model_unavailable rejection", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
  try {
    writeLlamaServerWorkload(t.dir, "wl-routed", { rel: "routed/model.gguf", port: 8142 });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(
      anthropicChatRequest({
        model: MIMO_REL,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
      t.env,
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_unavailable");
    expect(upstream.calls).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("a custom catalog row supplies its own unavailable reason", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
  try {
    writeFileSync(join(t.dir, "curated-models.tsv"), `${COLD_UNAVAILABLE_ROW}\n`);
    writeLlamaServerWorkload(t.dir, "wl-routed", { rel: "routed/model.gguf", port: 8142 });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(chatRequest("cold/x.gguf"), t.env);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; reason: string } };
    expect(body.error.code).toBe("model_unavailable");
    expect(body.error.reason).toBe("runtime-unsupported:test");
    expect(upstream.calls).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("a later custom row declaring the rel available clears the builtin unavailable", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
  try {
    writeFileSync(
      join(t.dir, "curated-models.tsv"),
      `mimo-override\tMiMo override\tmimo26\treasoning\tcustom\t${MIMO_REL}\torg/override\tgguf\t{"availability":{"declared":"available"}}\n`,
    );
    writeLlamaServerWorkload(t.dir, "wl-routed", { rel: "routed/model.gguf", port: 8142 });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(chatRequest(MIMO_REL), t.env);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_not_routed");
    expect(upstream.calls).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("an unknown model keeps the model_not_routed 404 and known_models", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
  try {
    writeLlamaServerWorkload(t.dir, "wl-routed", { rel: "routed/model.gguf", port: 8142 });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(chatRequest("nope/unknown.gguf"), t.env);

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; known_models: string[] };
    };
    expect(body.error.code).toBe("model_not_routed");
    expect(body.error.known_models).toEqual(["routed/model.gguf"]);
    expect(upstream.calls).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("a live route for the rel wins over the unavailable declaration", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
  try {
    writeLlamaServerWorkload(t.dir, "wl-mimo", { rel: MIMO_REL, port: 8351 });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(chatRequest(MIMO_REL), t.env);

    expect(res.status).toBe(200);
    const chatCalls = upstream.calls.filter((c) => c.url.endsWith("/v1/chat/completions"));
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]!.url).toBe("http://127.0.0.1:8351/v1/chat/completions");
  } finally {
    t.cleanup();
  }
});

test("a default-target rel keeps the default-endpoint fallthrough", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777", LLAMA_CPP_DEFAULT_MODEL: MIMO_REL });
  try {
    writeLlamaServerWorkload(t.dir, "wl-routed", { rel: "routed/model.gguf", port: 8142 });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(chatRequest(MIMO_REL), t.env);

    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.url).toBe("http://127.0.0.1:17777/v1/chat/completions");
  } finally {
    t.cleanup();
  }
});

test("a default-target rel named by its catalog id is not turned into a 503", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777", LLAMA_CPP_DEFAULT_MODEL: MIMO_REL });
  try {
    writeLlamaServerWorkload(t.dir, "wl-routed", { rel: "routed/model.gguf", port: 8142 });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(chatRequest(MIMO_ID), t.env);

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; known_models: string[] };
    };
    expect(body.error.code).toBe("model_not_routed");
    expect(body.error.known_models).toEqual(["routed/model.gguf"]);
    expect(upstream.calls).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("/v1/models reports declared-unavailable catalog rows under `unavailable`", () => {
  const t = tempEnv();
  try {
    writeLlamaServerWorkload(t.dir, "wl-prod", { rel: "prod/model.gguf", port: 8341 });

    const models = openaiProxy.listOpenAIModels(t.env);
    const unavailable = unavailableEntries(models);

    expect(models.data).toHaveLength(1);
    expect(models.data[0]!.id).toBe("prod/model.gguf");
    expect(models.data[0]!.capabilities).toEqual(["chat"]);
    expect(models.data.some((m) => m.id === MIMO_REL)).toBe(false);
    expect(Array.isArray(unavailable)).toBe(true);
    const entries = unavailable ?? [];
    expect(entries.find((e) => e.id === MIMO_REL)).toEqual({
      id: MIMO_REL,
      object: "model",
      created: 0,
      owned_by: "llamactl-catalog",
      catalogId: MIMO_ID,
      status: "unavailable",
      reason: "artifact-not-downloaded",
      qualification: { stage: "experimental" },
      routable: false,
    });
    const ids = entries.map((e) => e.id);
    expect(ids).toEqual([...ids].sort());
  } finally {
    t.cleanup();
  }
});

test("/v1/models does not report a rel unavailable while a live route serves it", () => {
  const t = tempEnv();
  try {
    writeLlamaServerWorkload(t.dir, "wl-mimo", { rel: MIMO_REL, port: 8351 });

    const models = openaiProxy.listOpenAIModels(t.env);
    const unavailable = unavailableEntries(models);

    expect(models.data.find((m) => m.id === MIMO_REL)?.capabilities).toEqual(["chat"]);
    expect(Array.isArray(unavailable)).toBe(true);
    expect((unavailable ?? []).some((e) => e.id === MIMO_REL)).toBe(false);
  } finally {
    t.cleanup();
  }
});

test("editing the custom catalog invalidates the /v1/models unavailable list", () => {
  const t = tempEnv();
  try {
    const catalogFile = join(t.dir, "curated-models.tsv");
    const epoch = new Date("2026-01-01T00:00:00.000Z");
    writeFileSync(catalogFile, `${COLD_AVAILABLE_ROW}\n`);
    utimesSync(catalogFile, epoch, epoch);
    writeLlamaServerWorkload(t.dir, "wl-prod", { rel: "prod/model.gguf", port: 8341 });

    const before = unavailableEntries(openaiProxy.listOpenAIModels(t.env)) ?? [];
    expect(before.some((e) => e.id === "cold/x.gguf")).toBe(false);

    writeFileSync(catalogFile, `${COLD_UNAVAILABLE_R2_ROW}\n`);
    utimesSync(catalogFile, epoch, new Date(epoch.getTime() + 1_000));

    const after = unavailableEntries(openaiProxy.listOpenAIModels(t.env)) ?? [];
    expect(after.find((e) => e.id === "cold/x.gguf")?.reason).toBe("r2");
  } finally {
    t.cleanup();
  }
});

test("a custom row that redeclares a builtin rel under a different ID pins the custom catalog ID to 503", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
  try {
    const customCatalog = join(t.dir, "curated-models.tsv");
    writeFileSync(
      customCatalog,
      `mimo-redecl\tMiMo redecl\tmimo26\treasoning\tcustom\t${MIMO_REL}\torg/redecl\tgguf\t{"availability":{"declared":"unavailable","reason":"custom-redecl"}}\n`,
    );
    writeLlamaServerWorkload(t.dir, "wl-routed", { rel: "routed/model.gguf", port: 8142 });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(chatRequest(MIMO_ID), t.env);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; reason: string } };
    expect(body.error.code).toBe("model_unavailable");
    expect(body.error.reason).toBe("custom-redecl");
    expect(upstream.calls).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("with no routes, a builtin id whose rel a custom row redeclares unavailable returns 503, not the default endpoint", async () => {
  // The builtin gemma4-26b-q4 row declares no availability; only the custom
  // row does. Its id must still resolve to the rel, so the pin is rejected
  // instead of falling through to the default endpoint (#280).
  const GEMMA_REL = "gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf";
  const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
  try {
    writeFileSync(
      join(t.dir, "curated-models.tsv"),
      `gemma-alt\tGemma alt\tgemma4\tmultimodal\tcustom\t${GEMMA_REL}\torg/gemma-alt\tgguf\t{"availability":{"declared":"unavailable","reason":"custom-redecl"}}\n`,
    );
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(chatRequest("gemma4-26b-q4"), t.env);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; reason: string } };
    expect(body.error.code).toBe("model_unavailable");
    expect(body.error.reason).toBe("custom-redecl");
    expect(upstream.calls).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("a catalog-id pin of an unavailable rel that has a live route is not turned into 503 (P3)", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
  try {
    writeLlamaServerWorkload(t.dir, "wl-mimo", { rel: MIMO_REL, port: 8143 });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(chatRequest(MIMO_ID), t.env);

    // A live route for the rel wins over the declared-unavailable rejection,
    // so the catalog-id pin keeps its pre-#280 behaviour.
    expect(res.status).not.toBe(503);
    const body = (await res.json()) as { error?: { code: string } };
    expect(body.error?.code).not.toBe("model_unavailable");
  } finally {
    t.cleanup();
  }
});

test("a default target catalog id that is also a catalog unavailable id is not rejected (P7)", async () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777", LLAMA_CPP_DEFAULT_MODEL: MIMO_ID });
  try {
    writeLlamaServerWorkload(t.dir, "wl-routed", { rel: "routed/model.gguf", port: 8142 });
    const upstream = installConditionalChatUpstream();

    const res = await openaiProxy.proxyOpenAI(chatRequest(MIMO_ID), t.env);

    expect(res.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.url).toBe("http://127.0.0.1:17777/v1/chat/completions");
  } finally {
    t.cleanup();
  }
});

test("/v1/models excludes default-target rels from the unavailable list (P9)", () => {
  const t = tempEnv({ LLAMA_CPP_PORT: "17777", LLAMA_CPP_DEFAULT_MODEL: MIMO_REL });
  try {
    const models = openaiProxy.listOpenAIModels(t.env);
    const unavailable = unavailableEntries(models);

    expect(Array.isArray(unavailable)).toBe(true);
    expect((unavailable ?? []).some((e) => e.id === MIMO_REL)).toBe(false);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// #280 DF-07 — declared cold models. The declared-source seam and the
// `declared` sibling of /v1/models land with the fix; the structural
// cast keeps these cases typechecking before the export exists — they
// fail by assertion, never by a missing export or a type error. Every
// seam call is `?.` so the guards pass at base and afterEach never
// throws.
// ---------------------------------------------------------------------------

type DeclaredModelSource = (() => readonly unknown[]) | null;

const declaredModelSeam = openaiProxy as unknown as {
  setDeclaredModelSource?: (source: DeclaredModelSource) => void;
};

function declaredModelEntry(
  id: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    workload: "wl-declared",
    kind: "ModelRun",
    ownerNodeId: "local",
    state: "cold",
    autoLoadEligible: true,
    ...over,
  };
}

interface DeclaredListEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  workload: string;
  kind: string;
  status: string;
  auto_load_eligible: boolean;
  routable: boolean;
  reason?: string;
}

const declaredEntries = (models: unknown): DeclaredListEntry[] | undefined =>
  (models as { declared?: DeclaredListEntry[] }).declared;

describe("declared cold models (#280)", () => {
  afterEach(() => {
    declaredModelSeam.setDeclaredModelSource?.(null);
    openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
  });

  test("the route-map reset also clears the declared model source", async () => {
    const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
    try {
      const upstream = installConditionalChatUpstream();
      expect(typeof declaredModelSeam.setDeclaredModelSource).toBe("function");
      declaredModelSeam.setDeclaredModelSource?.(() => [declaredModelEntry("cold/model-a.gguf")]);

      const pinned = await openaiProxy.proxyOpenAI(chatRequest("cold/model-a.gguf"), t.env);
      expect(pinned.status).toBe(503);

      openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();

      const afterReset = await openaiProxy.proxyOpenAI(chatRequest("cold/model-a.gguf"), t.env);
      expect(afterReset.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
      expect(upstream.calls[0]!.url).toBe("http://127.0.0.1:17777/v1/chat/completions");
    } finally {
      t.cleanup();
    }
  });

  test("a declared cold pin returns 503 model_not_loaded instead of the default endpoint", async () => {
    const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
    try {
      const upstream = installConditionalChatUpstream();
      declaredModelSeam.setDeclaredModelSource?.(() => [declaredModelEntry("cold/model-a.gguf")]);

      const res = await openaiProxy.proxyOpenAI(chatRequest("cold/model-a.gguf"), t.env);

      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        error: {
          code: string;
          type: string;
          param: string;
          state: string;
          auto_load_eligible: boolean;
        };
      };
      expect(body.error.code).toBe("model_not_loaded");
      expect(body.error.type).toBe("model_not_loaded");
      expect(body.error.param).toBe("model");
      expect(body.error.state).toBe("cold");
      expect(body.error.auto_load_eligible).toBe(true);
      expect(res.headers.get("retry-after")).toBeNull();
      expect(upstream.calls).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  test("a declared cold pin is model_not_loaded, not model_not_routed, when routes exist", async () => {
    const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
    try {
      writeLlamaServerWorkload(t.dir, "wl-routed", { rel: "routed/model.gguf", port: 8142 });
      const upstream = installConditionalChatUpstream();
      declaredModelSeam.setDeclaredModelSource?.(() => [declaredModelEntry("cold/model-a.gguf")]);

      const res = await openaiProxy.proxyOpenAI(chatRequest("cold/model-a.gguf"), t.env);

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("model_not_loaded");
      expect(upstream.calls).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  test("a declared disabled entry returns 503 model_unavailable", async () => {
    const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
    try {
      const upstream = installConditionalChatUpstream();
      declaredModelSeam.setDeclaredModelSource?.(() => [
        declaredModelEntry("disabled/model-b.gguf", {
          state: "disabled",
          autoLoadEligible: false,
        }),
      ]);

      const res = await openaiProxy.proxyOpenAI(chatRequest("disabled/model-b.gguf"), t.env);

      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        error: {
          code: string;
          type: string;
          param: string;
          state: string;
          auto_load_eligible: boolean;
        };
      };
      expect(body.error.code).toBe("model_unavailable");
      expect(body.error.type).toBe("model_unavailable");
      expect(body.error.param).toBe("model");
      expect(body.error.state).toBe("disabled");
      expect(body.error.auto_load_eligible).toBe(false);
      expect(upstream.calls).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  test("a declared unavailable entry returns 503 model_unavailable with its reason", async () => {
    const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
    try {
      const upstream = installConditionalChatUpstream();
      declaredModelSeam.setDeclaredModelSource?.(() => [
        declaredModelEntry("unavailable/model-c.gguf", {
          state: "unavailable",
          autoLoadEligible: false,
          reason: "alias-collision",
        }),
      ]);

      const res = await openaiProxy.proxyOpenAI(chatRequest("unavailable/model-c.gguf"), t.env);

      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        error: { code: string; type: string; state: string; reason: string };
      };
      expect(body.error.code).toBe("model_unavailable");
      expect(body.error.type).toBe("model_unavailable");
      expect(body.error.state).toBe("unavailable");
      expect(body.error.reason).toBe("alias-collision");
      expect(upstream.calls).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  test("a declared cold pin through /v1/messages returns 503 model_not_loaded", async () => {
    const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
    try {
      const upstream = installConditionalChatUpstream();
      declaredModelSeam.setDeclaredModelSource?.(() => [declaredModelEntry("cold/model-a.gguf")]);

      const res = await openaiProxy.proxyOpenAI(
        anthropicChatRequest({
          model: "cold/model-a.gguf",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
        t.env,
      );

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("model_not_loaded");
      expect(upstream.calls).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  test("guard: a live route for the declared id wins and is forwarded", async () => {
    const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
    try {
      writeLlamaServerWorkload(t.dir, "wl-cold", { rel: "cold/model-a.gguf", port: 8350 });
      const upstream = installConditionalChatUpstream();
      declaredModelSeam.setDeclaredModelSource?.(() => [declaredModelEntry("cold/model-a.gguf")]);

      const res = await openaiProxy.proxyOpenAI(chatRequest("cold/model-a.gguf"), t.env);

      expect(res.status).toBe(200);
      const chatCalls = upstream.calls.filter((c) => c.url.endsWith("/v1/chat/completions"));
      expect(chatCalls).toHaveLength(1);
      expect(chatCalls[0]!.url).toBe("http://127.0.0.1:8350/v1/chat/completions");
    } finally {
      t.cleanup();
    }
  });

  test("guard: a default-target id keeps the default-endpoint fallthrough", async () => {
    const t = tempEnv({ LLAMA_CPP_PORT: "17777", LLAMA_CPP_SERVER_ALIAS: "cold/model-a.gguf" });
    try {
      writeLlamaServerWorkload(t.dir, "wl-routed", { rel: "routed/model.gguf", port: 8142 });
      const upstream = installConditionalChatUpstream();
      declaredModelSeam.setDeclaredModelSource?.(() => [declaredModelEntry("cold/model-a.gguf")]);

      const res = await openaiProxy.proxyOpenAI(chatRequest("cold/model-a.gguf"), t.env);

      expect(res.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
      expect(upstream.calls[0]!.url).toBe("http://127.0.0.1:17777/v1/chat/completions");
    } finally {
      t.cleanup();
    }
  });

  test("guard: a ready declared entry with no live route is model_not_routed when routes exist", async () => {
    const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
    try {
      writeLlamaServerWorkload(t.dir, "wl-routed", { rel: "routed/model.gguf", port: 8142 });
      const upstream = installConditionalChatUpstream();
      declaredModelSeam.setDeclaredModelSource?.(() => [
        declaredModelEntry("ready/model.gguf", { state: "ready", autoLoadEligible: false }),
      ]);

      const res = await openaiProxy.proxyOpenAI(chatRequest("ready/model.gguf"), t.env);

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("model_not_routed");
      expect(upstream.calls).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  test("guard: an undeclared unknown id is model_not_routed with known_models", async () => {
    const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
    try {
      writeLlamaServerWorkload(t.dir, "wl-routed", { rel: "routed/model.gguf", port: 8142 });
      const upstream = installConditionalChatUpstream();
      declaredModelSeam.setDeclaredModelSource?.(() => [declaredModelEntry("cold/other.gguf")]);

      const res = await openaiProxy.proxyOpenAI(chatRequest("nope/unknown.gguf"), t.env);

      expect(res.status).toBe(404);
      const body = (await res.json()) as {
        error: { code: string; known_models: string[] };
      };
      expect(body.error.code).toBe("model_not_routed");
      expect(body.error.known_models.includes("routed/model.gguf")).toBe(true);
      expect(upstream.calls).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  test("guard: a throwing declared source is treated as empty", async () => {
    const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
    try {
      const upstream = installConditionalChatUpstream();
      declaredModelSeam.setDeclaredModelSource?.(() => {
        throw new Error("declared source boom");
      });

      const res = await openaiProxy.proxyOpenAI(chatRequest("cold/model-a.gguf"), t.env);

      expect(res.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
      expect(upstream.calls[0]!.url).toBe("http://127.0.0.1:17777/v1/chat/completions");
    } finally {
      t.cleanup();
    }
  });

  test("guard: schema-invalid declared entries are treated as empty", async () => {
    const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
    try {
      const upstream = installConditionalChatUpstream();
      declaredModelSeam.setDeclaredModelSource?.(() => [
        { id: "cold/model-a.gguf", state: "warm" },
        { id: "", state: "cold" },
      ]);

      const res = await openaiProxy.proxyOpenAI(chatRequest("cold/model-a.gguf"), t.env);

      expect(res.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
    } finally {
      t.cleanup();
    }
  });

  test("guard: the catalog unavailable rejection still wins over a declared cold entry", async () => {
    const t = tempEnv({ LLAMA_CPP_PORT: "17777" });
    try {
      writeFileSync(join(t.dir, "curated-models.tsv"), `${COLD_UNAVAILABLE_ROW}\n`);
      writeLlamaServerWorkload(t.dir, "wl-routed", { rel: "routed/model.gguf", port: 8142 });
      const upstream = installConditionalChatUpstream();
      declaredModelSeam.setDeclaredModelSource?.(() => [declaredModelEntry("cold/x.gguf")]);

      const res = await openaiProxy.proxyOpenAI(chatRequest("cold/x.gguf"), t.env);

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string; reason: string } };
      expect(body.error.code).toBe("model_unavailable");
      expect(body.error.reason).toBe("runtime-unsupported:test");
      expect(upstream.calls).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  test("/v1/models lists each non-ready declared entry sorted by id", () => {
    const t = tempEnv();
    try {
      writeLlamaServerWorkload(t.dir, "wl-live", { rel: "live/model.gguf", port: 8360 });
      declaredModelSeam.setDeclaredModelSource?.(() => [
        declaredModelEntry("cold/b.gguf", { workload: "wl-b", kind: "ModelHost" }),
        declaredModelEntry("cold/a.gguf", { workload: "wl-a" }),
        declaredModelEntry("disabled/d.gguf", {
          workload: "wl-d",
          state: "disabled",
          autoLoadEligible: false,
        }),
        declaredModelEntry("unavailable/u.gguf", {
          workload: "wl-u",
          state: "unavailable",
          autoLoadEligible: false,
          reason: "alias-collision",
        }),
        declaredModelEntry("ready/r.gguf", {
          workload: "wl-r",
          state: "ready",
          autoLoadEligible: false,
        }),
        declaredModelEntry("live/model.gguf", { workload: "wl-shadow" }),
      ]);

      const models = openaiProxy.listOpenAIModels(t.env);

      expect(declaredEntries(models)).toEqual([
        {
          id: "cold/a.gguf",
          object: "model",
          created: 0,
          owned_by: "llamactl-declared",
          workload: "wl-a",
          kind: "ModelRun",
          status: "cold",
          auto_load_eligible: true,
          routable: false,
        },
        {
          id: "cold/b.gguf",
          object: "model",
          created: 0,
          owned_by: "llamactl-declared",
          workload: "wl-b",
          kind: "ModelHost",
          status: "cold",
          auto_load_eligible: true,
          routable: false,
        },
        {
          id: "disabled/d.gguf",
          object: "model",
          created: 0,
          owned_by: "llamactl-declared",
          workload: "wl-d",
          kind: "ModelRun",
          status: "disabled",
          auto_load_eligible: false,
          routable: false,
        },
        {
          id: "unavailable/u.gguf",
          object: "model",
          created: 0,
          owned_by: "llamactl-declared",
          workload: "wl-u",
          kind: "ModelRun",
          status: "unavailable",
          auto_load_eligible: false,
          routable: false,
          reason: "alias-collision",
        },
      ]);
      expect(models.data.some((m) => m.id === "live/model.gguf")).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("/v1/models declared omits live, default-target and catalog-unavailable ids", () => {
    const t = tempEnv({ LLAMA_CPP_SERVER_ALIAS: "cold/default.gguf" });
    try {
      writeLlamaServerWorkload(t.dir, "wl-live", { rel: "live/model.gguf", port: 8360 });
      writeFileSync(join(t.dir, "curated-models.tsv"), `${COLD_UNAVAILABLE_ROW}\n`);
      declaredModelSeam.setDeclaredModelSource?.(() => [
        declaredModelEntry("live/model.gguf", { workload: "wl-shadow" }),
        declaredModelEntry("cold/default.gguf"),
        declaredModelEntry("cold/x.gguf"),
        declaredModelEntry("cold/keep.gguf"),
      ]);

      const models = openaiProxy.listOpenAIModels(t.env);
      const declared = declaredEntries(models);

      expect(declared?.map((e) => e.id)).toEqual(["cold/keep.gguf"]);
      expect(unavailableEntries(models)?.some((e) => e.id === "cold/x.gguf")).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("/v1/models data is unchanged by a declared source", () => {
    const t = tempEnv();
    try {
      writeLlamaServerWorkload(t.dir, "wl-live", { rel: "live/model.gguf", port: 8360 });
      const before = openaiProxy.listOpenAIModels(t.env);
      declaredModelSeam.setDeclaredModelSource?.(() => [declaredModelEntry("cold/new.gguf")]);
      const after = openaiProxy.listOpenAIModels(t.env);

      expect(after.data).toEqual(before.data);
      expect(declaredEntries(after)).toEqual([
        {
          id: "cold/new.gguf",
          object: "model",
          created: 0,
          owned_by: "llamactl-declared",
          workload: "wl-declared",
          kind: "ModelRun",
          status: "cold",
          auto_load_eligible: true,
          routable: false,
        },
      ]);
    } finally {
      t.cleanup();
    }
  });

  test("/v1/models declared is an empty array when no source is set", () => {
    const t = tempEnv();
    try {
      writeLlamaServerWorkload(t.dir, "wl-live", { rel: "live/model.gguf", port: 8360 });

      const models = openaiProxy.listOpenAIModels(t.env);
      const declared = declaredEntries(models);

      expect(Array.isArray(declared)).toBe(true);
      expect(declared).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("/v1/models declared reflects source mutations without re-registering", () => {
    const t = tempEnv();
    try {
      const entries = [declaredModelEntry("cold/first.gguf")];
      declaredModelSeam.setDeclaredModelSource?.(() => entries);

      const first = declaredEntries(openaiProxy.listOpenAIModels(t.env));
      expect(first?.map((e) => e.id)).toEqual(["cold/first.gguf"]);

      entries.push(declaredModelEntry("cold/second.gguf"));

      const second = declaredEntries(openaiProxy.listOpenAIModels(t.env));
      expect(second?.map((e) => e.id)).toEqual(["cold/first.gguf", "cold/second.gguf"]);
    } finally {
      t.cleanup();
    }
  });

  test("declaredModelEntries dedupes by first-claim-wins on duplicate ids", () => {
    const t = tempEnv();
    try {
      declaredModelSeam.setDeclaredModelSource?.(() => [
        declaredModelEntry("cold/dup.gguf", { workload: "wl-alpha" }),
        declaredModelEntry("cold/dup.gguf", { workload: "wl-beta" }),
        declaredModelEntry("cold/dup.gguf", { workload: "wl-gamma" }),
      ]);

      const models = openaiProxy.listOpenAIModels(t.env);
      const declared = declaredEntries(models);

      const dupIds = declared?.filter((e) => e.id === "cold/dup.gguf");
      expect(dupIds?.length).toBe(1);
      expect(dupIds?.[0]?.workload).toBe("wl-alpha");
    } finally {
      t.cleanup();
    }
  });
});
