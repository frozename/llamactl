import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";

import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

/**
 * Coverage for the explicit upstream-fetch deadline. Bun's HTTP client
 * arms every fetch socket with an implicit ~5-minute idle ceiling
 * (socket.setTimeoutMinutes(5)); the proxy lifts that with
 * `timeout: false` and bounds the fetch itself with an
 * AbortSignal.timeout derived from LLAMACTL_UPSTREAM_TIMEOUT_MS, so the
 * limit is explicit, configurable, and comfortably above long cold
 * prefills.
 */

const TIMEOUT_ENV = "LLAMACTL_UPSTREAM_TIMEOUT_MS";
const originalFetch = globalThis.fetch;
const originalTimeoutEnv = process.env[TIMEOUT_ENV];

afterEach(() => {
  globalThis.fetch = originalFetch;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
  if (originalTimeoutEnv === undefined) delete process.env["LLAMACTL_UPSTREAM_TIMEOUT_MS"];
  else process.env[TIMEOUT_ENV] = originalTimeoutEnv;
});

function tempEnv(): { env: ResolvedEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-openai-proxy-timeout-"));
  return {
    env: resolveEnv({
      DEV_STORAGE: dir,
      LOCAL_AI_RUNTIME_DIR: dir,
      LLAMA_CPP_MODELS: join(dir, "models"),
    }),
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function chatRequest(init?: { signal?: AbortSignal }): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "no-such-model",
      messages: [{ role: "user", content: "hi" }],
    }),
    ...(init?.signal !== undefined ? { signal: init.signal } : {}),
  });
}

const SLOW_CHAT_JSON = {
  id: "chatcmpl-slow",
  object: "chat.completion",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "slow-ok" },
      finish_reason: "stop",
    },
  ],
};

describe("upstreamTimeoutMs", () => {
  test("defaults to 15 minutes, honors the env override, and rejects invalid values", () => {
    delete process.env["LLAMACTL_UPSTREAM_TIMEOUT_MS"];
    expect(openaiProxy.upstreamTimeoutMs()).toBe(15 * 60 * 1000);
    process.env[TIMEOUT_ENV] = "250";
    expect(openaiProxy.upstreamTimeoutMs()).toBe(250);
    process.env[TIMEOUT_ENV] = "not-a-number";
    expect(openaiProxy.upstreamTimeoutMs()).toBe(15 * 60 * 1000);
    process.env[TIMEOUT_ENV] = "0";
    expect(openaiProxy.upstreamTimeoutMs()).toBe(15 * 60 * 1000);
    process.env[TIMEOUT_ENV] = "-500";
    expect(openaiProxy.upstreamTimeoutMs()).toBe(15 * 60 * 1000);
  });
});

describe("forward() upstream deadline", () => {
  test("the upstream fetch lifts Bun's implicit socket ceiling via timeout:false", async () => {
    const t = tempEnv();
    try {
      let observed: (RequestInit & { timeout?: unknown }) | undefined;
      globalThis.fetch = ((_input: Request | URL | string, init?: RequestInit) => {
        observed = init;
        return Promise.resolve(Response.json(SLOW_CHAT_JSON));
      }) as unknown as typeof fetch;

      const res = await openaiProxy.proxyOpenAI(chatRequest(), t.env);
      expect(res.status).toBe(200);
      expect(observed).not.toBeNull();
      expect(observed?.timeout).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  test("the proxy waits for a slow upstream up to the configured limit and returns its body", async () => {
    const t = tempEnv();
    try {
      process.env[TIMEOUT_ENV] = "5000";
      globalThis.fetch = (() =>
        new Promise<Response>((resolve) => {
          setTimeout(() => {
            resolve(Response.json(SLOW_CHAT_JSON));
          }, 400);
        })) as unknown as typeof fetch;

      const res = await openaiProxy.proxyOpenAI(chatRequest(), t.env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        choices: { message: { content: string } }[];
      };
      expect(body.choices[0]?.message.content).toBe("slow-ok");
    } finally {
      t.cleanup();
    }
  });

  test("the configured limit still applies: a slower upstream is aborted", async () => {
    const t = tempEnv();
    try {
      process.env[TIMEOUT_ENV] = "150";
      let upstreamAborted = false;
      globalThis.fetch = ((_input: Request | URL | string, init?: RequestInit) => {
        const signal = init?.signal;
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve(Response.json(SLOW_CHAT_JSON));
          }, 5_000);
          signal?.addEventListener(
            "abort",
            () => {
              upstreamAborted = true;
              clearTimeout(timer);
              const reason: unknown = signal.reason;
              reject(reason instanceof Error ? reason : new Error("aborted"));
            },
            { once: true },
          );
        });
      }) as unknown as typeof fetch;

      const startedAt = performance.now();
      const res = await openaiProxy.proxyOpenAI(chatRequest(), t.env);
      const elapsed = performance.now() - startedAt;

      expect(upstreamAborted).toBe(true);
      expect(res.status).toBe(502);
      // The 150ms budget fired long before the fake upstream's 5s reply.
      expect(elapsed).toBeLessThan(3_000);
      const body = (await res.json()) as { error: { type: string; message: string } };
      expect(body.error.type).toBe("llamactl_upstream_error");
      expect(body.error.message.startsWith("upstream llama-server unreachable:")).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("a client abort still cancels the upstream fetch under a large configured limit", async () => {
    const t = tempEnv();
    try {
      process.env[TIMEOUT_ENV] = "60000";
      let upstreamAborted = false;
      globalThis.fetch = ((_input: Request | URL | string, init?: RequestInit) => {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              upstreamAborted = true;
              reject(new DOMException("The operation was aborted.", "AbortError"));
            },
            { once: true },
          );
        });
      }) as unknown as typeof fetch;

      const controller = new AbortController();
      const responsePromise = openaiProxy.proxyOpenAI(
        chatRequest({ signal: controller.signal }),
        t.env,
      );
      await new Promise((r) => setTimeout(r, 5));
      controller.abort();
      const res = await responsePromise;

      expect(upstreamAborted).toBe(true);
      expect(res.status).toBe(502);
    } finally {
      t.cleanup();
    }
  });
});
