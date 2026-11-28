/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun's rejects matcher is typed as void; prepareLaunch failure assertions must await it per the #557 test contract. */
// RED pins for #557: --picks and --dspark are filesystem-backed osmos-api
// assets. Their values must be real flag values, must stay inside the models
// dir when relative, and must exist before prepareLaunch writes osmos.json.

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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../../src/safe-fs.js";

const adapter = (ENGINES as Record<string, EngineAdapter | undefined>)["libosmos"];

const dir = mkdtempSync(join(tmpdir(), "libosmos-asset-flags-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const binary = join(dir, "osmos-api");
writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

const modelsDir = join(dir, "models");
const REL = "asset-family/asset-model.gguf";
mkdirSync(dirname(join(modelsDir, REL)), { recursive: true });
writeFileSync(join(modelsDir, REL), "");
mkdirSync(join(modelsDir, "picks"), { recursive: true });
writeFileSync(join(modelsDir, "picks", "picks.bin"), "");
mkdirSync(join(modelsDir, "dspark", "dspark-iq2xs"), { recursive: true });

const LIBOSMOS = "libosmos" as EngineName;
const BASE_ARGS = ["--max-context", "65536"];

const spec: ModelHostSpecForEngine = {
  engine: LIBOSMOS,
  binary,
  endpoint: { host: "127.0.0.1", port: 8084 },
  hostedModels: [{ rel: REL }],
  extraArgs: BASE_ARGS,
  timeoutSeconds: 60,
};

const prep = (s: ModelHostSpecForEngine, e: EngineBootEnv): Promise<void> =>
  Promise.resolve().then(() => adapter!.prepareLaunch!(s, e));

const bootEnv = (runtimeDir: string, workloadName: string): EngineBootEnv => ({
  LLAMACTL_MODELS_DIR: modelsDir,
  LLAMACTL_RUNTIME_DIR: runtimeDir,
  workloadName,
});

const validation = (extraArgs: string[]): { ok: true } | { ok: false; error: string } =>
  adapter!.validateSpec({ ...spec, extraArgs });

const expectValidationError = (extraArgs: string[], message: string): void => {
  const result = validation(extraArgs);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain(message);
};

const readOsmosJson = (runtimeDir: string, workloadName: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(runtimeDir, "workloads", workloadName, ".osmos", "osmos.json"), "utf8"),
  ) as Record<string, unknown>;

describe("libosmos asset flags", () => {
  test("validateSpec accepts the base launch flags", () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    expect(validation([...BASE_ARGS])).toEqual({ ok: true });
  });

  test("validateSpec rejects --picks when the next token is another flag", () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    expectValidationError([...BASE_ARGS, "--picks", "--no-guess"], "malformed flag: --picks");
  });

  test("validateSpec rejects --dspark when the next token is another flag", () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    expectValidationError([...BASE_ARGS, "--dspark", "--no-guess"], "malformed flag: --dspark");
  });

  test("validateSpec rejects a separate --picks path escaping the models dir", () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    expectValidationError([...BASE_ARGS, "--picks", "../picks.bin"], "escapes models dir");
  });

  test("validateSpec rejects a normalized --dspark path escaping the models dir", () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    expectValidationError([...BASE_ARGS, "--dspark", "a/../../d"], "escapes models dir");
  });

  test("validateSpec rejects an inline --picks path escaping the models dir", () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    expectValidationError([...BASE_ARGS, "--picks=../x"], "escapes models dir");
  });

  test("prepareLaunch rejects a missing --picks asset before writing osmos.json", async () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    const runtimeDir = join(dir, "rt-missing-picks");
    const workloadName = "missing-picks";
    await expect(
      prep(
        { ...spec, extraArgs: [...BASE_ARGS, "--picks", "picks/missing.bin"] },
        bootEnv(runtimeDir, workloadName),
      ),
    ).rejects.toThrow("existing --picks path");
    expect(existsSync(join(runtimeDir, "workloads", workloadName, ".osmos", "osmos.json"))).toBe(
      false,
    );
  });

  test("prepareLaunch rejects a missing relative --dspark asset", async () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    await expect(
      prep(
        { ...spec, extraArgs: [...BASE_ARGS, "--dspark", "dspark/missing"] },
        bootEnv(join(dir, "rt-missing-relative-dspark"), "missing-relative-dspark"),
      ),
    ).rejects.toThrow("existing --dspark path");
  });

  test("prepareLaunch rejects a missing absolute --dspark asset", async () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    await expect(
      prep(
        { ...spec, extraArgs: [...BASE_ARGS, "--dspark", join(dir, "nope-drafter")] },
        bootEnv(join(dir, "rt-missing-absolute-dspark"), "missing-absolute-dspark"),
      ),
    ).rejects.toThrow("existing --dspark path");
  });

  test("validateSpec keeps accepting boolean, inline picks, and directory drafter flags", () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    for (const extraArgs of [
      [...BASE_ARGS, "--no-guess"],
      [...BASE_ARGS, "--picks=picks/picks.bin"],
      [...BASE_ARGS, "--dspark", "dspark/dspark-iq2xs", "--budget", "80"],
    ]) {
      expect(validation(extraArgs)).toEqual({ ok: true });
    }
  });

  test("prepareLaunch maps an existing directory drafter and its budget", async () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    const runtimeDir = join(dir, "rt-existing-drafter");
    const workloadName = "existing-drafter";
    await prep(
      {
        ...spec,
        extraArgs: [...BASE_ARGS, "--dspark", "dspark/dspark-iq2xs", "--budget", "80"],
      },
      bootEnv(runtimeDir, workloadName),
    );
    const parsed = readOsmosJson(runtimeDir, workloadName);
    expect(parsed["drafter"]).toBe(join(modelsDir, "dspark", "dspark-iq2xs"));
    expect(parsed["drafted_budget_gib"]).toBe(80);
  });

  test("prepareLaunch accepts an absolute --picks path to an existing file", async () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    const runtimeDir = join(dir, "rt-absolute-picks");
    const workloadName = "absolute-picks";
    const picks = join(modelsDir, "picks", "picks.bin");
    await prep(
      { ...spec, extraArgs: [...BASE_ARGS, "--picks", picks] },
      bootEnv(runtimeDir, workloadName),
    );
    expect(readOsmosJson(runtimeDir, workloadName)["picks"]).toBe(picks);
  });

  test("prepareLaunch keeps the flag after an inline --picks value", async () => {
    expect(adapter?.name).toBe("libosmos" as EngineName);
    const runtimeDir = join(dir, "rt-inline-picks-no-guess");
    const workloadName = "inline-picks-no-guess";
    await prep(
      { ...spec, extraArgs: [...BASE_ARGS, "--picks=picks/picks.bin", "--no-guess"] },
      bootEnv(runtimeDir, workloadName),
    );
    const parsed = readOsmosJson(runtimeDir, workloadName);
    expect(parsed["picks"]).toBe(join(modelsDir, "picks", "picks.bin"));
    expect(parsed["no_guess"]).toBe(true);
  });
});
