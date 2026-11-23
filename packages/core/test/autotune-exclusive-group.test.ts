// Part of #517 — RED tests pinning the pre-spawn exclusive-group refusal in
// `maybeTuneAfterPull` (packages/core/src/autotune.ts). At the pinned base the
// post-pull auto-tune goes straight from the skip checks to `benchPreset` /
// `benchVision` with no residency gate, so an occupied exclusive group gets a
// bench spawned beside it. Post-fix the new `launchRefusal` option is consulted
// immediately before each bench call: a refusal string records the preset or
// vision step as `{ ran: false, reason: { kind: "exclusive-group-occupied",
// message } }` and no `runCli` invocation happens. Everything is hermetic:
// temp dirs, an injected runCli that returns canned llama-bench JSON, a spy
// standing in for the gate, and no real processes. At base every case fails BY
// ASSERTION — never by import, type or exit code.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { RunCli } from "../src/bench/runner.js";

import { maybeTuneAfterPull } from "../src/autotune.js";
import { mkdirSync, writeFileSync } from "../src/safe-fs.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

const rel = "Demo/demo.gguf";
const REFUSAL =
  "residency lifecycle refused Demo/demo.gguf downloaded -> loading: ExclusiveGroupOccupied: exclusive group g is held by peer in state ready";

type TuneOptions = Parameters<typeof maybeTuneAfterPull>[0] & {
  launchRefusal?: (rel: string) => string | null;
};

function refusalSpy(results: readonly (string | null)[]): {
  calls: string[];
  fn: (rel: string) => string | null;
} {
  const calls: string[] = [];
  const queue = [...results];
  const fn = (target: string): string | null => {
    calls.push(target);
    return queue.length > 0 ? (queue.shift() ?? null) : null;
  };
  return { calls, fn };
}

describe("maybeTuneAfterPull exclusive-group refusal", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;
  let bins: string[];

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
    const binDir = join(temp.devStorage, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "llama-bench"), "");
    process.env["LLAMA_CPP_BIN"] = binDir;
    const modelDir = join(temp.modelsDir, "Demo");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "demo.gguf"), "");
    mkdirSync(temp.runtimeDir, { recursive: true });
    bins = [];
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  function runCli(): RunCli {
    return (bin) => {
      bins.push(bin);
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ n_gen: 64, n_prompt: 0, avg_ts: 25.0 }),
        stderr: "",
      });
    };
  }

  // Kills: no gate before benchPreset in maybeTuneAfterPull — at base the
  // option is ignored, the preset runs (ran true, 3 llama-bench calls) and
  // the spy is never consulted.
  test("A1: an occupied exclusive group skips the preset bench", async () => {
    const spy = refusalSpy([REFUSAL]);
    const opts: TuneOptions = { rel, wasMissing: true, runCli: runCli(), launchRefusal: spy.fn };
    const report = await maybeTuneAfterPull(opts);
    expect(report.preset).toEqual({
      ran: false,
      reason: { kind: "exclusive-group-occupied", message: REFUSAL },
    });
    expect(bins).toEqual([]);
    expect(spy.calls).toEqual([rel]);
  });

  // Kills: the gate is never consulted, or consulted with a different id —
  // at base the spy records no calls.
  test("A2: a clear gate lets the preset bench run", async () => {
    const spy = refusalSpy([null]);
    const opts: TuneOptions = { rel, wasMissing: true, runCli: runCli(), launchRefusal: spy.fn };
    const report = await maybeTuneAfterPull(opts);
    expect(spy.calls).toEqual([rel]);
    expect(report.preset.ran).toBe(true);
    expect(bins).toHaveLength(3);
  });

  // Kills: no gate before benchVision in maybeVisionBenchAfterPull — at base
  // the second spy call never happens and llama-mtmd-cli is spawned.
  test("A3: an occupied exclusive group skips the vision bench after the preset runs", async () => {
    writeFileSync(
      process.env["LOCAL_AI_CUSTOM_CATALOG_FILE"] ?? "",
      [
        "demo-mm",
        "Demo MM",
        "custom",
        "multimodal",
        "candidate",
        rel,
        "acme/Demo-GGUF",
        "gguf",
      ].join("\t") + "\n",
    );
    writeFileSync(join(temp.modelsDir, "Demo", "mmproj-demo-F16.gguf"), "");
    writeFileSync(join(temp.devStorage, "bin", "llama-mtmd-cli"), "");
    const spy = refusalSpy([null, REFUSAL]);
    const opts: TuneOptions = { rel, wasMissing: true, runCli: runCli(), launchRefusal: spy.fn };
    const report = await maybeTuneAfterPull(opts);
    expect(report.preset.ran).toBe(true);
    expect(report.vision).toEqual({
      ran: false,
      reason: { kind: "exclusive-group-occupied", message: REFUSAL },
    });
    expect(bins.filter((bin) => bin.endsWith("llama-mtmd-cli"))).toEqual([]);
    expect(spy.calls).toEqual([rel, rel]);
  });
});
