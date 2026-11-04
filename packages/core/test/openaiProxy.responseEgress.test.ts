import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";

import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

function tempEnv(): { env: ResolvedEnv; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-response-egress-"));
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

const anthropicRequestBody = JSON.stringify({
  model: "claude-compatible-test",
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 16,
});

const responsesRequestBody = JSON.stringify({
  model: "m",
  input: "hi",
});

const openAiPassthroughBody = JSON.stringify({
  model: "m",
  input: "hi",
});

describe("openaiProxy response egress — passthrough header sanitization", () => {
  test("(1) Passthrough drops the upstream `connection` response header", async () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      const stub = ((_input: Request | URL | string, _init?: RequestInit) => {
        const upstream = new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            connection: "keep-alive",
            "x-upstream-marker": "kept",
          },
        });
        expect(upstream.headers.get("connection")).toBe("keep-alive");
        return Promise.resolve(upstream);
      }) as typeof globalThis.fetch;
      globalThis.fetch = stub;
      const res = await openaiProxy.proxyOpenAI(
        new Request("http://localhost/v1/embeddings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: openAiPassthroughBody,
        }),
        env,
      );
      expect(res.headers.get("connection")).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("(2) Passthrough drops `transfer-encoding`", async () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      const stub = ((_input: Request | URL | string, _init?: RequestInit) => {
        const upstream = new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "transfer-encoding": "chunked",
          },
        });
        expect(upstream.headers.get("transfer-encoding")).toBe("chunked");
        return Promise.resolve(upstream);
      }) as typeof globalThis.fetch;
      globalThis.fetch = stub;
      const res = await openaiProxy.proxyOpenAI(
        new Request("http://localhost/v1/embeddings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: openAiPassthroughBody,
        }),
        env,
      );
      expect(res.headers.get("transfer-encoding")).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("(3) Passthrough keeps other upstream headers, status and statusText", async () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      const stub = ((input: Request | URL | string, init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 207,
            statusText: "Multi-Status-Test",
            headers: {
              "content-type": "application/json",
              "x-upstream-marker": "kept",
            },
          }),
        )) as typeof globalThis.fetch;
      globalThis.fetch = stub;
      const res = await openaiProxy.proxyOpenAI(
        new Request("http://localhost/v1/embeddings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: openAiPassthroughBody,
        }),
        env,
      );
      expect(res.status).toBe(207);
      expect(res.statusText).toBe("Multi-Status-Test");
      expect(res.headers.get("x-upstream-marker")).toBe("kept");
    } finally {
      cleanup();
    }
  });
});

describe("openaiProxy response egress — Anthropic translation", () => {
  test("(4) Anthropic: non-ok upstream JSON reply passes through untranslated", async () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      const upstreamJson = { error: { message: "rate limited", type: "rate_limit" } };
      const stub = ((input: Request | URL | string, init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify(upstreamJson), {
            status: 429,
            headers: { "content-type": "application/json" },
          }),
        )) as typeof globalThis.fetch;
      globalThis.fetch = stub;
      const res = await openaiProxy.proxyOpenAI(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: anthropicRequestBody,
        }),
        env,
      );
      expect(res.status).toBe(429);
      const body = (await res.json()) as unknown;
      expect(body).toEqual(upstreamJson);
      expect((body as { error?: { type?: string } }).error?.type).not.toBe(
        "anthropic_response_translation_error",
      );
    } finally {
      cleanup();
    }
  });

  test("(5) Anthropic: ok upstream JSON reply with no choices gives 502", async () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      const stub = ((input: Request | URL | string, init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )) as typeof globalThis.fetch;
      globalThis.fetch = stub;
      const res = await openaiProxy.proxyOpenAI(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: anthropicRequestBody,
        }),
        env,
      );
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { message: string; type: string } };
      expect(body.error.type).toBe("anthropic_response_translation_error");
      expect(body.error.message).toBe("openai response missing choices");
    } finally {
      cleanup();
    }
  });

  test("(6) Anthropic: a '+json' upstream content-type is still translated", async () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      const completion = {
        id: "c1",
        model: "x",
        choices: [
          { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      };
      const stub = ((input: Request | URL | string, init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify(completion), {
            status: 200,
            headers: { "content-type": "application/vnd.test+json" },
          }),
        )) as typeof globalThis.fetch;
      globalThis.fetch = stub;
      const res = await openaiProxy.proxyOpenAI(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: anthropicRequestBody,
        }),
        env,
      );
      const body = (await res.json()) as {
        type: string;
        content: { type: string; text: string }[];
      };
      expect(body.type).toBe("message");
      expect(body.content).toEqual([{ type: "text", text: "hello" }]);
    } finally {
      cleanup();
    }
  });

  test("(7) Anthropic: non-JSON, non-SSE upstream reply passes through verbatim", async () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      const stub = ((input: Request | URL | string, init?: RequestInit) =>
        Promise.resolve(
          new Response("raw-body", {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
        )) as typeof globalThis.fetch;
      globalThis.fetch = stub;
      const res = await openaiProxy.proxyOpenAI(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: anthropicRequestBody,
        }),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("raw-body");
    } finally {
      cleanup();
    }
  });

  test("(8) Anthropic: translated JSON reply keeps sanitized upstream headers", async () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      const completion = {
        id: "c1",
        model: "x",
        choices: [
          { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      };
      const stub = ((input: Request | URL | string, init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify(completion), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-upstream-marker": "kept",
            },
          }),
        )) as typeof globalThis.fetch;
      globalThis.fetch = stub;
      const res = await openaiProxy.proxyOpenAI(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: anthropicRequestBody,
        }),
        env,
      );
      expect(res.headers.get("x-upstream-marker")).toBe("kept");
    } finally {
      cleanup();
    }
  });
});

describe("openaiProxy response egress — Responses API translation", () => {
  test("(9) Responses: ok upstream JSON reply with no choices gives 502", async () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      const stub = ((input: Request | URL | string, init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )) as typeof globalThis.fetch;
      globalThis.fetch = stub;
      const res = await openaiProxy.proxyOpenAI(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: responsesRequestBody,
        }),
        env,
      );
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { message: string; type: string } };
      expect(body.error.type).toBe("responses_response_translation_error");
      expect(body.error.message).toBe("chat completion response missing choices");
    } finally {
      cleanup();
    }
  });

  test("(10) Responses: non-ok upstream JSON reply passes through untranslated", async () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      const upstreamJson = { error: { message: "busy" } };
      const stub = ((input: Request | URL | string, init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify(upstreamJson), {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
        )) as typeof globalThis.fetch;
      globalThis.fetch = stub;
      const res = await openaiProxy.proxyOpenAI(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: responsesRequestBody,
        }),
        env,
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as unknown;
      expect(body).toEqual(upstreamJson);
    } finally {
      cleanup();
    }
  });
});
