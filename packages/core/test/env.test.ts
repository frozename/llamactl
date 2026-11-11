import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureDirs,
  formatEvalScript,
  resolveEnv,
  resolveInternalProxyEndpoint,
} from "../src/env.js";
import { existsSync, mkdtempSync, rmSync } from "../src/safe-fs.js";

describe("env.resolveEnv", () => {
  test("derives sensible defaults from just DEV_STORAGE", () => {
    const resolved = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    });

    expect(resolved.HF_HOME).toBe("/tmp/ds/cache/huggingface");
    expect(resolved.HUGGINGFACE_HUB_CACHE).toBe("/tmp/ds/cache/huggingface/hub");
    expect(resolved.OLLAMA_MODELS).toBe("/tmp/ds/ai-models/ollama");
    expect(resolved.LLAMA_CPP_ROOT).toBe("/tmp/ds/ai-models/llama.cpp");
    expect(resolved.LLAMA_CPP_MODELS).toBe("/tmp/ds/ai-models/llama.cpp/models");
    expect(resolved.LOCAL_AI_RUNTIME_DIR).toBe("/tmp/ds/ai-models/local-ai");
    expect(resolved.LLAMA_CPP_MACHINE_PROFILE).toBe("macbook-pro-48g");
    expect(resolved.LLAMA_CPP_GEMMA_CTX_SIZE).toBe("32768");
    expect(resolved.LLAMA_CPP_QWEN_CTX_SIZE).toBe("65536");
  });

  test("mac-mini profile drops context sizes", () => {
    const resolved = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "mac-mini-16g",
    });
    expect(resolved.LLAMA_CPP_GEMMA_CTX_SIZE).toBe("16384");
    expect(resolved.LLAMA_CPP_QWEN_CTX_SIZE).toBe("16384");
  });

  test("large-128g profile lifts context sizes", () => {
    const resolved = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "large-128g",
    });
    expect(resolved.LLAMA_CPP_MACHINE_PROFILE).toBe("large-128g");
    expect(resolved.LLAMA_CPP_GEMMA_CTX_SIZE).toBe("65536");
    expect(resolved.LLAMA_CPP_QWEN_CTX_SIZE).toBe("131072");
    expect(resolved.LLAMA_CPP_DEFAULT_MODEL).toBe(
      "gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf",
    );
  });

  test("provider=lmstudio rewires provider URL + api key", () => {
    const resolved = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      LOCAL_AI_PROVIDER: "lmstudio",
      LM_API_TOKEN: "secret",
    });
    expect(resolved.LOCAL_AI_PROVIDER).toBe("lmstudio");
    expect(resolved.LOCAL_AI_PROVIDER_URL).toBe("http://127.0.0.1:1234/v1");
    expect(resolved.LOCAL_AI_API_KEY).toBe("secret");
    expect(resolved.OPENAI_BASE_URL).toBe("http://127.0.0.1:1234/v1");
  });

  test("LOCAL_AI_MODEL honours explicit override", () => {
    const resolved = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      LOCAL_AI_MODEL: "custom-id",
    });
    expect(resolved.LOCAL_AI_MODEL).toBe("custom-id");
  });
});

describe("env.resolveInternalProxyEndpoint", () => {
  test("falls back to loopback default when unset", () => {
    expect(resolveInternalProxyEndpoint({})).toBe("http://127.0.0.1:7944");
  });

  test("respects LLAMACTL_INTERNAL_PROXY_URL override", () => {
    expect(
      resolveInternalProxyEndpoint({
        LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9001",
      }),
    ).toBe("http://127.0.0.1:9001");
  });
});

