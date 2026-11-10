import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { EngineBootEnv, ModelHostSpecForEngine } from "../../src/engines/types.js";

import { ENGINES } from "../../src/engines/index.js";
import { gracefulShutdown } from "../../src/engines/lifecycle.js";
import * as omlxModule from "../../src/engines/omlx.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

function makeFakeBinary(): string {
  const dir = join(
    tmpdir(),
    `omlx-test-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "omlx");
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return path;
}

const goodBinary = makeFakeBinary();

const baseSpec: ModelHostSpecForEngine = {
  engine: "omlx",
  binary: goodBinary,
  endpoint: { host: "127.0.0.1", port: 8094 },
  hostedModels: [{ rel: "mlx-community/Qwen3-8B-MLX-4bit" }],
  resources: { expectedMemoryGiB: 12 },
  extraArgs: ["--max-concurrent-requests", "4"],
  timeoutSeconds: 60,
};

// #220: /v1/models always lists the model; /ready answers 503 until setServeReady(true).
function readinessServer(modelId: string): {
  endpoint: { host: string; port: number };
  readyHits: () => number;
  setServeReady: (value: boolean) => void;
  stop: () => Promise<void>;
} {
  let serveReady = false;
  let hits = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: modelId }] });
      }
      if (path === "/ready") {
        hits += 1;
        return serveReady
          ? Response.json({ status: "ready", model: modelId })
          : new Response("loading", { status: 503 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const { port } = server;
  if (port === undefined) throw new Error("probe server did not bind a port");
  return {
    endpoint: { host: "127.0.0.1", port },
    readyHits: (): number => hits,
    setServeReady: (value): void => {
      serveReady = value;
    },
    stop: async (): Promise<void> => {
      await server.stop();
    },
  };
}

describe("omlx engine adapter", () => {
  test("validateSpec passes when binary exists", () => {
    const result = ENGINES.omlx.validateSpec(baseSpec);
    expect(result.ok).toBe(true);
  });

  test("validateSpec rejects missing binary file", () => {
    const bad = { ...baseSpec, binary: "/this/path/does/not/exist/omlx" };
    const result = ENGINES.omlx.validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/binary not found/);
  });

  test("validateSpec rejects empty binary string (no PATH fallback)", () => {
    const bad = { ...baseSpec, binary: "" };
    const result = ENGINES.omlx.validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/binary/i);
  });

  test("validateSpec rejects zero hosted models", () => {
    const bad = { ...baseSpec, hostedModels: [] };
    const result = ENGINES.omlx.validateSpec(bad);
    expect(result.ok).toBe(false);
  });

  test("validateSpec rejects non-loopback endpoint host", () => {
    const bad = { ...baseSpec, endpoint: { host: "example.com", port: 8094 } };
    const result = ENGINES.omlx.validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/loopback|0\.0\.0\.0/);
  });

  test("buildBootCommand uses serve subcommand + --model-dir + --port", () => {
    const built = ENGINES.omlx.buildBootCommand(baseSpec, {
      LLAMA_CPP_MODELS: "/Volumes/WorkSSD/ai-models/llama.cpp/models",
    });
    expect(built.binary).toBe(goodBinary);
    expect(built.args[0]).toBe("serve");
    expect(built.args).toContain("--model-dir");
    expect(built.args).toContain("/Volumes/WorkSSD/ai-models/llama.cpp/models");
    expect(built.args).toContain("--port");
    expect(built.args).toContain("8094");
    expect(built.args).toContain("--host");
    expect(built.args).toContain("127.0.0.1");
  });

  test("buildBootCommand passes --memory-guard-gb when resources set", () => {
    const built = ENGINES.omlx.buildBootCommand(baseSpec, { LLAMA_CPP_MODELS: "/tmp" });
    expect(built.args).toContain("--memory-guard-gb");
    expect(built.args).toContain("12");
  });

  test("buildBootCommand keeps an explicit expectedMemoryGiB unchanged", () => {
    const built = ENGINES.omlx.buildBootCommand(baseSpec, {
      LLAMA_CPP_MODELS: "/tmp",
      machineProfile: "balanced",
    } satisfies EngineBootEnv);
    const idx = built.args.indexOf("--memory-guard-gb");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(built.args[idx + 1]).toBe("12");
  });

  test("buildBootCommand still emits --memory-guard-gb when resources are omitted", () => {
    const { resources: _omitted, ...specWithoutResources } = baseSpec;
    void _omitted;
    const built = ENGINES.omlx.buildBootCommand(specWithoutResources, {
      LLAMA_CPP_MODELS: "/tmp",
      machineProfile: "balanced",
    } satisfies EngineBootEnv);
    const idx = built.args.indexOf("--memory-guard-gb");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(built.args[idx + 1]).toBe("24");
  });

  test("buildBootCommand appends extraArgs verbatim", () => {
    const built = ENGINES.omlx.buildBootCommand(baseSpec, { LLAMA_CPP_MODELS: "/tmp" });
    expect(built.args).toContain("--max-concurrent-requests");
    expect(built.args).toContain("4");
  });

  test("buildBootCommand prefers LLAMACTL_MODELS_DIR over LLAMA_CPP_MODELS", () => {
    const built = ENGINES.omlx.buildBootCommand(baseSpec, {
      LLAMACTL_MODELS_DIR: "/neutral/models",
      LLAMA_CPP_MODELS: "/legacy/models",
    });
    expect(built.args).toContain("/neutral/models");
    expect(built.args).not.toContain("/legacy/models");
  });

  test("buildBootCommand rejects hosted model rel escapes", () => {
    const bad = {
      ...baseSpec,
      hostedModels: [{ rel: "../../escape" }],
    };
    expect(() => ENGINES.omlx.buildBootCommand(bad, { LLAMA_CPP_MODELS: "/tmp/models" })).toThrow(
      /escapes models dir/,
    );
  });

  test("buildBootCommand uses per-workload isolated model dir when workloadName is set", () => {
    const runtimeDir = join(
      tmpdir(),
      `omlx-iso-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const built = ENGINES.omlx.buildBootCommand(baseSpec, {
      LLAMACTL_MODELS_DIR: "/neutral/models",
      LLAMACTL_RUNTIME_DIR: runtimeDir,
      workloadName: "iso-mlx-host",
    });
    // Should NOT pass the full models dir — instead the isolated per-workload dir.
    const modelDirIdx = built.args.indexOf("--model-dir");
    expect(modelDirIdx).toBeGreaterThanOrEqual(0);
    const modelDirValue = built.args[modelDirIdx + 1]!;
    expect(modelDirValue).toContain("iso-mlx-host");
    expect(modelDirValue).toContain(".omlx");
    expect(modelDirValue).toContain("models");
    expect(modelDirValue).not.toBe("/neutral/models");
  });

  test("prepareLaunch creates an isolated symlink to the hosted model", async () => {
    // Mock models dir with the hosted model present.
    const modelsDir = join(
      tmpdir(),
      `omlx-models-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const hostedRel = baseSpec.hostedModels[0]!.rel;
    mkdirSync(join(modelsDir, hostedRel), { recursive: true });
    writeFileSync(join(modelsDir, hostedRel, "config.json"), "{}");

    const runtimeDir = join(
      tmpdir(),
      `omlx-iso-prep-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await ENGINES.omlx.prepareLaunch?.(baseSpec, {
      LLAMACTL_MODELS_DIR: modelsDir,
      LLAMACTL_RUNTIME_DIR: runtimeDir,
      workloadName: "iso-prep-host",
    });

    const isolatedDir = join(runtimeDir, "workloads", "iso-prep-host", ".omlx", "models");
    const linkTarget = join(isolatedDir, basename(hostedRel));
    // The symlink should resolve to the original model dir (i.e. config.json reachable through it).
    expect(existsSync(linkTarget)).toBe(true);
    expect(existsSync(join(linkTarget, "config.json"))).toBe(true);
    // And ONLY the hosted model is present (other models in modelsDir not visible).
    const otherModelDir = join(modelsDir, "mlx-community", "some-other-model");
    mkdirSync(otherModelDir, { recursive: true });
    writeFileSync(join(otherModelDir, "config.json"), "{}");
    expect(existsSync(join(isolatedDir, "some-other-model"))).toBe(false);

    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(modelsDir, { recursive: true, force: true });
  });

  test("prepareLaunch is idempotent (recreates a stale symlink)", async () => {
    const modelsDir = join(
      tmpdir(),
      `omlx-models-2-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const hostedRel = baseSpec.hostedModels[0]!.rel;
    mkdirSync(join(modelsDir, hostedRel), { recursive: true });
    writeFileSync(join(modelsDir, hostedRel, "config.json"), "{}");

    const runtimeDir = join(
      tmpdir(),
      `omlx-iso-idem-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const envBoot = {
      LLAMACTL_MODELS_DIR: modelsDir,
      LLAMACTL_RUNTIME_DIR: runtimeDir,
      workloadName: "iso-idem-host",
    } satisfies EngineBootEnv;
    await ENGINES.omlx.prepareLaunch?.(baseSpec, envBoot);
    // Second call should not throw despite the symlink already existing.
    await ENGINES.omlx.prepareLaunch?.(baseSpec, envBoot);
    const linkTarget = join(
      runtimeDir,
      "workloads",
      "iso-idem-host",
      ".omlx",
      "models",
      basename(hostedRel),
    );
    expect(existsSync(linkTarget)).toBe(true);
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(modelsDir, { recursive: true, force: true });
  });

  test("probeReady returns matching modelIds when /v1/models contains the rel basename", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [{ id: "Qwen3-8B-MLX-4bit", object: "model" }],
        }),
        { headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const result = await ENGINES.omlx.probeReady({ host: "127.0.0.1", port: 54321 }, 3000);
    globalThis.fetch = originalFetch;
    expect(result.ready).toBe(true);
    expect(result.modelIds).toContain("Qwen3-8B-MLX-4bit");
  });

  test("probeReady returns ready:false on timeout", async () => {
    const result = await ENGINES.omlx.probeReady({ host: "127.0.0.1", port: 1 }, 500);
    expect(result.ready).toBe(false);
  });

  test("probeReady times out cleanly without overrunning the deadline", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: Request | URL | string, init?: RequestInit) =>
      await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      })) as typeof fetch;
    const started = Date.now();
    const result = await ENGINES.omlx.probeReady({ host: "127.0.0.1", port: 54321 }, 300);
    const elapsed = Date.now() - started;
    globalThis.fetch = originalFetch;
    expect(result.ready).toBe(false);
    expect(elapsed).toBeLessThan(1200);
  });

  test("probeReady waits for the readiness probe even when /v1/models already lists a model", async () => {
    const probe = readinessServer("Qwen3-8B-MLX-4bit");
    const readiness = { path: "/ready", expectStatus: 200, expectJson: { status: "ready" } };
    try {
      const notReady = await ENGINES.omlx.probeReady(probe.endpoint, 400, readiness);
      expect(notReady.ready).toBe(false);
      probe.setServeReady(true);
      const ready = await ENGINES.omlx.probeReady(probe.endpoint, 2000, readiness);
      expect(ready.ready).toBe(true);
      expect(ready.modelIds).toContain("Qwen3-8B-MLX-4bit");
      expect(probe.readyHits()).toBeGreaterThan(0);
    } finally {
      await probe.stop();
    }
  });

  test("probeReady without readiness keeps the /v1/models-only behaviour", async () => {
    const probe = readinessServer("Qwen3-8B-MLX-4bit");
    try {
      const result = await ENGINES.omlx.probeReady(probe.endpoint, 2000);
      expect(result.ready).toBe(true);
      expect(result.modelIds).toContain("Qwen3-8B-MLX-4bit");
      expect(probe.readyHits()).toBe(0);
    } finally {
      await probe.stop();
    }
  });

  test("teardown returns quickly when the process exits on its own", async () => {
    const proc = Bun.spawn(["sh", "-lc", "sleep 0.2"], { stderr: "pipe", stdout: "pipe" });
    const started = Date.now();
    await ENGINES.omlx.teardown(proc.pid);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1000);
  });

  test("teardown escalates to SIGKILL after grace expires", async () => {
    const proc = Bun.spawn(
      [
        "python3",
        "-c",
        "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)",
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    const started = Date.now();
    await gracefulShutdown(proc.pid, 250);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2000);
    expect(() => process.kill(proc.pid, 0)).toThrow();
  });

  afterAll(() => {
    try {
      rmSync(goodBinary, { force: true });
    } catch {
      // Best-effort cleanup for a temp binary already removed by the OS.
    }
  });
});

