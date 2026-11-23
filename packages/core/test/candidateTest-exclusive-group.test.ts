// Part of #517 — RED tests pinning the pre-spawn exclusive-group refusal in
// `candidateTest` (packages/core/src/candidateTest.ts). At the pinned base
// `runPresetStep` / `runVisionStep` go straight from their skip checks to
// `benchPreset` / `benchVision` with no residency gate, so an occupied
// exclusive group gets a bench spawned beside it. Post-fix the new
// `launchRefusal` option is consulted immediately before each bench call: a
// refusal string records the step as `{ ran: false, reason: <refusal> }` and
// no `runCli` invocation happens. Everything is hermetic: temp dirs, an
// injected runHf that returns 0, an injected runCli that returns canned
// llama-bench JSON, a spy standing in for the gate, and no real processes. At
// base every case fails BY ASSERTION — never by import, type or exit code.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { RunCli } from "../src/bench/runner.js";
import type { CandidateTestResult } from "../src/candidateTest.js";
import type { RunHf } from "../src/pull.js";

import { candidateTest } from "../src/candidateTest.js";
import { resolveEnv } from "../src/env.js";
import { mkdirSync, writeFileSync } from "../src/safe-fs.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

const REPO = "acme/Demo-GGUF";
const FILE = "Demo-Q4_K_M.gguf";
const REL = "Demo-GGUF/Demo-Q4_K_M.gguf";
const REFUSAL = `residency lifecycle refused ${REL} downloaded -> loading: ExclusiveGroupOccupied: exclusive group g is held by peer in state ready`;

type CandidateOptions = Parameters<typeof candidateTest>[0] & {
  launchRefusal?: (rel: string) => string | null;
};

let temp: ReturnType<typeof makeTempRuntime>;
let binDir: string;
let originalEnv: NodeJS.ProcessEnv;
let bins: string[];

function trackerForHf(code = 0): RunHf {
  return () => Promise.resolve(code);
}

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

function prewriteCatalogRow(klass: string): void {
  const file = process.env["LOCAL_AI_CUSTOM_CATALOG_FILE"] ?? "";
  writeFileSync(
    file,
    ["demo-q4-k-m", "Demo Q4", "custom", klass, "candidate", REL, REPO, "gguf"].join("\t") + "\n",
  );
}

function writeBenchBin(): void {
  writeFileSync(join(binDir, "llama-bench"), "");
}

function writeMtmdBin(): void {
  writeFileSync(join(binDir, "llama-mtmd-cli"), "");
}

function writeModelFile(): void {
  const dir = join(temp.modelsDir, "Demo-GGUF");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILE), "");
}

function writeMmprojFile(): void {
  const dir = join(temp.modelsDir, "Demo-GGUF");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "mmproj-Demo-F16.gguf"), "");
}

async function runCandidate(spy: {
  calls: string[];
  fn: (rel: string) => string | null;
}): Promise<CandidateTestResult | { error: string }> {
  const opts: CandidateOptions = {
    repo: REPO,
    file: FILE,
    env: process.env,
    resolved: resolveEnv(process.env),
    runHf: trackerForHf(),
    runCli: runCli(),
    launchRefusal: spy.fn,
  };
  return await candidateTest(opts);
}

describe("candidateTest exclusive-group refusal", () => {
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
    binDir = join(temp.devStorage, "bin");
    mkdirSync(binDir, { recursive: true });
    process.env["LLAMA_CPP_BIN"] = binDir;
    mkdirSync(temp.runtimeDir, { recursive: true });
    bins = [];
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  // Kills: no gate before benchPreset in runPresetStep — at base the preset
  // runs (ran true, 3 llama-bench calls) and the spy is never consulted.
  test("C1: an occupied exclusive group skips the preset step", async () => {
    writeBenchBin();
    writeModelFile();
    const spy = refusalSpy([REFUSAL]);
    const result = await runCandidate(spy);
    if ("error" in result) throw new Error(`unexpected error result: ${result.error}`);
    expect(result.preset).toEqual({ ran: false, reason: REFUSAL });
    expect(bins.filter((bin) => bin.endsWith("llama-bench"))).toEqual([]);
    expect(spy.calls).toEqual([REL]);
  });

  // Kills: no gate before benchVision in runVisionStep — at base the second
  // spy call never happens and llama-mtmd-cli is spawned.
  test("C2: an occupied exclusive group skips the vision step after the preset runs", async () => {
    prewriteCatalogRow("multimodal");
    writeBenchBin();
    writeMtmdBin();
    writeModelFile();
    writeMmprojFile();
    const spy = refusalSpy([null, REFUSAL]);
    const result = await runCandidate(spy);
    if ("error" in result) throw new Error(`unexpected error result: ${result.error}`);
    expect(result.preset.ran).toBe(true);
    expect(result.vision).toEqual({ ran: false, reason: REFUSAL });
    expect(bins.filter((bin) => bin.endsWith("llama-mtmd-cli"))).toEqual([]);
    expect(spy.calls).toEqual([REL, REL]);
  });
});
