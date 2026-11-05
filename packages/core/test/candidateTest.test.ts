import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { RunCli } from "../src/bench/runner.js";
import type { CandidateTestResult } from "../src/candidateTest.js";
import type { RunHf } from "../src/pull.js";

import { defaultModeForRel, machineLabel } from "../src/bench/index.js";
import { writeBenchProfile } from "../src/bench/runner.js";
import { resolveBuildId } from "../src/build.js";
import { candidateTest } from "../src/candidateTest.js";
import { ctxForModel } from "../src/ctx.js";
import { resolveEnv } from "../src/env.js";
import { mkdirSync, readFileSync, writeFileSync } from "../src/safe-fs.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

const REPO = "acme/Demo-GGUF";
const FILE = "Demo-Q4_K_M.gguf";
const REL = "Demo-GGUF/Demo-Q4_K_M.gguf";

let temp: ReturnType<typeof makeTempRuntime>;
let binDir: string;
let originalEnv: NodeJS.ProcessEnv;

function trackerForHf(code = 0): { calls: string[][]; runHf: RunHf } {
  const calls: string[][] = [];
  const runHf: RunHf = (args) => {
    calls.push(args);
    return Promise.resolve(code);
  };
  return { calls, runHf };
}

function trackerForCli(): { calls: string[]; runCli: RunCli } {
  const calls: string[] = [];
  const runCli: RunCli = (bin, args) => {
    calls.push(`${bin} ${args.join(" ")}`);
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return { calls, runCli };
}

async function runCandidate(
  hfCode = 0,
  file?: string,
): Promise<{ cli: string[]; hf: string[][]; result: CandidateTestResult | { error: string } }> {
  const hf = trackerForHf(hfCode);
  const cli = trackerForCli();
  const result = await candidateTest({
    repo: REPO,
    ...(file !== undefined ? { file } : {}),
    env: process.env,
    resolved: resolveEnv(process.env),
    runHf: hf.runHf,
    runCli: cli.runCli,
  });
  return { cli: cli.calls, hf: hf.calls, result };
}

function unwrap(r: CandidateTestResult | { error: string }): CandidateTestResult {
  if ("error" in r) throw new Error(`unexpected error result: ${r.error}`);
  return r;
}

function customCatalogRows(): string[][] {
  const file = process.env["LOCAL_AI_CUSTOM_CATALOG_FILE"] ?? "";
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.split("\t"));
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

function writeModelFile(): string {
  const dir = join(temp.modelsDir, "Demo-GGUF");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, FILE);
  writeFileSync(path, "");
  return path;
}

function writeMmprojFile(): string {
  const dir = join(temp.modelsDir, "Demo-GGUF");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "mmproj-Demo-F16.gguf");
  writeFileSync(path, "");
  return path;
}