const OMLX_STATUS_REVISION = "feec0a0e4eda6ad5c227a5f9ee216c6fb6d2fe9b"; // jundot/omlx server.py list_models_status
const REL = "mlx-community/Qwen3-8B-MLX-4bit";
const ID = "Qwen3-8B-MLX-4bit";

type ParseStatusFn = (body: unknown, hostedRel: string) => unknown;
type DeriveFn = (observation: unknown, readinessOk: boolean | undefined) => unknown;

const omlxExports = omlxModule as unknown as Record<string, unknown>;

function parseStatusFn(): ParseStatusFn {
  const fn = omlxExports["parseOmlxModelsStatus"];
  expect(typeof fn).toBe("function");
  return fn as ParseStatusFn;
}

function deriveFn(): DeriveFn {
  const fn = omlxExports["deriveOmlxResidency"];
  expect(typeof fn).toBe("function");
  return fn as DeriveFn;
}

type FixtureModel = {
  id: string;
  loaded: boolean;
  is_loading: boolean;
  actual_size?: number | null;
  resident_estimated_size?: number | null;
  // unknown so tests can send non-string engine_type values; written whenever present.
  engineType?: unknown;
};

// Mirrors the list_models_status payload at OMLX_STATUS_REVISION.
function statusFixtureV1(models: FixtureModel[]): Record<string, unknown> {
  return {
    final_ceiling: 34359738368,
    current_model_memory: 0,
    model_count: models.length,
    loaded_count: models.filter((m) => m.loaded).length,
    load_seconds_per_gb_estimate: null,
    load_time_observations: 0,
    models: models.map((m) => {
      const entry: Record<string, unknown> = {
        id: m.id,
        model_path: `/models/${m.id}`,
        loaded: m.loaded,
        is_loading: m.is_loading,
        loading_started_at: null,
        estimated_size: 5000000000,
        resident_estimated_size:
          "resident_estimated_size" in m ? m.resident_estimated_size : 5000000000,
        distributed: false,
        actual_size: "actual_size" in m ? m.actual_size : m.loaded ? 4800000000 : null,
        pinned: false,
        model_type: "llm",
        config_model_type: "qwen3",
        model_context_length: 40960,
        is_helper: false,
        source_type: "local",
        max_context_window: 40960,
        max_tokens: 32768,
        is_favorite: false,
        is_hidden: false,
      };
      if ("engineType" in m) {
        entry["engine_type"] = m.engineType;
      }
      return entry;
    }),
  };
}

