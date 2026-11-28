import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveManagedLaunchCalibrationKey } from "../../src/residency/launch-calibration.js";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

test("Kapitsa fingerprints the selected model and DFlash bundle contents by generation", () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-calibration-assets-"));
  try {
    const model = join(dir, "model");
    const draft = join(dir, "dflash2");
    mkdirSync(model);
    mkdirSync(draft);
    const binary = join(dir, "kapitsa");
    const draftWeights = join(draft, "weights.bin");
    copyFileSync("/usr/bin/false", binary);
    writeFileSync(join(model, "weights.bin"), "model");
    writeFileSync(draftWeights, "draft");
    const input = {
      engine: "kapitsa" as const,
      binary,
      args: [
        "serve",
        "--model",
        model,
        "--dflash",
        draft,
        "--mem-budget",
        "20",
        "--context",
        "131072",
        "--slots",
        "2",
        "--prefill-chunk",
        "2048",
        "--local",
      ],
      env: {},
    };
    const key = deriveManagedLaunchCalibrationKey(input, "fixture-owner");
    expect(key?.managedLaunchDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveManagedLaunchCalibrationKey(input, "foreign-owner")).not.toEqual(key);
    writeFileSync(draftWeights, "different draft generation");
    expect(deriveManagedLaunchCalibrationKey(input, "fixture-owner")).not.toEqual(key);
    expect(
      deriveManagedLaunchCalibrationKey(
        {
          ...input,
          args: [...input.args, "--config", join(dir, "mutable.yaml")],
        },
        "fixture-owner",
      ),
    ).toBeUndefined();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a sharded ModelRun key requires and covers every local shard", () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-calibration-shards-"));
  try {
    const first = join(dir, "weights-00001-of-00002.gguf");
    const second = join(dir, "weights-00002-of-00002.gguf");
    const binary = join(dir, "llama-server");
    copyFileSync("/usr/bin/false", binary);
    writeFileSync(first, "shard one");
    const input = {
      engine: "llamacpp" as const,
      binary,
      args: ["-m", first, "-ctk", "q8_0", "-ctv", "q8_0", "-ub", "512"],
      env: {},
    };
    expect(deriveManagedLaunchCalibrationKey(input, "fixture-owner")).toBeUndefined();
    writeFileSync(second, "shard two");
    const key = deriveManagedLaunchCalibrationKey(input, "fixture-owner");
    expect(key?.managedLaunchDigest).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(second, "different second shard");
    expect(deriveManagedLaunchCalibrationKey(input, "fixture-owner")).not.toEqual(key);
    expect(
      deriveManagedLaunchCalibrationKey(
        {
          ...input,
          env: { LLAMA_ARG_MODEL: "implicit.gguf" },
        },
        "fixture-owner",
      ),
    ).toBeUndefined();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("an opaque script launcher has no verifiable native engine generation", () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-calibration-wrapper-"));
  try {
    const binary = join(dir, "llama-server");
    const weights = join(dir, "weights.gguf");
    writeFileSync(binary, `#!/bin/sh\nexec ./another-build "$@"\n`);
    writeFileSync(weights, "weights");
    expect(
      deriveManagedLaunchCalibrationKey(
        {
          engine: "llamacpp",
          binary,
          args: ["-m", weights],
          env: {},
        },
        "fixture-owner",
      ),
    ).toBeUndefined();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
