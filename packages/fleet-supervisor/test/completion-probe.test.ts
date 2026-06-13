/* eslint-disable @typescript-eslint/require-await -- Test fetch stubs implement the async fetch contract without artificial scheduling. */
import { describe, expect, it } from "bun:test";

import type { CompletionProbeConfig } from "../src/completion-probe.js";

import { probeCompletion } from "../src/completion-probe.js";

const CONFIG: CompletionProbeConfig = {
  path: "/v1/chat/completions",
  prompt: "ping",
  maxTokens: 1,
  timeoutMs: 500,
  everyNTicks: 4,
};

const ENDPOINT = "http://127.0.0.1:8086";

describe("probeCompletion", () => {
  it("2xx → ok, resets consecutiveFailures to 0", async () => {
    const fakeFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ choices: [{ message: { content: "p" } }] }), { status: 200 });
    const result = await probeCompletion(ENDPOINT, {
      config: CONFIG,
      fetch: fakeFetch as unknown as typeof fetch,
      priorConsecutiveFailures: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.classification).toBe("ok");
    expect(result.status).toBe(200);
    expect(result.consecutiveFailures).toBe(0);
  });

  it("5xx → wedge, increments consecutiveFailures", async () => {
    const fakeFetch = async (): Promise<Response> =>
      new Response("Service Unavailable", { status: 503 });
    const result = await probeCompletion(ENDPOINT, {
      config: CONFIG,
      fetch: fakeFetch as unknown as typeof fetch,
      priorConsecutiveFailures: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.classification).toBe("wedge");
    expect(result.status).toBe(503);
    expect(result.consecutiveFailures).toBe(2);
  });

  it("timeout / network error → wedge, increments", async () => {
    const fakeFetch = async (): Promise<Response> => {
      throw new Error("aborted");
    };
    const result = await probeCompletion(ENDPOINT, {
      config: CONFIG,
      fetch: fakeFetch as unknown as typeof fetch,
      priorConsecutiveFailures: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.classification).toBe("wedge");
    expect(result.status).toBeNull();
    expect(result.consecutiveFailures).toBe(1);
  });

  it("4xx → misconfigured, leaves the counter unchanged (recycle won't fix a 404)", async () => {
    const fakeFetch = async (): Promise<Response> => new Response("Not Found", { status: 404 });
    const result = await probeCompletion(ENDPOINT, {
      config: CONFIG,
      fetch: fakeFetch as unknown as typeof fetch,
      priorConsecutiveFailures: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.classification).toBe("misconfigured");
    expect(result.status).toBe(404);
    expect(result.consecutiveFailures).toBe(1);
  });

  it("uses config.model when set", async () => {
    let sentModel: string | undefined;
    const fakeFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      sentModel = (JSON.parse(init?.body as string) as { model: string }).model;
      return new Response("{}", { status: 200 });
    };
    await probeCompletion(ENDPOINT, {
      config: { ...CONFIG, model: "granite-3b" },
      fetch: fakeFetch as unknown as typeof fetch,
    });
    expect(sentModel).toBe("granite-3b");
  });

  it("falls back to the first served model when config.model is unset", async () => {
    let sentModel: string | undefined;
    const fakeFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      sentModel = (JSON.parse(init?.body as string) as { model: string }).model;
      return new Response("{}", { status: 200 });
    };
    await probeCompletion(ENDPOINT, {
      config: CONFIG,
      models: ["granite-mini-3b", "granite-rel"],
      fetch: fakeFetch as unknown as typeof fetch,
    });
    expect(sentModel).toBe("granite-mini-3b");
  });

  it("posts a minimal non-streaming chat body to the configured path", async () => {
    let calledUrl = "";
    let calledMethod = "";
    let parsedBody: Record<string, unknown> = {};
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      calledUrl = url;
      calledMethod = String(init?.method);
      parsedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response("{}", { status: 200 });
    };
    await probeCompletion(ENDPOINT, {
      config: CONFIG,
      fetch: fakeFetch as unknown as typeof fetch,
    });
    expect(calledUrl).toBe("http://127.0.0.1:8086/v1/chat/completions");
    expect(calledMethod).toBe("POST");
    expect(parsedBody.max_tokens).toBe(1);
    expect(parsedBody.stream).toBe(false);
  });

  it("rejects an SSRF endpoint as misconfigured without incrementing", async () => {
    const fakeFetch = async (): Promise<Response> => new Response("{}", { status: 200 });
    const result = await probeCompletion("http://169.254.169.254", {
      config: CONFIG,
      fetch: fakeFetch as unknown as typeof fetch,
      priorConsecutiveFailures: 2,
    });
    expect(result.classification).toBe("misconfigured");
    expect(result.consecutiveFailures).toBe(2);
  });
});