const LOADED = {
  state: "loaded",
  modelId: ID,
  actualSize: 4800000000,
  residentEstimatedSize: 5000000000,
};

const READINESS_VALUES: (boolean | undefined)[] = [true, false, undefined];

const MALFORMED_STATUS_BODIES: { label: string; body: unknown }[] = [
  { label: "null body", body: null },
  { label: "array body", body: [] },
  { label: "string body", body: "x" },
  { label: "empty object body", body: {} },
  { label: "models not an array", body: { models: "x" } },
  {
    label: "loaded not a boolean",
    body: { models: [{ id: ID, loaded: "yes", is_loading: false }] },
  },
  { label: "is_loading missing", body: { models: [{ id: ID, loaded: true }] } },
  {
    label: "actual_size not a number",
    body: { models: [{ id: ID, loaded: true, is_loading: false, actual_size: "4GB" }] },
  },
  {
    label: "actual_size negative",
    body: { models: [{ id: ID, loaded: true, is_loading: false, actual_size: -1 }] },
  },
  {
    label: "resident_estimated_size negative",
    body: {
      models: [{ id: ID, loaded: true, is_loading: false, resident_estimated_size: -5 }],
    },
  },
];

// #282 DF-09: pure contract for oMLX's native list_models_status payload and the
// residency derivation that folds the readiness probe into it. No IO.
describe("#282 DF-09 oMLX native model status contract", () => {
  test("P1 discovered when listed but neither loaded nor loading", () => {
    const parse = parseStatusFn();
    expect(OMLX_STATUS_REVISION).toHaveLength(40);
    expect(
      parse(statusFixtureV1([{ id: ID, loaded: false, is_loading: false }]), REL),
    ).toStrictEqual({ state: "discovered", modelId: ID });
  });

  test("P2 loading: is_loading wins over loaded", () => {
    const parse = parseStatusFn();
    expect(
      parse(statusFixtureV1([{ id: ID, loaded: false, is_loading: true }]), REL),
    ).toStrictEqual({ state: "loading", modelId: ID });
    expect(parse(statusFixtureV1([{ id: ID, loaded: true, is_loading: true }]), REL)).toStrictEqual(
      { state: "loading", modelId: ID },
    );
  });

  test("P2a engineType emitted when engine_type is a string", () => {
    const parse = parseStatusFn();
    expect(
      parse(
        statusFixtureV1([{ id: ID, loaded: false, is_loading: true, engineType: "batched" }]),
        REL,
      ),
    ).toStrictEqual({ state: "loading", modelId: ID, engineType: "batched" });
    expect(
      parse(
        statusFixtureV1([{ id: ID, loaded: false, is_loading: false, engineType: "llm" }]),
        REL,
      ),
    ).toStrictEqual({ state: "discovered", modelId: ID, engineType: "llm" });
    expect(
      parse(
        statusFixtureV1([
          {
            id: ID,
            loaded: true,
            is_loading: false,
            engineType: "embedding",
          },
        ]),
        REL,
      ),
    ).toStrictEqual({
      state: "loaded",
      modelId: ID,
      actualSize: 4800000000,
      residentEstimatedSize: 5000000000,
      engineType: "embedding",
    });
  });

  test("P2b engineType absent when engine_type is missing or non-string", () => {
    const parse = parseStatusFn();
    const noEngineType: FixtureModel = { id: ID, loaded: false, is_loading: true };
    expect(parse(statusFixtureV1([noEngineType]), REL)).toStrictEqual({
      state: "loading",
      modelId: ID,
    });
    expect(
      parse(statusFixtureV1([{ id: ID, loaded: false, is_loading: false }]), REL),
    ).toStrictEqual({ state: "discovered", modelId: ID });
    expect(
      parse(
        statusFixtureV1([
          {
            id: ID,
            loaded: true,
            is_loading: false,
          },
        ]),
        REL,
      ),
    ).toStrictEqual({
      state: "loaded",
      modelId: ID,
      actualSize: 4800000000,
      residentEstimatedSize: 5000000000,
    });
  });

  test("P2c engineType absent when engine_type is not a string", () => {
    const parse = parseStatusFn();
    for (const engineType of [42, null, {}]) {
      expect(
        parse(statusFixtureV1([{ id: ID, loaded: false, is_loading: true, engineType }]), REL),
      ).toStrictEqual({ state: "loading", modelId: ID });
      expect(
        parse(statusFixtureV1([{ id: ID, loaded: false, is_loading: false, engineType }]), REL),
      ).toStrictEqual({ state: "discovered", modelId: ID });
      expect(
        parse(statusFixtureV1([{ id: ID, loaded: true, is_loading: false, engineType }]), REL),
      ).toStrictEqual({
        state: "loaded",
        modelId: ID,
        actualSize: 4800000000,
        residentEstimatedSize: 5000000000,
      });
    }
  });

  test("P3 loaded: sizes come from actual_size and resident_estimated_size", () => {
    const parse = parseStatusFn();
    expect(
      parse(statusFixtureV1([{ id: ID, loaded: true, is_loading: false }]), REL),
    ).toStrictEqual({
      state: "loaded",
      modelId: ID,
      actualSize: 4800000000,
      residentEstimatedSize: 5000000000,
    });
    expect(
      parse(
        statusFixtureV1([
          {
            id: ID,
            loaded: true,
            is_loading: false,
            actual_size: null,
            resident_estimated_size: null,
          },
        ]),
        REL,
      ),
    ).toStrictEqual({
      state: "loaded",
      modelId: ID,
      actualSize: null,
      residentEstimatedSize: null,
    });
    expect(parse({ models: [{ id: ID, loaded: true, is_loading: false }] }, REL)).toStrictEqual({
      state: "loaded",
      modelId: ID,
      actualSize: null,
      residentEstimatedSize: null,
    });
  });

  test("P4 id matching: full rel id; sibling loaded flags never borrowed", () => {
    const parse = parseStatusFn();
    expect(
      parse(statusFixtureV1([{ id: REL, loaded: false, is_loading: false }]), REL),
    ).toStrictEqual({ state: "discovered", modelId: REL });
    expect(
      parse(
        statusFixtureV1([
          { id: "Other-Model", loaded: true, is_loading: false },
          { id: ID, loaded: false, is_loading: false },
        ]),
        REL,
      ),
    ).toStrictEqual({ state: "discovered", modelId: ID });
  });

  test("P5 not listed when no entry matches the hosted rel", () => {
    const parse = parseStatusFn();
    expect(
      parse(statusFixtureV1([{ id: "Other-Model", loaded: true, is_loading: false }]), REL),
    ).toStrictEqual({ state: "failed", reason: "ModelNotListed" });
    expect(parse(statusFixtureV1([]), REL)).toStrictEqual({
      state: "failed",
      reason: "ModelNotListed",
    });
  });

  for (const { label, body } of MALFORMED_STATUS_BODIES) {
    test(`P6 malformed status: ${label}`, () => {
      const parse = parseStatusFn();
      expect(parse(body, REL)).toStrictEqual({ state: "failed", reason: "MalformedStatus" });
    });
  }

  test("P7 tolerant siblings: only the matched entry is validated", () => {
    const parse = parseStatusFn();
    expect(
      parse(
        {
          models: [
            42,
            null,
            { loaded: true, is_loading: false },
            { id: 7, loaded: true },
            { id: "Other-Model", loaded: "weird" },
            {
              id: ID,
              loaded: true,
              is_loading: false,
              actual_size: 4800000000,
              resident_estimated_size: 5000000000,
            },
          ],
        },
        REL,
      ),
    ).toStrictEqual({
      state: "loaded",
      modelId: ID,
      actualSize: 4800000000,
      residentEstimatedSize: 5000000000,
    });
  });

  test("D1 no readiness configured: loaded promotes to ready", () => {
    const derive = deriveFn();
    expect(derive(LOADED, undefined)).toStrictEqual({
      state: "ready",
      modelId: ID,
      actualSize: 4800000000,
      residentEstimatedSize: 5000000000,
    });
  });

  test("D2 readiness honoured: false stays resident, true promotes to ready", () => {
    const derive = deriveFn();
    expect(derive(LOADED, false)).toStrictEqual({
      state: "resident",
      modelId: ID,
      actualSize: 4800000000,
      residentEstimatedSize: 5000000000,
    });
    expect(derive(LOADED, true)).toStrictEqual({
      state: "ready",
      modelId: ID,
      actualSize: 4800000000,
      residentEstimatedSize: 5000000000,
    });
  });

  test("D3 readiness never upgrades an unloaded model", () => {
    const derive = deriveFn();
    const observations = [
      { state: "discovered", modelId: ID },
      { state: "loading", modelId: ID },
    ];
    for (const observation of observations) {
      for (const readinessOk of READINESS_VALUES) {
        expect(derive(observation, readinessOk)).toStrictEqual(observation);
      }
    }
  });

  test("D4 failures pass through unchanged", () => {
    const derive = deriveFn();
    const observations = [
      { state: "failed", reason: "ModelNotListed" },
      { state: "failed", reason: "MalformedStatus" },
    ];
    for (const observation of observations) {
      for (const readinessOk of READINESS_VALUES) {
        expect(derive(observation, readinessOk)).toStrictEqual(observation);
      }
    }
  });

  test("D5 null sizes are carried through to ready", () => {
    const derive = deriveFn();
    expect(
      derive({ state: "loaded", modelId: ID, actualSize: null, residentEstimatedSize: null }, true),
    ).toStrictEqual({
      state: "ready",
      modelId: ID,
      actualSize: null,
      residentEstimatedSize: null,
    });
  });
});
