/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun's rejects matcher is typed as void; prepareLaunch failure assertions must await it per the #557 test contract. */
// Pins for #557 S3: the libosmos engine adapter (osmos-api argv ->
// osmos.json, /health readiness, osmos-<pack> id mapping). The adapter is
// resolved through the registry so this file type-checks and fails by
// assertion before packages/core/src/engines/libosmos.ts exists.

import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  EngineAdapter,
  EngineBootEnv,
  EngineName,
  ModelHostSpecForEngine,
} from "../../src/engines/types.js";

import { ENGINES } from "../../src/engines/index.js";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "../../src/safe-fs.js";

const adapter = (ENGINES as Record<string, EngineAdapter | undefined>)["libosmos"];

const dir = mkdtempSync(join(tmpdir(), "libosmos-engine-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const binary = join(dir, "osmos-api");
writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
writeFileSync(join(dir, "osmos-serve"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

const modelsDir = join(dir, "models");
const REL =
  "DeepSeek-V4.1-Flash-1017-GGUF/UD-IQ1_M/DeepSeek-V4.1-Flash-1017-UD-IQ1_M-00001-of-00005.gguf";
const PACK = "DeepSeek-V4.1-Flash-1017-UD-IQ1_M-00001-of-00005";
mkdirSync(dirname(join(modelsDir, REL)), { recursive: true });
writeFileSync(join(modelsDir, REL), "");
mkdirSync(join(modelsDir, "dspark"), { recursive: true });
writeFileSync(join(modelsDir, "dspark", "drafter.gguf"), "");
mkdirSync(join(modelsDir, "picks"), { recursive: true });
writeFileSync(join(modelsDir, "picks", "picks.bin"), "");

const LIBOSMOS = "libosmos" as EngineName;

const spec: ModelHostSpecForEngine = {
  engine: LIBOSMOS,
  binary,
  endpoint: { host: "127.0.0.1", port: 8084 },
  hostedModels: [{ rel: REL }],
  extraArgs: ["--max-context", "65536"],
  timeoutSeconds: 60,
};

// prepareLaunch may be absent on a partial adapter and may throw
// synchronously; normalise both shapes into a rejection so every failure
// assertion is `rejects.toThrow`.
const prep = (s: ModelHostSpecForEngine, e: EngineBootEnv): Promise<void> =>
  Promise.resolve().then(() => adapter!.prepareLaunch!(s, e));

const bootEnv = (runtimeDir: string, workloadName: string): EngineBootEnv => ({
  LLAMACTL_MODELS_DIR: modelsDir,
  LLAMACTL_RUNTIME_DIR: runtimeDir,
  workloadName,
});

const readOsmosJson = (runtimeDir: string, workloadName: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(runtimeDir, "workloads", workloadName, ".osmos", "osmos.json"), "utf8"),
  ) as Record<string, unknown>;

describe("libosmos engine adapter", () => {
  test("validateSpec accepts a well-formed spec", () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    expect(adapter!.validateSpec(spec)).toEqual({ ok: true });
  });

  test("validateSpec requires an absolute existing osmos-api binary", () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    expect(adapter!.validateSpec({ ...spec, binary: "osmos-api" }).ok).toBe(false);
    expect(adapter!.validateSpec({ ...spec, binary: join(dir, "missing", "osmos-api") }).ok).toBe(
      false,
    );
    expect(adapter!.validateSpec({ ...spec, binary: join(dir, "osmos-serve") }).ok).toBe(false);
  });

  test("validateSpec binds only to 127.0.0.1", () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    for (const host of ["localhost", "::1", "0.0.0.0", "127.0.0.2", "10.0.0.5"]) {
      expect(adapter!.validateSpec({ ...spec, endpoint: { host, port: 8084 } }).ok).toBe(false);
    }
  });

  test("validateSpec requires exactly one plain .gguf hosted model", () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    expect(adapter!.validateSpec({ ...spec, hostedModels: [] }).ok).toBe(false);
    expect(adapter!.validateSpec({ ...spec, hostedModels: [{ rel: REL }, { rel: REL }] }).ok).toBe(
      false,
    );
    expect(
      adapter!.validateSpec({
        ...spec,
        hostedModels: [{ rel: REL, lora_path: "adapters/x.gguf" }],
      }).ok,
    ).toBe(false);
    expect(
      adapter!.validateSpec({
        ...spec,
        hostedModels: [{ rel: REL, dflash: { enabled: true } }],
      }).ok,
    ).toBe(false);
    expect(
      adapter!.validateSpec({ ...spec, hostedModels: [{ rel: "model.safetensors" }] }).ok,
    ).toBe(false);
    const longStem = `pack/${"a".repeat(64)}.gguf`;
    expect(adapter!.validateSpec({ ...spec, hostedModels: [{ rel: longStem }] }).ok).toBe(false);
  });

  test("validateSpec refuses flags the adapter owns", () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    for (const flag of ["--config", "--host", "--port", "--engine"]) {
      for (const extraArgs of [
        ["--max-context", "65536", flag, "x"],
        ["--max-context", "65536", `${flag}=x`],
      ]) {
        const result = adapter!.validateSpec({ ...spec, extraArgs });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("refused flag");
      }
    }
  });

  test("validateSpec refuses sampling, model, and positional overrides", () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    for (const extraArgs of [
      ["--max-context", "65536", "--overlay", "x"],
      ["--max-context", "65536", "--eos", "1"],
      ["--max-context", "65536", "--model", "x"],
      ["--max-context", "65536", "-m", "x"],
      ["--max-context", "65536", "--temperature", "0"],
      ["--max-context", "65536", "foo"],
    ]) {
      expect(adapter!.validateSpec({ ...spec, extraArgs }).ok).toBe(false);
    }
  });

  test("validateSpec enforces osmos flag values", () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    const check = (extraArgs: string[]): boolean =>
      adapter!.validateSpec({ ...spec, extraArgs }).ok;
    expect(check([])).toBe(false);
    for (const value of ["0", "-1", "1.5", "abc", "10000001"]) {
      expect(check(["--max-context", value])).toBe(false);
      expect(check(["--max-context", "65536", "--parallel", value])).toBe(false);
      expect(check(["--max-context", "65536", "--max-tokens", value])).toBe(false);
    }
    for (const value of ["0", "-3", "x"]) {
      expect(check(["--max-context", "65536", "--budget", value])).toBe(false);
    }
    expect(check(["--max-context", "65536", "--max-context", "65536"])).toBe(false);
    expect(check(["--max-context", "65536", "--max-tokens"])).toBe(false);
    expect(check(["--max-context", "65536", "--no-guess=true"])).toBe(false);
  });

  test("prepareLaunch writes osmos.json from the launch flags", async () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    const runtimeDir = join(dir, "rt-config");
    const env = bootEnv(runtimeDir, "libosmos-ds41");
    const fullSpec: ModelHostSpecForEngine = {
      ...spec,
      extraArgs: [
        "--max-context",
        "65536",
        "--picks",
        "picks/picks.bin",
        "--dspark",
        "dspark/drafter.gguf",
        "--budget",
        "80",
        "--parallel",
        "2",
        "--max-tokens",
        "512",
        "--no-guess",
      ],
    };
    await prep(fullSpec, env);
    const parsed = readOsmosJson(runtimeDir, "libosmos-ds41");
    expect(parsed).toEqual({
      pack: PACK,
      model: join(modelsDir, REL),
      picks: join(modelsDir, "picks", "picks.bin"),
      drafter: join(modelsDir, "dspark", "drafter.gguf"),
      drafted_budget_gib: 80,
      max_context: 65536,
      parallel: 2,
      max_tokens: 512,
      no_guess: true,
    });
    const whitelist = new Set([
      "pack",
      "title",
      "model",
      "picks",
      "drafter",
      "overlay",
      "budget_gib",
      "drafted_budget_gib",
      "no_guess",
      "max_context",
      "parallel",
      "max_tokens",
    ]);
    for (const key of Object.keys(parsed)) {
      expect(whitelist.has(key)).toBe(true);
    }
    expect(statSync(join(runtimeDir, "workloads", "libosmos-ds41", ".osmos")).mode & 0o777).toBe(
      0o700,
    );
  });

  test("prepareLaunch tightens a pre-existing .osmos dir to 0700", async () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    const runtimeDir = join(dir, "rt-config-loose");
    const osmosDir = join(runtimeDir, "workloads", "libosmos-ds41", ".osmos");
    mkdirSync(osmosDir, { recursive: true, mode: 0o755 });
    chmodSync(osmosDir, 0o755);
    expect(statSync(osmosDir).mode & 0o777).toBe(0o755);
    await prep(spec, bootEnv(runtimeDir, "libosmos-ds41"));
    expect(statSync(osmosDir).mode & 0o777).toBe(0o700);
  });

  test("budget and path flags map to the right osmos.json keys", async () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    const runtimeDir = join(dir, "rt-budget");
    const env = bootEnv(runtimeDir, "libosmos-budget");

    await prep({ ...spec, extraArgs: ["--max-context", "65536", "--budget", "80"] }, env);
    let parsed = readOsmosJson(runtimeDir, "libosmos-budget");
    expect(parsed["budget_gib"]).toBe(80);
    expect(parsed["drafted_budget_gib"]).toBeUndefined();

    await prep({ ...spec, extraArgs: ["--max-context", "65536", "--budget", "auto"] }, env);
    parsed = readOsmosJson(runtimeDir, "libosmos-budget");
    expect(parsed["budget_gib"]).toBeUndefined();
    expect(parsed["drafted_budget_gib"]).toBeUndefined();

    const absDraft = join(dir, "abs-drafter.gguf");
    writeFileSync(absDraft, "");
    await prep(
      {
        ...spec,
        extraArgs: ["--max-context", "65536", "--dspark", absDraft, "--budget", "80"],
      },
      env,
    );
    parsed = readOsmosJson(runtimeDir, "libosmos-budget");
    expect(parsed["drafter"]).toBe(absDraft);
    expect(parsed["drafted_budget_gib"]).toBe(80);

    await expect(
      prep({ ...spec, extraArgs: ["--max-context", "65536", "--picks", "../x"] }, env),
    ).rejects.toThrow();
  });

  test("prepareLaunch rejects a missing models dir, escaping rel, or missing model", async () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    const runtimeDir = join(dir, "rt-reject");
    const env: EngineBootEnv = { LLAMACTL_RUNTIME_DIR: runtimeDir, workloadName: "libosmos-x" };
    await expect(prep(spec, env)).rejects.toThrow();

    writeFileSync(join(dir, "escape.gguf"), "");

    const withModels = bootEnv(runtimeDir, "libosmos-x");
    await expect(
      prep({ ...spec, hostedModels: [{ rel: "../escape.gguf" }] }, withModels),
    ).rejects.toThrow("escapes models dir");
    await expect(
      prep({ ...spec, hostedModels: [{ rel: "Missing-Model/missing.gguf" }] }, withModels),
    ).rejects.toThrow();
  });

  test("buildBootCommand emits only --config plus the endpoint flags", async () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    const runtimeDir = join(dir, "rt-boot");
    const env = bootEnv(runtimeDir, "libosmos-ds41");
    await prep(spec, env);
    const boot = adapter!.buildBootCommand(spec, env);
    expect(boot.binary).toBe(spec.binary);
    expect(boot.args).toEqual([
      "--config",
      join(runtimeDir, "workloads", "libosmos-ds41", ".osmos", "osmos.json"),
      "--host",
      "127.0.0.1",
      "--port",
      "8084",
    ]);
    expect(boot.envOverrides ?? {}).toEqual({});
  });

  test("probeReady gates on /health and maps osmos- ids to .gguf aliases", async () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    let healthHits = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/models") {
          return Response.json({ data: [{ id: "osmos-PACK" }] });
        }
        if (path === "/health") {
          healthHits += 1;
          return healthHits <= 2
            ? Response.json({ status: "loading" }, { status: 503 })
            : Response.json({ status: "ok" }, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const result = await adapter!.probeReady({ host: "127.0.0.1", port: server.port! }, 5000);
      expect(result).toEqual({ ready: true, modelIds: ["PACK.gguf"] });
      expect(healthHits).toBeGreaterThanOrEqual(3);
    } finally {
      await server.stop();
    }
  });

  test("probeReady reports not-ready while /health keeps loading", async () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/models") {
          return Response.json({ data: [{ id: "osmos-PACK" }] });
        }
        if (path === "/health") {
          return Response.json({ status: "loading" }, { status: 503 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const result = await adapter!.probeReady({ host: "127.0.0.1", port: server.port! }, 800);
      expect(result.ready).toBe(false);
    } finally {
      await server.stop();
    }
  });

  test("probeReady passes through model ids without the osmos- prefix", async () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/models") {
          return Response.json({ data: [{ id: "vendor-plain" }] });
        }
        if (path === "/health") {
          return Response.json({ status: "ok" }, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const result = await adapter!.probeReady({ host: "127.0.0.1", port: server.port! }, 5000);
      expect(result).toEqual({ ready: true, modelIds: ["vendor-plain"] });
    } finally {
      await server.stop();
    }
  });
});
