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
  const TRACKED = "http://127.0.0.1:8080/v1";
  const LMS = "http://127.0.0.1:1234/v1";
  // What a shell does with `eval "$(llamactl env --eval)"`: resolver output fed back as input.
  const seed = (input: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    ...input,
    ...Object.fromEntries(
      (Object.entries(resolveEnv(input)) as [string, unknown][]).map(
        ([key, value]): [string, string] => [key, String(value)],
      ),
    ),
  });

  // kills: providerUrl = llamaCppBaseUrl (main's default); applying the proxy to the lmstudio branch.
  test("default provider URL is the internal proxy; tracked-server URL unchanged", () => {
    const r = resolveEnv(B);
    expect(r.LOCAL_AI_PROVIDER_URL).toBe(PX);
    expect(r.OPENAI_BASE_URL).toBe(PX);
    expect(r.LOCAL_AI_LLAMA_CPP_BASE_URL).toBe(TRACKED);
    expect(r.LOCAL_AI_API_KEY).toBe("local");
    expect(
      resolveEnv({
        ...B,
        LOCAL_AI_PROVIDER: "lmstudio",
        LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9001",
      }).LOCAL_AI_PROVIDER_URL,
    ).toBe(LMS);
  });

  // kills: deriving the provider default from host/port.
  test("LLAMA_CPP_PORT moves the tracked server URL, not the provider URL", () => {
    const r = resolveEnv({ ...B, LLAMA_CPP_PORT: "9090" });
    expect(r.LOCAL_AI_PROVIDER_URL).toBe(PX);
    expect(r.LOCAL_AI_LLAMA_CPP_BASE_URL).toBe("http://127.0.0.1:9090/v1");
    expect(r.LLAMA_CPP_PORT).toBe("9090");
  });

  // kills: the proxy outranking a configured tracked URL; treating the host:port default as configured.
  test("an explicit tracked URL that differs from host:port wins over the proxy, as on main", () => {
    const custom = "http://10.0.0.99:9999/v1";
    for (const extra of [{}, { LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9001" }]) {
      const r = resolveEnv({ ...B, ...extra, LOCAL_AI_LLAMA_CPP_BASE_URL: custom });
      expect(r.LOCAL_AI_PROVIDER_URL).toBe(custom);
      expect(r.OPENAI_BASE_URL).toBe(custom);
    }
    expect(resolveEnv({ ...B, LOCAL_AI_LLAMA_CPP_BASE_URL: TRACKED }).LOCAL_AI_PROVIDER_URL).toBe(
      PX,
    );
    expect(
      resolveEnv({
        ...B,
        LLAMA_CPP_PORT: "9090",
        LOCAL_AI_LLAMA_CPP_BASE_URL: "http://127.0.0.1:9090/v1",
      }).LOCAL_AI_PROVIDER_URL,
    ).toBe(PX);
    // Unsetting the custom tracked URL after a seed re-derives to the proxy.
    const s = seed({ ...B, LOCAL_AI_LLAMA_CPP_BASE_URL: custom });
    delete s["LOCAL_AI_LLAMA_CPP_BASE_URL"];
    expect(resolveEnv(s).LOCAL_AI_PROVIDER_URL).toBe(PX);
  });

  // kills: a hardcoded 7944 that ignores the override; no trailing-slash strip; unconditional /v1 append.
  test("LLAMACTL_INTERNAL_PROXY_URL is honoured and normalised to /v1", () => {
    for (const raw of [
      "http://10.0.0.5:9001/",
      "http://10.0.0.5:9001/v1",
      "http://10.0.0.5:9001",
    ]) {
      const r = resolveEnv({ ...B, LLAMACTL_INTERNAL_PROXY_URL: raw });
      expect(r.LOCAL_AI_PROVIDER_URL).toBe("http://10.0.0.5:9001/v1");
      expect(r.OPENAI_BASE_URL).toBe("http://10.0.0.5:9001/v1");
    }
  });

  // kills: reading a re-fed LOCAL_AI_PROVIDER_URL, which pins the old proxy after a change or unset.
  test("changing or unsetting the proxy after a seed re-derives", () => {
    const s = seed({ ...B, LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9001" });
    expect(s["LOCAL_AI_PROVIDER_URL"]).toBe("http://127.0.0.1:9001/v1");
    expect(
      resolveEnv({ ...s, LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9002" })
        .LOCAL_AI_PROVIDER_URL,
    ).toBe("http://127.0.0.1:9002/v1");
    const unset = { ...s };
    delete unset["LLAMACTL_INTERNAL_PROXY_URL"];
    expect(resolveEnv(unset).LOCAL_AI_PROVIDER_URL).toBe(PX);
  });

  // kills: ignoring the opt-out; checking the proxy before the route; ROUTE=direct not tracking the tracked URL.
  test("LOCAL_AI_PROVIDER_ROUTE=direct gives the tracked server URL", () => {
    expect(resolveEnv({ ...B, LOCAL_AI_PROVIDER_ROUTE: "direct" }).LOCAL_AI_PROVIDER_URL).toBe(
      TRACKED,
    );
    expect(
      resolveEnv({
        ...B,
        LLAMA_CPP_PORT: "9090",
        LOCAL_AI_PROVIDER_ROUTE: "direct",
        LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9001",
      }).LOCAL_AI_PROVIDER_URL,
    ).toBe("http://127.0.0.1:9090/v1");
    const r = resolveEnv({
      ...B,
      LOCAL_AI_PROVIDER_ROUTE: "direct",
      LOCAL_AI_LLAMA_CPP_BASE_URL: "http://10.0.0.99:9999/v1",
    });
    expect(r.LOCAL_AI_PROVIDER_URL).toBe("http://10.0.0.99:9999/v1");
    expect(r.OPENAI_BASE_URL).toBe("http://10.0.0.99:9999/v1");
    // Only the exact value "direct" opts out; any other value keeps the proxy.
    for (const route of ["proxy", "DIRECT", "Direct", "direct-ish"]) {
      expect(resolveEnv({ ...B, LOCAL_AI_PROVIDER_ROUTE: route }).LOCAL_AI_PROVIDER_URL).toBe(PX);
    }
    // Leaving direct mode after a seed returns to the proxy.
    const s = seed({ ...B, LOCAL_AI_PROVIDER_ROUTE: "direct" });
    delete s["LOCAL_AI_PROVIDER_ROUTE"];
    expect(resolveEnv(s).LOCAL_AI_PROVIDER_URL).toBe(PX);
  });

  // kills: using `??` (gives "/v1"), or treating an empty route as direct.
  test("empty strings are unset", () => {
    expect(
      resolveEnv({
        ...B,
        LLAMACTL_INTERNAL_PROXY_URL: "",
        LOCAL_AI_LLAMA_CPP_BASE_URL: "",
        LOCAL_AI_PROVIDER_ROUTE: "",
      }).LOCAL_AI_PROVIDER_URL,
    ).toBe(PX);
  });

  // kills: any read of LOCAL_AI_PROVIDER_URL / OPENAI_BASE_URL as an input.
  test.each([
    ["a main-era :8080 seed", TRACKED],
    ["an old proxy URL", "http://127.0.0.1:9001/v1"],
    ["an lmstudio URL after switching provider", LMS],
    ["an operator export", "http://10.0.0.7:5555/v1"],
  ])("an incoming stale LOCAL_AI_PROVIDER_URL is ignored (%s)", (_label, stale) => {
    const r = resolveEnv({ ...B, LOCAL_AI_PROVIDER_URL: stale, OPENAI_BASE_URL: stale });
    expect(r.LOCAL_AI_PROVIDER_URL).toBe(PX);
    expect(r.OPENAI_BASE_URL).toBe(PX);
    expect(
      resolveEnv({ ...B, LOCAL_AI_PROVIDER_ROUTE: "direct", LOCAL_AI_PROVIDER_URL: stale })
        .LOCAL_AI_PROVIDER_URL,
    ).toBe(TRACKED);
  });

  // kills: provider output that depends on its own previous value.
  test("re-resolving a seeded env is a fixed point and self-corrects", () => {
    for (const input of [
      B,
      { ...B, LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9001" },
      { ...B, LOCAL_AI_PROVIDER_ROUTE: "direct" },
      { ...B, LOCAL_AI_PROVIDER: "lmstudio" },
      { ...B, LOCAL_AI_LLAMA_CPP_BASE_URL: "http://10.0.0.99:9999/v1" },
    ]) {
      const once = resolveEnv(input);
      expect(resolveEnv(seed(input))).toEqual(once);
      expect(resolveEnv(seed(seed(input)))).toEqual(once);
    }
    // Issue #315's inherited environment: every URL stale at :8080.
    const stale = {
      ...B,
      LOCAL_AI_LLAMA_CPP_BASE_URL: TRACKED,
      LOCAL_AI_PROVIDER_URL: TRACKED,
      OPENAI_BASE_URL: TRACKED,
    };
    expect(resolveEnv(stale).LOCAL_AI_PROVIDER_URL).toBe(PX);
    // Switching lmstudio -> llama.cpp after a seed returns to the proxy.
    const lm = seed({ ...B, LOCAL_AI_PROVIDER: "lmstudio" });
    expect(lm["LOCAL_AI_PROVIDER_URL"]).toBe(LMS);
    expect(resolveEnv({ ...lm, LOCAL_AI_PROVIDER: "llama.cpp" }).LOCAL_AI_PROVIDER_URL).toBe(PX);
  });

  // kills: a test-profile short-circuit that ignores a configured proxy; defaulting hermetic runs to 7944.
  test("test profile keeps the sentinel unless a proxy is configured", () => {
    const tp = {
      LLAMACTL_TEST_PROFILE: "/tmp/hermetic",
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    };
    expect(resolveEnv(tp).LOCAL_AI_PROVIDER_URL).toBe("http://127.0.0.1:65534/v1");
    expect(resolveEnv(seed(tp)).LOCAL_AI_PROVIDER_URL).toBe("http://127.0.0.1:65534/v1");
    const r = resolveEnv({ ...tp, LLAMACTL_INTERNAL_PROXY_URL: "http://127.0.0.1:9001" });
    expect(r.LOCAL_AI_PROVIDER_URL).toBe("http://127.0.0.1:9001/v1");
    expect(r.LOCAL_AI_LLAMA_CPP_BASE_URL).toBe("http://127.0.0.1:65534/v1");
  });
});
