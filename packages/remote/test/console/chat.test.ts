import { writeModelHostState } from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";
import { afterEach, expect, test } from "bun:test";

import * as server from "../../src/console/server.js";
import {
  apiHeaders,
  cleanupConsoleTest,
  consoleTestFixture,
  setEnv,
  startConsole,
  tmpDir,
} from "./helpers.js";

afterEach(cleanupConsoleTest);

test("lists models and posts only chat messages to the selected agent", async () => {
  const calls: { path: string; auth: string | null; method: string; body?: unknown }[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const call = { path, auth: req.headers.get("authorization"), method: req.method };
      if (path === "/v1/models") {
        calls.push(call);
        return Response.json({ data: [{ id: "fixture/model", private: "hidden" }] });
      }
      calls.push({ ...call, body: await req.json() });
      return new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream", "set-cookie": "upstream=hidden" },
      });
    },
  });
  try {
    const { distPath } = consoleTestFixture({
      nodes: [{ name: "fixture", endpoint: upstream.url.origin }],
    });
    const consoleServer = await startConsole(server, { distPath });
    const base = `${consoleServer.url}/api/n/fixture/chat`;
    const headers = apiHeaders(consoleServer, { "content-type": "application/json" });
    const messages = [{ role: "user", content: "A test prompt" }];
    expect((await fetch(`${base}/models`)).status).toBe(403);
    expect(
      (await fetch(`${base}/models`, { headers: { "sec-fetch-site": "same-origin" } })).status,
    ).toBe(401);
    expect((await fetch(`${base}/completions`, { headers })).status).toBe(405);
    const invalid = await fetch(`${base}/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "fixture/model", messages, tools: [] }),
    });
    expect(invalid.status).toBe(400);
    expect(calls).toHaveLength(0);

    const catalog = await fetch(`${base}/models`, { headers });
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toEqual({ models: ["fixture/model"] });
    const answer = await fetch(`${base}/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "fixture/model", messages }),
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toContain("text/event-stream");
    expect(answer.headers.get("set-cookie")).toBeNull();
    expect(await answer.text()).toContain("Hello");
    expect(calls).toEqual([
      { path: "/v1/models", auth: "Bearer tok-console-test", method: "GET" },
      {
        path: "/v1/chat/completions",
        auth: "Bearer tok-console-test",
        method: "POST",
        body: { model: "fixture/model", messages, stream: true },
      },
    ]);
  } finally {
    await upstream.stop(true);
  }
});

test("aborting a console reply cancels the node response body", async () => {
  const cancelled = Promise.withResolvers<string>();
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const body = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
        },
        cancel(): void {
          cancelled.resolve("cancelled");
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const { distPath } = consoleTestFixture({
      nodes: [{ name: "fixture", endpoint: upstream.url.origin }],
    });
    const consoleServer = await startConsole(server, { distPath });
    const controller = new AbortController();
    const response = await fetch(`${consoleServer.url}/api/n/fixture/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: apiHeaders(consoleServer, { "content-type": "application/json" }),
      body: JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "Hello" }] }),
    });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    controller.abort();
    const result = await Promise.race([cancelled.promise, Bun.sleep(1000).then(() => "timeout")]);
    expect(result).toBe("cancelled");
  } finally {
    await upstream.stop(true);
  }
});

test("routes the local node through the serving model catalog and proxy", async () => {
  let received: unknown;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/chat/completions")
        return new Response(null, { status: 404 });
      received = await req.json();
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const { distPath } = consoleTestFixture();
    setEnv("LOCAL_AI_RUNTIME_DIR", tmpDir("console-chat-runtime-"));
    setEnv("LLAMACTL_UNIFIED_PROXY", "0");
    writeModelHostState(
      {
        kind: "ModelHost",
        engine: "llamacpp",
        pid: process.pid,
        host: "127.0.0.1",
        port: upstream.port!,
        modelAliases: ["chat-fixture-local"],
        startedAt: "2026-11-26T00:00:00.000Z",
      },
      { name: "chat-fixture" },
      resolveEnv(),
    );
    const consoleServer = await startConsole(server, { distPath });
    const base = `${consoleServer.url}/api/n/local/chat`;
    const headers = apiHeaders(consoleServer, { "content-type": "application/json" });
    const catalog = await fetch(`${base}/models`, { headers });
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toEqual({ models: ["chat-fixture-local"] });
    const response = await fetch(`${base}/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "chat-fixture-local",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("[DONE]");
    expect(received).toMatchObject({ model: "chat-fixture-local", stream: true });
  } finally {
    await upstream.stop(true);
  }
});
