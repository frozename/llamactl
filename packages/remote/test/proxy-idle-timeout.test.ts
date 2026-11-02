import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, rmSync } from "../src/safe-fs.js";
import { generateToken } from "../src/server/auth.js";
import { type RunningAgent, startAgentServer } from "../src/server/serve.js";

/**
 * The production bug this guards: a non-streaming /v1/chat/completions
 * whose upstream needs minutes of silent prefill was cut at ~4 min by
 * Bun fetch's implicit ~5-minute socket ceiling (surfaced as
 * "The operation timed out"). The proxy now lifts that ceiling
 * (timeout:false + an AbortSignal budget) and re-arms each proxied
 * request's socket idle budget via server.timeout, so responses
 * survive past the global idleTimeout. This suite scales the global
 * limit down via the idleTimeoutSeconds test option instead of
 * waiting minutes.
 *
 * Note the test shape: Bun.serve's idleTimeout only reaps requests
 * that carry no body — a POST whose handler reads a JSON body keeps
 * its socket budget regardless, so the per-request bump is pinned
 * with a GET passthrough, the route class actually exposed.
 */

const UPSTREAM_ORIGIN = "http://127.0.0.1:18123";
const ENV_KEYS = ["DEV_STORAGE", "LOCAL_AI_RUNTIME_DIR", "LLAMA_CPP_MODELS", "LLAMA_CPP_PORT"];
const originalFetch = globalThis.fetch;

function installDelayedUpstream(delayMs: number): void {
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(UPSTREAM_ORIGIN)) return await originalFetch(input, init);
    await new Promise((r) => setTimeout(r, delayMs));
    return Response.json({
      id: "chatcmpl-slow",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "slow-ok" },
          finish_reason: "stop",
        },
      ],
    });
  }) as unknown as typeof fetch;
}

describe("startAgentServer — proxied inference outlives the global idleTimeout", () => {
  let dir: string;
  let agent: RunningAgent | null = null;
  const { token, hash } = generateToken();
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llamactl-proxy-idle-"));
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    process.env["DEV_STORAGE"] = dir;
    process.env["LOCAL_AI_RUNTIME_DIR"] = join(dir, "runtime");
    process.env["LLAMA_CPP_MODELS"] = join(dir, "models");
    process.env["LLAMA_CPP_PORT"] = UPSTREAM_ORIGIN.slice(UPSTREAM_ORIGIN.lastIndexOf(":") + 1);
    // idleTimeoutSeconds:1 scales the production 255s global limit down
    // to ~4s of uWS sweep granularity — the upstream's 8s delay sits
    // squarely past it, which is exactly where the bug bit.
    agent = startAgentServer({ tokenHash: hash, idleTimeoutSeconds: 1 });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await agent?.stop();
    agent = null;
    rmSync(dir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  test("a GET passthrough past the global idleTimeout still delivers its response", async () => {
    installDelayedUpstream(8_000);
    const res = await fetch(`${agent!.url}/v1/embeddings`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(body.choices[0]?.message.content).toBe("slow-ok");
  }, 20_000);

  test("POST /v1/chat/completions end-to-end past the global idleTimeout", async () => {
    installDelayedUpstream(8_000);
    const res = await fetch(`${agent!.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: "no-such-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(body.choices[0]?.message.content).toBe("slow-ok");
  }, 20_000);

  test("non-proxied routes still answer quickly under the same server", async () => {
    installDelayedUpstream(8_000);
    const res = await fetch(`${agent!.url}/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  }, 10_000);
});