describe("env.resolveEnv — LLAMACTL_TEST_PROFILE", () => {
  test("reroots every ai-model / cache / runtime path under the profile", () => {
    const resolved = resolveEnv({
      LLAMACTL_TEST_PROFILE: "/tmp/hermetic",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    });

    expect(resolved.DEV_STORAGE).toBe("/tmp/hermetic");
    expect(resolved.LOCAL_AI_RUNTIME_DIR).toBe("/tmp/hermetic/ai-models/local-ai");
    expect(resolved.LLAMA_CPP_ROOT).toBe("/tmp/hermetic/ai-models/llama.cpp");
    expect(resolved.LLAMA_CPP_MODELS).toBe("/tmp/hermetic/ai-models/llama.cpp/models");
    expect(resolved.LLAMA_CPP_CACHE).toBe("/tmp/hermetic/ai-models/llama.cpp/.cache");
    expect(resolved.LLAMA_CPP_LOGS).toBe("/tmp/hermetic/logs/llama.cpp");
    expect(resolved.LLAMA_CPP_BIN).toBe("/tmp/hermetic/bin");
    expect(resolved.HF_HOME).toBe("/tmp/hermetic/cache/huggingface");
    expect(resolved.HUGGINGFACE_HUB_CACHE).toBe("/tmp/hermetic/cache/huggingface/hub");
    expect(resolved.OLLAMA_MODELS).toBe("/tmp/hermetic/ai-models/ollama");
  });

  test("pins host to 127.0.0.1 and port to 65534 (sentinel)", () => {
    const resolved = resolveEnv({
      LLAMACTL_TEST_PROFILE: "/tmp/hermetic",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    });

    expect(resolved.LLAMA_CPP_HOST).toBe("127.0.0.1");
    expect(resolved.LLAMA_CPP_PORT).toBe("65534");
    // Derived URLs pick up the sentinel automatically.
    expect(resolved.LOCAL_AI_LLAMA_CPP_BASE_URL).toBe("http://127.0.0.1:65534/v1");
    expect(resolved.LOCAL_AI_PROVIDER_URL).toBe("http://127.0.0.1:65534/v1");
    expect(resolved.OPENAI_BASE_URL).toBe("http://127.0.0.1:65534/v1");
  });

  test("individual env var wins over test-profile default", () => {
    const resolved = resolveEnv({
      LLAMACTL_TEST_PROFILE: "/tmp/hermetic",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      LLAMA_CPP_BIN: "/my/real/bin",
      LLAMA_CPP_PORT: "8081",
    });

    expect(resolved.LLAMA_CPP_BIN).toBe("/my/real/bin");
    expect(resolved.LLAMA_CPP_PORT).toBe("8081");
    // Other paths still under the test profile.
    expect(resolved.LLAMA_CPP_ROOT).toBe("/tmp/hermetic/ai-models/llama.cpp");
    expect(resolved.HF_HOME).toBe("/tmp/hermetic/cache/huggingface");
    expect(resolved.LLAMA_CPP_HOST).toBe("127.0.0.1");
  });

  test("empty LLAMACTL_TEST_PROFILE behaves as unset", () => {
    const resolved = resolveEnv({
      LLAMACTL_TEST_PROFILE: "",
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    });

    // Production cascade still drives derivation — $DEV_STORAGE wins.
    expect(resolved.DEV_STORAGE).toBe("/tmp/ds");
    expect(resolved.LLAMA_CPP_ROOT).toBe("/tmp/ds/ai-models/llama.cpp");
    expect(resolved.LLAMA_CPP_PORT).toBe("8080");
    expect(resolved.LLAMA_CPP_BIN).toBe("/tmp/ds/src/llama.cpp/build/bin");
  });

  test("without LLAMACTL_TEST_PROFILE, behaviour is unchanged", () => {
    // Baseline snapshot: production defaults keyed off $DEV_STORAGE.
    const resolved = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    });

    expect(resolved.DEV_STORAGE).toBe("/tmp/ds");
    expect(resolved.LLAMA_CPP_ROOT).toBe("/tmp/ds/ai-models/llama.cpp");
    expect(resolved.LLAMA_CPP_BIN).toBe("/tmp/ds/src/llama.cpp/build/bin");
    expect(resolved.LLAMA_CPP_PORT).toBe("8080");
    expect(resolved.LLAMA_CPP_HOST).toBe("127.0.0.1");
    expect(resolved.HF_HOME).toBe("/tmp/ds/cache/huggingface");
    expect(resolved.OLLAMA_MODELS).toBe("/tmp/ds/ai-models/ollama");
  });

  test("does not mutate the caller env map", () => {
    const caller: NodeJS.ProcessEnv = {
      LLAMACTL_TEST_PROFILE: "/tmp/hermetic",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    };
    const snapshot = { ...caller };
    resolveEnv(caller);
    expect(caller).toEqual(snapshot);
  });
});

describe("env.formatEvalScript", () => {
  test("emits export lines + mkdir + PATH tweak", () => {
    const resolved = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    });
    const script = formatEvalScript(resolved);

    expect(script).toContain("export DEV_STORAGE=/tmp/ds");
    expect(script).toContain("export LLAMA_CPP_MACHINE_PROFILE=macbook-pro-48g");
    expect(script).toContain("export OPENAI_BASE_URL=");
    expect(script).toMatch(/mkdir -p .* 2>\/dev\/null \|\| true/);
    // PATH tweak only fires when the bin dir exists; in a hermetic test
    // env the bin won't exist so the `if [ -d ... ]` guard is in place.
    expect(script).toContain("if [ -d");
  });

  test("escapes values with shell metacharacters", () => {
    const resolved = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      LLAMA_CPP_SERVER_ALIAS: "name with 'quotes'",
    });
    const script = formatEvalScript(resolved);
    expect(script).toContain(`export LLAMA_CPP_SERVER_ALIAS='name with '\\''quotes'\\'''`);
  });

  test("quotes LLAMA_CPP_BIN inside the PATH guard case pattern", () => {
    const resolved = resolveEnv({
      DEV_STORAGE: "/tmp/ds",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      LLAMA_CPP_BIN: "/tmp/bin with spaces/[]",
    });
    const script = formatEvalScript(resolved);
    expect(script).toContain("case \":$PATH:\" in *:'/tmp/bin with spaces/[]':*)");
  });
});

