import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import type { EngineAdapter, EngineName, ModelHostSpecForEngine } from "../../src/engines/types.js";

import { ENGINES } from "../../src/engines/index.js";
import { readModelHostState, writeModelHostState } from "../../src/engines/state.js";
import { resolveEnv } from "../../src/env.js";
import { mkdirSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

const dir = mkdtempSync(join(tmpdir(), "kapitsa-engine-"));
const binary = join(dir, "kapitsa");
const modelsDir = join(dir, "models");
mkdirSync(join(modelsDir, "mlx", "qwen35b"), { recursive: true });
writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const spec: ModelHostSpecForEngine = {
  engine: "kapitsa",
  binary,
  endpoint: { host: "127.0.0.1", port: 18200 },
  hostedModels: [{ rel: "mlx/qwen35b" }],
  extraArgs: ["--mem-budget", "26", "--context", "32768", "--slots", "1"],
  timeoutSeconds: 60,
};

function engine(): EngineAdapter {
  const adapter = (ENGINES as Partial<Record<string, EngineAdapter>>)["kapitsa"];
  expect(adapter).toBeDefined();
  return adapter!;
}

describe("Kapitsa ModelHost adapter", () => {
  test("requires an absolute binary path rather than a PATH-resolved name", () => {
    const cwdRelative = relative(process.cwd(), binary);
    expect(engine().validateSpec({ ...spec, binary: cwdRelative }).ok).toBe(false);
  });

  test("rejects binaries whose name cannot satisfy lifecycle identity", () => {
    const renamed = join(dir, "kapitsa-0.2.24");
    writeFileSync(renamed, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(engine().validateSpec({ ...spec, binary: renamed }).ok).toBe(false);
  });

  test("rejects overrides of the declared model, endpoint, and backend", () => {
    for (const flag of [
      "--model",
      "-m",
      "--model-id",
      "--host",
      "--port",
      "--engine",
      "--allow-switch",
      "--split",
    ]) {
      expect(engine().validateSpec({ ...spec, extraArgs: [flag, "other"] }).ok).toBe(false);
      expect(engine().validateSpec({ ...spec, extraArgs: [`${flag}=other`] }).ok).toBe(false);
    }
  });

  test("validates a local, explicit, single-model launch", () => {
    expect(engine().validateSpec(spec)).toEqual({ ok: true });
    expect(engine().validateSpec({ ...spec, binary: "" }).ok).toBe(false);
    expect(engine().validateSpec({ ...spec, binary: join(dir, "missing") }).ok).toBe(false);
    expect(engine().validateSpec({ ...spec, hostedModels: [] }).ok).toBe(false);
    expect(engine().validateSpec({ ...spec, hostedModels: [{ rel: "a" }, { rel: "b" }] }).ok).toBe(
      false,
    );
    expect(
      engine().validateSpec({ ...spec, hostedModels: [{ rel: "a", lora_path: "adapter" }] }).ok,
    ).toBe(false);
    expect(
      engine().validateSpec({ ...spec, hostedModels: [{ rel: "a", dflash: { enabled: true } }] })
        .ok,
    ).toBe(false);
  });

  test("builds native argv and isolates runtime state without implicit downloads", () => {
    const result = engine().buildBootCommand(spec, {
      LLAMACTL_MODELS_DIR: modelsDir,
      LLAMACTL_RUNTIME_DIR: "/runtime",
      workloadName: "experimental-kapitsa",
    });
    expect(result.binary).toBe(binary);
    expect(result.args).toEqual([
      "serve",
      "--model",
      join(modelsDir, "mlx", "qwen35b"),
      "--model-id",
      "qwen35b",
      "--local",
      "--host",
      "127.0.0.1",
      "--port",
      "18200",
      ...spec.extraArgs,
    ]);
    expect(result.envOverrides).toEqual({
      KAPITSA_NO_AUTO_UPDATE: "1",
      KAPITSA_HOME: "/runtime/workloads/experimental-kapitsa/.kapitsa",
    });
  });

  test("requires a model root and rejects traversal", () => {
    mkdirSync(join(dir, "outside"), { recursive: true });
    expect(() => engine().buildBootCommand(spec, {})).toThrow(/MODELS_DIR|MODELS/);
    expect(() =>
      engine().buildBootCommand(
        { ...spec, hostedModels: [{ rel: "../outside" }] },
        {
          LLAMACTL_MODELS_DIR: modelsDir,
        },
      ),
    ).toThrow(/escapes/);
  });

  test("requires an existing preconverted model directory", () => {
    const gguf = join(modelsDir, "model.gguf");
    writeFileSync(gguf, "GGUF");
    for (const rel of ["missing", "model.gguf"]) {
      expect(() =>
        engine().buildBootCommand(
          { ...spec, hostedModels: [{ rel }] },
          { LLAMACTL_MODELS_DIR: modelsDir },
        ),
      ).toThrow(/model directory/);
    }
  });

  test("honors an explicit serving probe", async () => {
    let ready = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        return new URL(request.url).pathname === "/v1/models"
          ? Response.json({ data: [{ id: "qwen35b" }] })
          : Response.json({ status: ready ? "ready" : "loading" }, { status: ready ? 200 : 503 });
      },
    });
    try {
      const endpoint = { host: "127.0.0.1", port: server.port! };
      const probe = { path: "/ready", expectStatus: 200, expectJson: { status: "ready" } };
      expect((await engine().probeReady(endpoint, 100, probe)).ready).toBe(false);
      ready = true;
      expect(await engine().probeReady(endpoint, 1000, probe)).toEqual({
        ready: true,
        modelIds: ["qwen35b"],
      });
    } finally {
      await server.stop();
    }
  });

  test("round-trips Kapitsa state through the existing route registry", () => {
    const env = resolveEnv({ ...process.env, LOCAL_AI_RUNTIME_DIR: join(dir, "runtime") });
    const state = {
      kind: "ModelHost" as const,
      engine: "kapitsa" as EngineName,
      pid: process.pid,
      host: "127.0.0.1",
      port: 18200,
      modelAliases: ["qwen35b"],
      startedAt: new Date().toISOString(),
    };
    writeModelHostState(state, { name: "experimental-kapitsa" }, env);
    expect(readModelHostState({ name: "experimental-kapitsa" }, env)?.engine).toBe("kapitsa");
  });
});
