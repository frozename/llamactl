// Part of #522 — RED tests pinning the pre-spawn launch refusal in
// `maybeTuneAfterPull` (packages/core/src/autotune.ts). At the pinned base the
// post-pull auto-tune goes straight from the skip checks to `benchPreset` /
// `benchVision` with no `launchRefusal` gate, so a caller-injected refusal —
// the exclusive-group refusal the CLI and agent wire in — is ignored and a
// bench spawns beside the occupied group. Post-fix the new `launchRefusal`
// option is consulted immediately before `benchPreset`: a refusal string
// records the preset step as `{ ran: false, reason: { kind: "launch-refused",
// message } }`, the vision step as `{ ran: false, reason: { kind:
// "auto-vision-disabled", message: "Not evaluated" } }`, and no `runCli`
// invocation happens. Everything is hermetic: temp dirs, an injected runCli
// that returns canned llama-bench JSON, a spy standing in for the gate, and
// no real processes. The killing cases fail BY ASSERTION at base — never by
// import, type or exit code; the guards pass at base and after the fix.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { RunCli } from "../src/bench/runner.js";

import { maybeTuneAfterPull } from "../src/autotune.js";
import { mkdirSync, writeFileSync } from "../src/safe-fs.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

const rel = "Demo/demo.gguf";

type TuneOptions = Parameters<typeof maybeTuneAfterPull>[0] & {
  launchRefusal?: (rel: string) => string | null;
};

function cannedRunCli(counter: { calls: number }): RunCli {
  return () => {
    counter.calls += 1;
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ n_gen: 64, n_prompt: 0, avg_ts: 25.0 }),
      stderr: "",
    });
  };
}

describe("maybeTuneAfterPull launch refusal", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    // The auto flags default to on; an operator shell set to off would skip
    // the bench before the gate ever runs.
    for (const key of [
      "LLAMA_CPP_AUTO_TUNE_ON_PULL",
      "LLAMA_CPP_AUTO_BENCH_VISION",
      "LOCAL_AI_BENCH_IMAGE",
      "LOCAL_AI_HF_BIN",
    ]) {
      Reflect.deleteProperty(process.env, key);
    }
    // Stand up a fake llama-bench binary so the binary existence check
    // passes deterministically.
    const binDir = join(temp.devStorage, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "llama-bench"), "");
    process.env["LLAMA_CPP_BIN"] = binDir;
    // And the model file so benchPreset's existence check passes.
    const modelDir = join(temp.modelsDir, "Demo");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "demo.gguf"), "");
    mkdirSync(temp.runtimeDir, { recursive: true });
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  // Kills: no gate, or the gate placed after benchPreset — at base the option
  // is ignored, benchPreset runs its 3 profiles (runCli called 3 times,
  // preset.ran true) and the spy is never consulted.
  test("A1: a launch refusal skips the preset bench before any runCli call", async () => {
    const seen: string[] = [];
    const counter = { calls: 0 };
    const opts: TuneOptions = {
      rel,
      wasMissing: true,
      runCli: cannedRunCli(counter),
      launchRefusal: (target) => {
        seen.push(target);
        return "refused-by-test";
      },
    };
    const report = await maybeTuneAfterPull(opts);
    // `as unknown`: the launch-refused kind does not exist in the base
    // MaybeTuneSkipReason union — the pin must fail by assertion, not type.
    expect(report.preset as unknown).toEqual({
      ran: false,
      reason: { kind: "launch-refused", message: "refused-by-test" },
    });
    expect(report.vision).toEqual({
      ran: false,
      reason: { kind: "auto-vision-disabled", message: "Not evaluated" },
    });
    expect(counter.calls).toBe(0);
    expect(seen).toEqual([rel]);
  });

  // Guard: a hook returning null must not change the bench — the preset runs
  // its 3 profiles and reports ran. Passes at base (option ignored) and after
  // the fix (gate consulted, clear).
  test("A2: a clear launchRefusal still runs the preset bench", async () => {
    const counter = { calls: 0 };
    const opts: TuneOptions = {
      rel,
      wasMissing: true,
      runCli: cannedRunCli(counter),
      launchRefusal: () => null,
    };
    const report = await maybeTuneAfterPull(opts);
    expect(counter.calls).toBe(3);
    expect(report.preset.ran).toBe(true);
  });

  // Guard: the wasMissing skip returns before any gate could run, so the hook
  // is never consulted. Passes at base and after the fix.
  test("A3: wasMissing false never consults launchRefusal", async () => {
    const seen: string[] = [];
    const counter = { calls: 0 };
    const opts: TuneOptions = {
      rel,
      wasMissing: false,
      runCli: cannedRunCli(counter),
      launchRefusal: (target) => {
        seen.push(target);
        return "refused-by-test";
      },
    };
    const report = await maybeTuneAfterPull(opts);
    expect(report.preset.ran).toBe(false);
    if (!report.preset.ran) {
      expect(report.preset.reason.kind).toBe("not-missing");
    }
    expect(seen).toEqual([]);
    expect(counter.calls).toBe(0);
  });
});
