import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";
import type { PeerSnapshot } from "../src/workloadRuntime.js";

import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
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
    const calls: { url: string }[] = [];
    globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.headers) {
        forwardedAuthorization = new Headers(init.headers).get("authorization") ?? "";
      }
      const forwardedInit = init as RequestInit & { tls?: { ca: string } };
      if (forwardedInit.tls) {
        forwardedCa = forwardedInit.tls.ca;
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

test("an unknown model keeps the legacy local fallback endpoint", async () => {
  // Compatibility contract at 7443403: an unrecognized `model` falls
  // through to the singleton llama-server rather than 404ing. Whether a
  // strict unknown-model error is desirable is a later-slice decision —
  // this test freezes the current behavior.
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

    // Frozen public error envelope: 502 + {error:{message,type}}.
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: {
        message: "upstream llama-server unreachable: connect ECONNREFUSED",
        type: "llamactl_upstream_error",
      },
    });
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