describe("candidateTest", () => {
  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    binDir = join(temp.devStorage, "bin");
    mkdirSync(binDir, { recursive: true });
    process.env["LLAMA_CPP_BIN"] = binDir;
    mkdirSync(temp.runtimeDir, { recursive: true });
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test("no file + HF disabled: resolution error, runHf never called", async () => {
    const { result, hf } = await runCandidate();
    expect(result).toEqual({ error: `Unable to resolve a candidate file for ${REPO}` });
    expect(hf).toEqual([]);
  });

  test("unknown rel gains a candidate-scope row labelled with the quant basename", async () => {
    const { result } = await runCandidate(0, FILE);
    const ok = unwrap(result);
    expect(ok.curatedAdded).toBe(true);
    const rows = customCatalogRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.[4]).toBe("candidate");
    expect(rows[0]?.[1]).toBe("Demo-Q4_K_M");
  });

  test("a rel already in the custom catalog is not re-added", async () => {
    prewriteCatalogRow("general");
    const { result } = await runCandidate(0, FILE);
    const ok = unwrap(result);
    expect(ok.curatedAdded).toBe(false);
    expect(customCatalogRows().length).toBe(1);
  });

  test("a failing pull short-circuits before any bench call", async () => {
    const { result, cli } = await runCandidate(3, FILE);
    expect(result).toEqual({ error: `Pull failed (code=3) for ${REL}` });
    expect(cli).toEqual([]);
  });

  test("missing llama-bench skips the preset with a binary-not-found reason", async () => {
    writeModelFile();
    const { result } = await runCandidate(0, FILE);
    const ok = unwrap(result);
    expect(ok.preset).toEqual({
      ran: false,
      reason: `llama-bench binary not found: ${join(binDir, "llama-bench")}`,
    });
    expect(Array.isArray(ok.compare)).toBe(true);
  });

  test("an existing tuned profile for the key skips the preset run", async () => {
    writeBenchBin();
    writeModelFile();
    const resolved = resolveEnv(process.env);
    writeBenchProfile(
      {
        build: resolveBuildId(resolved),
        ctx: ctxForModel(REL, resolved),
        gen_ts: "10",
        machine: machineLabel(resolved),
        mode: defaultModeForRel(REL, resolved),
        profile: "default",
        prompt_ts: "5",
        rel: REL,
      },
      resolved,
    );
    const { result, cli } = await runCandidate(0, FILE);
    const ok = unwrap(result);
    expect(ok.preset.ran).toBe(false);
    expect(ok.preset.reason?.startsWith(`Reusing tuned profile for ${REL}`)).toBe(true);
    expect(cli).toEqual([]);
  });

  test("a preset failure short-circuits the whole flow", async () => {
    writeBenchBin();
    const missingPath = join(temp.modelsDir, REL);
    const { result } = await runCandidate(0, FILE);
    expect(result).toEqual({ error: `Model file not found: ${missingPath}` });
    expect("vision" in result).toBe(false);
    expect("compare" in result).toBe(false);
  });

  test("class-general rel without an mmproj skips vision as not multimodal", async () => {
    writeBenchBin();
    writeModelFile();
    const { result } = await runCandidate(0, FILE);
    const ok = unwrap(result);
    expect(ok.vision).toEqual({ ran: false, reason: "Not multimodal (class=general)" });
  });

  test("a local mmproj sibling makes a class-general rel multimodal", async () => {
    writeMmprojFile();
    const { result } = await runCandidate(0, FILE);
    const ok = unwrap(result);
    expect(ok.vision.ran).toBe(false);
    expect(ok.vision.reason).toBe(
      `llama-mtmd-cli binary not found: ${join(binDir, "llama-mtmd-cli")}`,
    );
  });

  test("vision auto-bench off skips the vision step", async () => {
    writeMtmdBin();
    writeMmprojFile();
    process.env["LLAMA_CPP_AUTO_BENCH_VISION"] = "off";
    const { result } = await runCandidate(0, FILE);
    const ok = unwrap(result);
    expect(ok.vision.ran).toBe(false);
    expect(ok.vision.reason).toBe("LLAMA_CPP_AUTO_BENCH_VISION=off");
  });

  test("catalog class multimodal without a local mmproj names the missing sibling", async () => {
    prewriteCatalogRow("multimodal");
    writeMtmdBin();
    const { result } = await runCandidate(0, FILE);
    const ok = unwrap(result);
    expect(ok.vision.ran).toBe(false);
    expect(ok.vision.reason).toBe(`No local mmproj sibling for ${REL}`);
  });

  test("a vision error is a skip reason and does not fail the flow", async () => {
    writeMtmdBin();
    writeMmprojFile();
    const missingPath = join(temp.modelsDir, REL);
    const { result } = await runCandidate(0, FILE);
    const ok = unwrap(result);
    expect(ok.vision.ran).toBe(false);
    expect(ok.vision.reason).toBe(`Model file not found: ${missingPath}`);
    expect(Array.isArray(ok.compare)).toBe(true);
  });
});
