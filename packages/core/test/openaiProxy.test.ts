import { afterEach, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";
import type { PeerSnapshot } from "../src/workloadRuntime.js";

import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

function tempEnv(): { env: ResolvedEnv; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-core-"));
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
  } satisfies { env: ResolvedEnv; dir: string; cleanup: () => void };
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

test("/v1/messages SSE responses translate to anthropic stream events", async () => {
  const t = tempEnv();
  try {
    const stream = new ReadableStream({
      start(controller): void {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"id":"msg_1","choices":[{"delta":{"content":"hello"},"finish_reason":null}],"usage":{"completion_tokens":1}}\n\n',
          ),
        );
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'),
        );
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    globalThis.fetch = (() =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;

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
