import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ClusterNode, Config, User } from "../src/config/schema.js";

import { providerForNode } from "../src/providers/factory.js";

/**
 * FIX [10]: provider-kind virtual nodes must mirror the DIRECT cloud
 * path's base-URL normalization + provider quirks. Before the fix,
 * `providerForVirtualNode` built the adapter with `parent.cloud.baseUrl`
 * RAW — skipping `normalizeOpenAICompatBaseUrl` (so a parent registered
 * as `https://api.openai.com` without `/v1` hit `/models` instead of
 * `/v1/models`) and `applyProviderQuirks` (so a gemini virtual node lost
 * the `models/`-strip + hardcoded-catalog fallback the direct path has).
 *
 * These tests pin that a virtual node produces the SAME normalized URL +
 * quirk as the direct node over the same provider.
 */

const user: User = { name: "me", token: "fake-token" };

function makeCfg(parent: ClusterNode, virtual: ClusterNode): Config {
  return {
    apiVersion: "llamactl/v1",
    kind: "Config",
    currentContext: "default",
    contexts: [{ name: "default", cluster: "home", user: "me" }],
    clusters: [{ name: "home", nodes: [parent, virtual] }],
    users: [user],
  } as unknown as Config;
}

let captured: string[] = [];
let origFetch: typeof globalThis.fetch;

beforeEach(() => {
  captured = [];
  origFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("providerForVirtualNode base-URL normalization + quirks", () => {
  test("virtual node normalizes a no-/v1 parent baseUrl to /v1 like the direct path", async () => {
    // Parent gateway registered WITHOUT a trailing /v1 — the
    // operator-typed `https://api.openai.com`. The direct path appends
    // /v1; the virtual path must too.
    const parent: ClusterNode = {
      name: "openai-gw",
      endpoint: "",
      kind: "gateway",
      cloud: { provider: "openai", baseUrl: "https://api.openai.com" },
    } as unknown as ClusterNode;
    const virtual: ClusterNode = {
      name: "openai-virtual",
      endpoint: "",
      kind: "provider",
      provider: { gateway: "openai-gw", providerName: "openai", source: "sirius" },
    } as unknown as ClusterNode;
    const cfg = makeCfg(parent, virtual);

    // Capture the URL listModels() hits, then short-circuit with an
    // empty 200 so the call resolves quickly.
    globalThis.fetch = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      captured.push(url);
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    }) as unknown as typeof globalThis.fetch;

    // Direct provider over the same parent → expected normalized URL.
    const direct = providerForNode({ node: parent, user, cfg });
    await direct.listModels?.();
    const directUrl = captured.at(-1);

    captured = [];
    const virtualProv = providerForNode({ node: virtual, user, cfg });
    await virtualProv.listModels?.();
    const virtualUrl = captured.at(-1);

    expect(directUrl).toBe("https://api.openai.com/v1/models");
    // The load-bearing assertion: virtual node hits the SAME normalized
    // URL as the direct path (RED before fix: `.../models` with no /v1).
    expect(virtualUrl).toBe(directUrl);
  });

  test("virtual gemini node applies the quirk fallback catalog like the direct path", async () => {
    // Gemini's OpenAI-compat shim lives at /v1beta/openai (NO /v1
    // append) and the quirk wrapper falls back to a hardcoded catalog
    // when upstream /models returns empty. A RAW virtual provider has
    // neither — it returns the empty upstream list.
    const parent: ClusterNode = {
      name: "gemini-gw",
      endpoint: "",
      kind: "gateway",
      cloud: {
        provider: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      },
    } as unknown as ClusterNode;
    const virtual: ClusterNode = {
      name: "gemini-virtual",
      endpoint: "",
      kind: "provider",
      provider: { gateway: "gemini-gw", providerName: "gemini", source: "sirius" },
    } as unknown as ClusterNode;
    const cfg = makeCfg(parent, virtual);

    // Upstream /models returns EMPTY → the quirk fallback should kick in.
    globalThis.fetch = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      captured.push(url);
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    }) as unknown as typeof globalThis.fetch;

    const direct = providerForNode({ node: parent, user, cfg });
    const directModels = (await direct.listModels?.()) ?? [];

    const virtualProv = providerForNode({ node: virtual, user, cfg });
    const virtualModels = (await virtualProv.listModels?.()) ?? [];

    // Direct path falls back to the gemini catalog (non-empty).
    expect(directModels.length).toBeGreaterThan(0);
    expect(directModels.some((m) => m.id === "gemini-2.5-flash")).toBe(true);
    // Virtual path must match — same quirk fallback (RED before fix:
    // empty, because applyProviderQuirks was skipped).
    expect(virtualModels.length).toBe(directModels.length);
    expect(virtualModels.some((m) => m.id === "gemini-2.5-flash")).toBe(true);

    // And the gemini URL is NOT bolted with a bogus /v1 — the shim
    // path stays intact (normalization skip for /openai-terminated URL).
    const lastGeminiUrl = captured.at(-1);
    expect(lastGeminiUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai/models");
  });
});