describe("env.resolveEnv — process.env seed shape", () => {
  /**
   * Host entrypoints seed `process.env` from `resolveEnv()` like:
   *
   *   const resolved = resolveEnv();
   *   for (const [k, v] of Object.entries(resolved))
   *     if (v !== undefined) process.env[k] = String(v);
   *
   * These assertions guard that seed loop: every resolver field must
   * be string-valued and non-undefined so `process.env.FOO` never
   * ends up as the literal string "undefined" (which then trips up
   * downstream `if (env.FOO)` checks). Also confirms the individual
   * override still wins so shell-set vars aren't clobbered.
   */
  test("every resolved field is a non-empty string (safe for process.env assign)", () => {
    const resolved = resolveEnv({
      LLAMACTL_TEST_PROFILE: "/tmp/profile-for-seed",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    });
    for (const [key, value] of Object.entries(resolved) as [string, string][]) {
      expect(typeof value).toBe("string");
      // LOCAL_AI_BENCH_IMAGE is intentionally empty-string when unset;
      // other fields must not be undefined/null. The seed loop's
      // `!== undefined` guard is exactly what keeps "undefined" out.
      if (key !== "LOCAL_AI_BENCH_IMAGE" && key !== "LLAMA_CPP_ADVERTISED_HOST") {
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });

  test("Object.assign-with-undefined-filter preserves existing overrides", () => {
    // Simulate the process.env seed loop on a scratch copy.
    const procEnv: NodeJS.ProcessEnv = {
      LLAMACTL_TEST_PROFILE: "/tmp/hermetic-seed",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      // Operator pre-set DEV_STORAGE — resolver must propagate that
      // through, not overwrite it with the test-profile default.
      DEV_STORAGE: "/my/custom/storage",
    };
    const resolved = resolveEnv(procEnv);
    expect(resolved.DEV_STORAGE).toBe("/my/custom/storage");

    for (const [key, value] of Object.entries(resolved)) {
      if (value === undefined) continue;
      procEnv[key] = String(value);
    }
    expect(procEnv["DEV_STORAGE"]).toBe("/my/custom/storage");
    // LLAMA_CPP_ROOT fell through to the profile default since it
    // wasn't individually set — that's the whole point of the cascade.
    expect(procEnv["LLAMA_CPP_ROOT"]).toBe("/tmp/hermetic-seed/ai-models/llama.cpp");
  });

  test('no field stringifies to literal "undefined"', () => {
    // Regression for anti-pattern: `Object.assign(process.env, resolveEnv())`
    // without a filter would coerce `undefined` values to the string
    // "undefined". We never want that — assert up-front that every
    // value is already string-typed so the seed loop is safe.
    const resolved = resolveEnv({
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    });
    for (const value of Object.values(resolved)) {
      expect(value).not.toBe(undefined);
      expect(value).not.toBe("undefined");
    }
  });
});

describe("env.ensureDirs — subsystem directories", () => {
  /**
   * Each subsystem (healer, ops-chat, workloads, mcp/pipelines,
   * mcp/audit, tunnel) writes to `$DEV_STORAGE/<name>` at use-site.
   * `ensureDirs` precreates them so test fixtures that pre-seed files
   * don't trip on a missing parent directory.
   */
  test("creates every subsystem dir under $LLAMACTL_TEST_PROFILE", () => {
    const profile = mkdtempSync(join(tmpdir(), "llamactl-ensuredirs-"));
    try {
      const env = {
        LLAMACTL_TEST_PROFILE: profile,
        LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      } as NodeJS.ProcessEnv;
      const resolved = resolveEnv(env);
      ensureDirs(resolved, env);

      expect(existsSync(join(profile, "healer"))).toBe(true);
      expect(existsSync(join(profile, "ops-chat"))).toBe(true);
      expect(existsSync(join(profile, "workloads"))).toBe(true);
      expect(existsSync(join(profile, "mcp", "pipelines"))).toBe(true);
      expect(existsSync(join(profile, "mcp", "audit"))).toBe(true);
      expect(existsSync(join(profile, "tunnel"))).toBe(true);
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test("still creates MANAGED_DIRS entries (regression guard)", () => {
    const profile = mkdtempSync(join(tmpdir(), "llamactl-ensuredirs-managed-"));
    try {
      const env = {
        LLAMACTL_TEST_PROFILE: profile,
        LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      } as NodeJS.ProcessEnv;
      const resolved = resolveEnv(env);
      ensureDirs(resolved, env);

      // Pre-existing managed dirs must keep being created.
      expect(existsSync(resolved.HF_HOME)).toBe(true);
      expect(existsSync(resolved.LLAMA_CPP_MODELS)).toBe(true);
      expect(existsSync(resolved.LLAMA_CPP_LOGS)).toBe(true);
      expect(existsSync(resolved.LOCAL_AI_RUNTIME_DIR)).toBe(true);
      // Under test profile, bin also gets precreated.
      expect(existsSync(resolved.LLAMA_CPP_BIN)).toBe(true);
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });

  test("creates subsystem dirs in production mode (no test profile)", () => {
    const devStorage = mkdtempSync(join(tmpdir(), "llamactl-ensuredirs-prod-"));
    try {
      const env = {
        DEV_STORAGE: devStorage,
        LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      } as NodeJS.ProcessEnv;
      const resolved = resolveEnv(env);
      ensureDirs(resolved, env);

      // Subsystem dirs derive from DEV_STORAGE regardless of test profile.
      expect(existsSync(join(devStorage, "healer"))).toBe(true);
      expect(existsSync(join(devStorage, "ops-chat"))).toBe(true);
      expect(existsSync(join(devStorage, "workloads"))).toBe(true);
      expect(existsSync(join(devStorage, "mcp", "pipelines"))).toBe(true);
      expect(existsSync(join(devStorage, "mcp", "audit"))).toBe(true);
      expect(existsSync(join(devStorage, "tunnel"))).toBe(true);
    } finally {
      rmSync(devStorage, { recursive: true, force: true });
    }
  });
});

describe("env.resolveEnv — LOCAL_AI_PROVIDER_URL routes through the internal proxy (#315)", () => {
  const B = { DEV_STORAGE: "/tmp/ds", LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g" };
  const PX = "http://127.0.0.1:7944/v1";
  const seed = (
    input: NodeJS.ProcessEnv,
    out: ReturnType<typeof resolveEnv>,
  ): NodeJS.ProcessEnv => ({
    ...input,
    ...Object.fromEntries(
      (Object.entries(out) as [string, unknown][]).map(([key, value]): [string, string] => [
        key,
        String(value),
      ]),
    ),
  });

  // kills: providerUrl = llamaCppBaseUrl (base behaviour); applying the proxy to the lmstudio branch.
  test("default provider URL is the internal proxy; tracked-server URL unchanged", () => {
    const r = resolveEnv(B);
    expect(r.LOCAL_AI_PROVIDER_URL).toBe(PX);
    expect(r.OPENAI_BASE_URL).toBe(PX);
    expect(r.LOCAL_AI_LLAMA_CPP_BASE_URL).toBe("http://127.0.0.1:8080/v1"); // post-fix guard
    expect(r.LOCAL_AI_API_KEY).toBe("local"); // post-fix guard
    expect(
      resolveEnv({
        ...B,
        LOCAL_AI_PROVIDER: "lmstudio",
        LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9001",
      }).LOCAL_AI_PROVIDER_URL,
    ).toBe("http://127.0.0.1:1234/v1"); // post-fix guard
  });

  // kills: deriving the provider default from host/port; dropping LLAMA_CPP_PORT from the tracked URL.
  test("LLAMA_CPP_PORT moves the tracked server URL, not the provider URL", () => {
    const r = resolveEnv({ ...B, LLAMA_CPP_PORT: "9090" });
    expect(r.LOCAL_AI_PROVIDER_URL).toBe(PX);
    expect(r.LOCAL_AI_LLAMA_CPP_BASE_URL).toBe("http://127.0.0.1:9090/v1"); // post-fix guard
    expect(r.LLAMA_CPP_PORT).toBe("9090"); // post-fix guard
  });

  // kills: hardcoded 7944 that ignores the override; no trailing-slash strip; unconditional /v1 append; the proxy outranking an explicit tracked URL.
  test("LLAMACTL_INTERNAL_PROXY_URL steers the default and is normalised to /v1", () => {
    expect(
      resolveEnv({ ...B, LLAMACTL_INTERNAL_PROXY_URL: "http://10.0.0.5:9001/" })
        .LOCAL_AI_PROVIDER_URL,
    ).toBe("http://10.0.0.5:9001/v1");
    expect(
      resolveEnv({ ...B, LLAMACTL_INTERNAL_PROXY_URL: "http://10.0.0.5:9001/v1" })
        .LOCAL_AI_PROVIDER_URL,
    ).toBe("http://10.0.0.5:9001/v1");
    expect(
      resolveEnv({ ...B, LLAMACTL_INTERNAL_PROXY_URL: "http://10.0.0.5:9001" })
        .LOCAL_AI_PROVIDER_URL,
    ).toBe("http://10.0.0.5:9001/v1");
    expect(
      resolveEnv({
        ...B,
        LLAMACTL_INTERNAL_PROXY_URL: "http://10.0.0.5:9001",
        LOCAL_AI_LLAMA_CPP_BASE_URL: "http://10.0.0.99:9999/v1",
      }).LOCAL_AI_PROVIDER_URL,
    ).toBe("http://10.0.0.99:9999/v1"); // post-fix guard
  });

  // kills: never reading env LOCAL_AI_PROVIDER_URL; ranking it below the tracked URL, the route or the proxy.
  test("explicit non-derived LOCAL_AI_PROVIDER_URL wins for llama.cpp", () => {
    const input = {
      ...B,
      LOCAL_AI_PROVIDER_URL: "http://10.0.0.7:5555/v1",
      LOCAL_AI_LLAMA_CPP_BASE_URL: "http://10.0.0.99:9999/v1",
      LLAMACTL_INTERNAL_PROXY_URL: "http://10.0.0.5:9001",
      LOCAL_AI_PROVIDER_ROUTE: "direct",
    };
    const r = resolveEnv(input);
    expect(r.LOCAL_AI_PROVIDER_URL).toBe("http://10.0.0.7:5555/v1");
    expect(r.OPENAI_BASE_URL).toBe("http://10.0.0.7:5555/v1");
    expect(r.LOCAL_AI_LLAMA_CPP_BASE_URL).toBe("http://10.0.0.99:9999/v1"); // post-fix guard
    expect(resolveEnv(seed(input, r)).LOCAL_AI_PROVIDER_URL).toBe("http://10.0.0.7:5555/v1");
  });

  // kills: using `??` (gives "/v1" or ""), or treating an empty route as direct.
  test("empty strings are unset", () => {
    expect(
      resolveEnv({
        ...B,
        LOCAL_AI_PROVIDER_URL: "",
        LLAMACTL_INTERNAL_PROXY_URL: "",
        LOCAL_AI_LLAMA_CPP_BASE_URL: "",
        LOCAL_AI_PROVIDER_ROUTE: "",
      }).LOCAL_AI_PROVIDER_URL,
    ).toBe(PX);
  });

  // kills: trusting a seeded LOCAL_AI_LLAMA_CPP_BASE_URL that equals the host:port derivation.
  test("re-resolving a seeded env is a fixed point", () => {
    const first = resolveEnv(B);
    const second = resolveEnv(seed(B, first));
    expect(second.LOCAL_AI_PROVIDER_URL).toBe(PX);
    expect(second.LOCAL_AI_LLAMA_CPP_BASE_URL).toBe("http://127.0.0.1:8080/v1"); // post-fix guard
  });

  // kills: treating the seeded lmstudio URL (1234) as an explicit LOCAL_AI_PROVIDER_URL.
  test("provider switch lmstudio -> llama.cpp after a seed returns to the proxy", () => {
    const s = seed(
      { ...B, LOCAL_AI_PROVIDER: "lmstudio" },
      resolveEnv({ ...B, LOCAL_AI_PROVIDER: "lmstudio" }),
    );
    const r = resolveEnv({ ...s, LOCAL_AI_PROVIDER: "llama.cpp" });
    expect(r.LOCAL_AI_PROVIDER_URL).toBe(PX);
    expect(r.LOCAL_AI_PROVIDER_URL).not.toBe("http://127.0.0.1:1234/v1"); // post-fix guard
  });

  // kills: treating the seeded default-proxy URL 7944/v1 as explicit.
  test("changing LLAMACTL_INTERNAL_PROXY_URL after a seed is honoured", () => {
    const s = seed(B, resolveEnv(B));
    const r = resolveEnv({ ...s, LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9001" });
    expect(r.LOCAL_AI_PROVIDER_URL).toBe("http://127.0.0.1:9001/v1");
  });

  // kills: trusting the literal legacy default 127.0.0.1:8080/v1 when the current port differs.
  test("issue #315 inherited stale :8080 values are corrected", () => {
    expect(
      resolveEnv({
        ...B,
        LOCAL_AI_LLAMA_CPP_BASE_URL: "http://127.0.0.1:8080/v1",
        LOCAL_AI_PROVIDER_URL: "http://127.0.0.1:8080/v1",
        OPENAI_BASE_URL: "http://127.0.0.1:8080/v1",
        LLAMA_CPP_PORT: "9090",
      }).LOCAL_AI_PROVIDER_URL,
    ).toBe(PX);
    expect(
      resolveEnv({
        ...B,
        LOCAL_AI_LLAMA_CPP_BASE_URL: "http://127.0.0.1:8080/v1",
        LOCAL_AI_PROVIDER_URL: "http://127.0.0.1:8080/v1",
        OPENAI_BASE_URL: "http://127.0.0.1:8080/v1",
      }).LOCAL_AI_PROVIDER_URL,
    ).toBe(PX);
  });

  // kills: ignoring the opt-out; checking the proxy before the route.
  test("LOCAL_AI_PROVIDER_ROUTE=direct is the legacy single-server opt-out", () => {
    expect(resolveEnv({ ...B, LLAMA_CPP_PORT: "9090" }).LOCAL_AI_PROVIDER_URL).toBe(PX);
    expect(
      resolveEnv({
        ...B,
        LLAMA_CPP_PORT: "9090",
        LOCAL_AI_PROVIDER_ROUTE: "direct",
        LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9001",
      }).LOCAL_AI_PROVIDER_URL,
    ).toBe("http://127.0.0.1:9090/v1"); // post-fix guard
    expect(
      resolveEnv({
        ...B,
        LLAMA_CPP_PORT: "9090",
        LOCAL_AI_PROVIDER_ROUTE: "direct",
        LOCAL_AI_PROVIDER_URL: PX,
      }).LOCAL_AI_PROVIDER_URL,
    ).toBe("http://127.0.0.1:9090/v1"); // post-fix guard
  });

  // kills: a test-profile short-circuit that ignores a configured proxy; defaulting hermetic runs to 7944.
  test("test profile keeps the sentinel unless a proxy is configured", () => {
    const r = resolveEnv({
      LLAMACTL_TEST_PROFILE: "/tmp/hermetic",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9001",
    });
    expect(r.LOCAL_AI_PROVIDER_URL).toBe("http://127.0.0.1:9001/v1");
    expect(r.LOCAL_AI_LLAMA_CPP_BASE_URL).toBe("http://127.0.0.1:65534/v1"); // post-fix guard
    const tp = {
      LLAMACTL_TEST_PROFILE: "/tmp/hermetic",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    };
    expect(resolveEnv(seed(tp, resolveEnv(tp))).LOCAL_AI_PROVIDER_URL).toBe(
      "http://127.0.0.1:65534/v1",
    ); // post-fix guard
  });

  // kills: dropping the seeded non-default proxy URL (proxyUrl) from the derived set, which pins the re-fed 9001/v1 as explicit.
  // The "pre-#638" variant strips the marker, so only the derived set can recognise the seeded URL.
  describe.each([
    ["with the #638 marker", (s: NodeJS.ProcessEnv): NodeJS.ProcessEnv => s],
    [
      "pre-#638, without the marker",
      ({ LOCAL_AI_PROVIDER_URL_DERIVED: _marker, ...rest }: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
        rest,
    ],
  ])("a seeded non-default proxy URL counts as derived (%s)", (_label, strip) => {
    const P9001 = "http://127.0.0.1:9001/v1";
    const input = { ...B, LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9001" };
    const seeded = (): NodeJS.ProcessEnv => {
      const first = resolveEnv(input);
      expect(first.LOCAL_AI_PROVIDER_URL).toBe(P9001); // post-fix guard
      const s = strip(seed(input, first));
      expect(s["LOCAL_AI_PROVIDER_URL"]).toBe(P9001); // post-fix guard
      return s;
    };

    test("re-fed with LOCAL_AI_PROVIDER_ROUTE=direct, the direct route wins", () => {
      const r = resolveEnv({ ...seeded(), LOCAL_AI_PROVIDER_ROUTE: "direct" });
      expect(r.LOCAL_AI_PROVIDER_URL).toBe("http://127.0.0.1:8080/v1");
      expect(r.OPENAI_BASE_URL).toBe("http://127.0.0.1:8080/v1");
    });

    test("re-fed with a custom LOCAL_AI_LLAMA_CPP_BASE_URL, the tracked URL wins", () => {
      const r = resolveEnv({
        ...seeded(),
        LOCAL_AI_LLAMA_CPP_BASE_URL: "http://10.0.0.99:9999/v1",
      });
      expect(r.LOCAL_AI_PROVIDER_URL).toBe("http://10.0.0.99:9999/v1");
      expect(r.OPENAI_BASE_URL).toBe("http://10.0.0.99:9999/v1");
    });
  });

  // kills: ignoring LOCAL_AI_PROVIDER_URL_DERIVED on re-feed (the stale 9001/v1 sticks); never emitting the marker.
  test("#638 changing a non-default proxy URL after a seed re-derives the provider URL", () => {
    const input = { ...B, LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9001" };
    const first = resolveEnv(input);
    expect(first.LOCAL_AI_PROVIDER_URL_DERIVED).toBe("http://127.0.0.1:9001/v1");
    expect(formatEvalScript(first)).toContain(
      "export LOCAL_AI_PROVIDER_URL_DERIVED=http://127.0.0.1:9001/v1\n",
    );
    const s = seed(input, first);
    const r = resolveEnv({ ...s, LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9002" });
    expect(r.LOCAL_AI_PROVIDER_URL).toBe("http://127.0.0.1:9002/v1");
    expect(r.OPENAI_BASE_URL).toBe("http://127.0.0.1:9002/v1");
    expect(r.LOCAL_AI_PROVIDER_URL_DERIVED).toBe("http://127.0.0.1:9002/v1");
    const unset = { ...s };
    delete unset["LLAMACTL_INTERNAL_PROXY_URL"];
    expect(resolveEnv(unset).LOCAL_AI_PROVIDER_URL).toBe(PX);
  });

  // kills: emitting the marker for an explicit URL (it would then be re-derived away); trusting a stale marker over a new export.
  test("#638 an explicit LOCAL_AI_PROVIDER_URL survives a proxy change on re-feed", () => {
    const input = {
      ...B,
      LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9001",
      LOCAL_AI_PROVIDER_URL: "http://127.0.0.1:5555/v1",
    };
    const first = resolveEnv(input);
    expect(first.LOCAL_AI_PROVIDER_URL).toBe("http://127.0.0.1:5555/v1");
    expect(first.LOCAL_AI_PROVIDER_URL_DERIVED).toBe("");
    const r = resolveEnv({
      ...seed(input, first),
      LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9002",
    });
    expect(r.LOCAL_AI_PROVIDER_URL).toBe("http://127.0.0.1:5555/v1");
    expect(r.OPENAI_BASE_URL).toBe("http://127.0.0.1:5555/v1");
    // An operator export made after a derived seed differs from the marker, so it is explicit.
    const derivedSeed = seed(
      { ...B, LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9001" },
      resolveEnv({ ...B, LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9001" }),
    );
    expect(
      resolveEnv({
        ...derivedSeed,
        LOCAL_AI_PROVIDER_URL: "http://127.0.0.1:5555/v1",
        LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9002",
      }).LOCAL_AI_PROVIDER_URL,
    ).toBe("http://127.0.0.1:5555/v1");
  });

  // A shell seeded on main with LOCAL_AI_LLAMA_CPP_BASE_URL=A carries LOCAL_AI_PROVIDER_URL=A and no marker.
  const A = "http://10.0.0.99:9999/v1";
  const mainSeeded = {
    ...B,
    LOCAL_AI_LLAMA_CPP_BASE_URL: A,
    LOCAL_AI_PROVIDER_URL: A,
    OPENAI_BASE_URL: A,
  };

  // kills: dropping basics.llamaCppBaseUrl from the derived set (the marker comes back "" and A is pinned as explicit).
  test.each([
    ["no overrides", {}],
    ["LOCAL_AI_PROVIDER_ROUTE=direct", { LOCAL_AI_PROVIDER_ROUTE: "direct" }],
    ["a non-default proxy", { LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9001" }],
    ["a test profile", { LLAMACTL_TEST_PROFILE: "/tmp/hermetic" }],
  ])(
    "#638 a main-seeded tracked URL resolves to the same URL and is marked derived (%s)",
    (_label, extra) => {
      const r = resolveEnv({ ...mainSeeded, ...extra });
      expect(r.LOCAL_AI_PROVIDER_URL).toBe(A); // post-fix guard: output unchanged by the fix
      expect(r.OPENAI_BASE_URL).toBe(A); // post-fix guard
      expect(r.LOCAL_AI_PROVIDER_URL_DERIVED).toBe(A);
    },
  );

  // kills: dropping basics.llamaCppBaseUrl from the derived set (A stays pinned after the tracked URL moves to B).
  test("#638 a main-seeded tracked URL A re-derives to B when the tracked URL changes", () => {
    const Bu = "http://10.0.0.98:9998/v1";
    const first = resolveEnv(mainSeeded);
    expect(first.LOCAL_AI_PROVIDER_URL).toBe(A); // post-fix guard
    const r = resolveEnv({ ...seed(mainSeeded, first), LOCAL_AI_LLAMA_CPP_BASE_URL: Bu });
    expect(r.LOCAL_AI_PROVIDER_URL).toBe(Bu);
    expect(r.OPENAI_BASE_URL).toBe(Bu);
    expect(r.LOCAL_AI_PROVIDER_URL_DERIVED).toBe(Bu);
  });

  // kills: dropping the provider === "lmstudio" arm of the marker (an explicit llama.cpp URL would blank it and pin the LM Studio URL).
  test("#638 the lmstudio marker is the LM Studio URL and re-derives after switching to llama.cpp", () => {
    const LM = "http://10.0.0.7:4321/v1";
    const input = {
      ...B,
      LOCAL_AI_PROVIDER: "lmstudio",
      LOCAL_AI_LMSTUDIO_BASE_URL: LM,
      LOCAL_AI_PROVIDER_URL: "http://127.0.0.1:5555/v1",
    };
    const first = resolveEnv(input);
    expect(first.LOCAL_AI_PROVIDER_URL).toBe(LM); // post-fix guard
    expect(first.LOCAL_AI_PROVIDER_URL_DERIVED).toBe(LM);
    const s = seed(input, first);
    delete s["LOCAL_AI_LMSTUDIO_BASE_URL"];
    const r = resolveEnv({ ...s, LOCAL_AI_PROVIDER: "llama.cpp" });
    expect(r.LOCAL_AI_PROVIDER_URL).toBe(PX);
    expect(r.OPENAI_BASE_URL).toBe(PX);
  });

  // A main-era seed: main's eval carried LOCAL_AI_PROVIDER and OPENAI_BASE_URL equal to
  // LOCAL_AI_PROVIDER_URL, and no LOCAL_AI_PROVIDER_URL_DERIVED key. Stripping the marker from a
  // seed whose provider URL main would also have emitted reproduces that shape exactly. The
  // "LOCAL_AI_PROVIDER since unset" variant falls outside the main-seed shape, so only the
  // derived set can recognise the stale URL there.
  const stripMarker = ({
    LOCAL_AI_PROVIDER_URL_DERIVED: _marker,
    ...rest
  }: NodeJS.ProcessEnv): NodeJS.ProcessEnv => rest;
  const mainSeed = (input: NodeJS.ProcessEnv, mainUrl: string): NodeJS.ProcessEnv => {
    const s = stripMarker(seed(input, resolveEnv(input)));
    expect(s["LOCAL_AI_PROVIDER_URL"]).toBe(mainUrl); // post-fix guard: main emitted this URL
    expect(s["OPENAI_BASE_URL"]).toBe(mainUrl); // post-fix guard
    expect("LOCAL_AI_PROVIDER_URL_DERIVED" in s).toBe(false); // post-fix guard
    return s;
  };

  describe.each([
    ["main seed", (s: NodeJS.ProcessEnv): NodeJS.ProcessEnv => s],
    [
      "main seed, LOCAL_AI_PROVIDER since unset",
      ({ LOCAL_AI_PROVIDER: _p, ...rest }: NodeJS.ProcessEnv): NodeJS.ProcessEnv => rest,
    ],
  ])("#638 unmarked main-era seeds re-derive (%s)", (_label, vary) => {
    // kills: dropping basics.lmStudioBaseUrl from the derived set (the seeded 1234/v1 is pinned).
    test("lmstudio seeded on main, then llama.cpp, returns to the proxy", () => {
      const lm = { ...B, LOCAL_AI_PROVIDER: "lmstudio" };
      const s = vary(mainSeed(lm, "http://127.0.0.1:1234/v1"));
      const r = resolveEnv({ ...s, LOCAL_AI_PROVIDER: "llama.cpp" });
      expect(r.LOCAL_AI_PROVIDER_URL).toBe(PX);
      expect(r.OPENAI_BASE_URL).toBe(PX);
      const unset = { ...s };
      delete unset["LOCAL_AI_PROVIDER"];
      expect(resolveEnv(unset).LOCAL_AI_PROVIDER_URL).toBe(PX);
    });

    // kills: dropping trackedDerived from the derived set (the seeded 9090/v1 is pinned).
    test("a LLAMA_CPP_PORT=9090 main seed follows a new tracked URL", () => {
      const C = "http://10.0.0.97:9997/v1";
      const p = { ...B, LLAMA_CPP_PORT: "9090", LOCAL_AI_PROVIDER_ROUTE: "direct" };
      const s = vary(mainSeed(p, "http://127.0.0.1:9090/v1"));
      delete s["LOCAL_AI_PROVIDER_ROUTE"];
      const r = resolveEnv({ ...s, LOCAL_AI_LLAMA_CPP_BASE_URL: C });
      expect(r.LOCAL_AI_PROVIDER_URL).toBe(C);
      expect(r.OPENAI_BASE_URL).toBe(C);
      expect(r.LOCAL_AI_PROVIDER_URL_DERIVED).toBe(C);
    });
  });

  // kills: dropping the main-era-seed rule (X is treated as explicit and pinned with an empty marker).
  test("#638 a main seed with tracked X follows an exported tracked Y, and an unset", () => {
    const X = "http://10.0.0.99:9999/v1";
    const Y = "http://10.0.0.98:9998/v1";
    const s = mainSeed({ ...B, LOCAL_AI_LLAMA_CPP_BASE_URL: X }, X);
    const r = resolveEnv({ ...s, LOCAL_AI_LLAMA_CPP_BASE_URL: Y });
    expect(r.LOCAL_AI_PROVIDER_URL).toBe(Y);
    expect(r.OPENAI_BASE_URL).toBe(Y);
    expect(r.LOCAL_AI_PROVIDER_URL_DERIVED).toBe(Y);
    const unset = { ...s };
    delete unset["LOCAL_AI_LLAMA_CPP_BASE_URL"];
    const u = resolveEnv(unset);
    expect(u.LOCAL_AI_PROVIDER_URL).toBe(PX);
    expect(u.LOCAL_AI_PROVIDER_URL_DERIVED).toBe(PX);
  });

  // kills: treating an empty marker as absent; skipping the OPENAI_BASE_URL equality check;
  // skipping the LOCAL_AI_PROVIDER presence check.
  test("#638 explicit exports still win over and without a main-era seed", () => {
    const X = "http://10.0.0.99:9999/v1";
    const Y = "http://10.0.0.98:9998/v1";
    const E = "http://10.0.0.7:5555/v1";
    const s = mainSeed({ ...B, LOCAL_AI_LLAMA_CPP_BASE_URL: X }, X);
    // An export over a main seed leaves OPENAI_BASE_URL at main's X, so it is explicit.
    expect(
      resolveEnv({ ...s, LOCAL_AI_PROVIDER_URL: E, LOCAL_AI_LLAMA_CPP_BASE_URL: Y })
        .LOCAL_AI_PROVIDER_URL,
    ).toBe(E);
    // An explicit URL seeded after #638 carries an empty marker and equal OPENAI_BASE_URL.
    const explicitInput = { ...B, LOCAL_AI_PROVIDER: "llama.cpp", LOCAL_AI_PROVIDER_URL: E };
    const e = seed(explicitInput, resolveEnv(explicitInput));
    expect(e["LOCAL_AI_PROVIDER_URL_DERIVED"]).toBe(""); // post-fix guard
    expect(e["OPENAI_BASE_URL"]).toBe(E); // post-fix guard
    expect(resolveEnv({ ...e, LOCAL_AI_LLAMA_CPP_BASE_URL: Y }).LOCAL_AI_PROVIDER_URL).toBe(E);
    // No seed: LOCAL_AI_PROVIDER_URL and OPENAI_BASE_URL both exported without LOCAL_AI_PROVIDER.
    expect(
      resolveEnv({ ...B, LOCAL_AI_PROVIDER_URL: E, OPENAI_BASE_URL: E }).LOCAL_AI_PROVIDER_URL,
    ).toBe(E);
  });
});
