import { type LeaderboardRow, upsertRow } from "@llamactl/eval";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runEval } from "../src/commands/eval.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { captureProcessStreams } from "./helpers.js";

const savedDevStorage = process.env["DEV_STORAGE"];
const savedLlamaCppModels = process.env["LLAMA_CPP_MODELS"];
const savedLlamaCppBin = process.env["LLAMA_CPP_BIN"];

let tmpDir = "";
let devStorage = "";
let modelsDir = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "llamactl-eval-test-"));
  devStorage = join(tmpDir, "storage");
  modelsDir = join(tmpDir, "models");
  process.env["DEV_STORAGE"] = devStorage;
  process.env["LLAMA_CPP_MODELS"] = modelsDir;
  delete process.env["LLAMA_CPP_BIN"];
});

afterEach(() => {
  if (savedDevStorage === undefined) delete process.env["DEV_STORAGE"];
  else process.env["DEV_STORAGE"] = savedDevStorage;
  if (savedLlamaCppModels === undefined) delete process.env["LLAMA_CPP_MODELS"];
  else process.env["LLAMA_CPP_MODELS"] = savedLlamaCppModels;
  if (savedLlamaCppBin === undefined) delete process.env["LLAMA_CPP_BIN"];
  else process.env["LLAMA_CPP_BIN"] = savedLlamaCppBin;
  rmSync(tmpDir, { recursive: true, force: true });
});

const rowA: LeaderboardRow = {
  model: "a.gguf",
  node: "n1",
  ub: 512,
  throughput_tps: 12.345,
  ttft_ms: 10,
  tool_call_score: 0.5,
  context_8k_score: 0.25,
  context_16k_score: null,
  json_score: 1,
  composite: 0.9,
  asof: "2026-01-01T00:00:00.000Z",
};

const rowB: LeaderboardRow = {
  model: "b.gguf",
  node: "n2",
  ub: 256,
  throughput_tps: 50,
  ttft_ms: 20,
  tool_call_score: 0.75,
  context_8k_score: 0.5,
  context_16k_score: 0.125,
  json_score: 0.5,
  composite: 0.4,
  asof: "2026-01-02T00:00:00.000Z",
};

function seedLeaderboard(): string {
  const evalDir = join(devStorage, "eval");
  mkdirSync(evalDir, { recursive: true });
  const dbPath = join(evalDir, "leaderboard.sqlite");
  const db = new Database(dbPath);
  upsertRow(db, rowA);
  upsertRow(db, rowB);
  db.close();
  return dbPath;
}

test("dispatch: no args returns 1 with usage", async () => {
  const { result, stdout } = await captureProcessStreams(() => runEval([]));
  expect(result).toBe(1);
  expect(stdout).toContain("Usage: llamactl eval <subcommand>");
});

test("dispatch: help variants return 0 with usage", async () => {
  const { result, stdout } = await captureProcessStreams(() => runEval(["help"]));
  expect(result).toBe(0);
  expect(stdout).toContain("Usage: llamactl eval <subcommand>");

  const { result: result2, stdout: stdout2 } = await captureProcessStreams(() =>
    runEval(["--help"]),
  );
  expect(result2).toBe(0);
  expect(stdout2).toContain("Usage: llamactl eval <subcommand>");

  const { result: result3, stdout: stdout3 } = await captureProcessStreams(() => runEval(["-h"]));
  expect(result3).toBe(0);
  expect(stdout3).toContain("Usage: llamactl eval <subcommand>");
});

test("dispatch: unknown subcommand returns 1 with error", async () => {
  const { result, stderr } = await captureProcessStreams(() => runEval(["bogus"]));
  expect(result).toBe(1);
  expect(stderr).toContain("Unknown eval subcommand: bogus");
});

test("run: no model arg prints usage to stderr, no filesystem side effects", async () => {
  const { result, stderr } = await captureProcessStreams(() => runEval(["run"]));
  expect(result).toBe(1);
  expect(stderr).toContain("Usage: llamactl eval <subcommand>");
  expect(existsSync(join(devStorage, "eval"))).toBe(false);
});

test("run: unknown flag rejected before filesystem side effects", async () => {
  const { result, stderr } = await captureProcessStreams(() =>
    runEval(["run", "m.gguf", "--bogus"]),
  );
  expect(result).toBe(1);
  expect(stderr).toContain("Unknown flag: --bogus");
  expect(existsSync(join(devStorage, "eval"))).toBe(false);
});

test("run: --help returns 0 with usage, no filesystem side effects", async () => {
  const { result, stdout } = await captureProcessStreams(() =>
    runEval(["run", "m.gguf", "--help"]),
  );
  expect(result).toBe(0);
  expect(stdout).toContain("Usage: llamactl eval <subcommand>");
  expect(existsSync(join(devStorage, "eval"))).toBe(false);
});

test("run: missing model file errors after root and DB are created", async () => {
  const { result, stderr } = await captureProcessStreams(() => runEval(["run", "org/m.gguf"]));
  expect(result).toBe(1);
  expect(stderr).toContain(`missing model: ${join(modelsDir, "org/m.gguf")}`);
  const evalDir = join(devStorage, "eval");
  expect(existsSync(evalDir)).toBe(true);
  expect(existsSync(join(evalDir, "leaderboard.sqlite"))).toBe(true);
});

test("run: LLAMA_CPP_BIN not set errors", async () => {
  mkdirSync(join(modelsDir, "org"), { recursive: true });
  writeFileSync(join(modelsDir, "org", "m.gguf"), "", { flag: "w" });

  const { result, stderr } = await captureProcessStreams(() => runEval(["run", "org/m.gguf"]));
  expect(result).toBe(1);
  expect(stderr).toContain("LLAMA_CPP_BIN is not set");
});

test("leaderboard: DEV_STORAGE guard", async () => {
  const saved = process.env["DEV_STORAGE"];
  delete process.env["DEV_STORAGE"];
  try {
    // eslint-disable-next-line @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- bun:test expect(...).rejects is not typed as a Thenable.
    await expect(runEval(["leaderboard"])).rejects.toThrow("DEV_STORAGE is not set");
  } finally {
    if (saved === undefined) delete process.env["DEV_STORAGE"];
    else process.env["DEV_STORAGE"] = saved;
  }
});

test("leaderboard: renders rows with correct formatting", async () => {
  seedLeaderboard();

  const { result, stdout } = await captureProcessStreams(() => runEval(["leaderboard"]));
  expect(result).toBe(0);
  expect(stdout.split("\n")).toEqual([
    "| model | node | ub | throughput_tps | tool_call_score | context_8k_score | context_16k_score | json_score | composite | asof |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "| a.gguf | n1 | 512 | 12.35 | 0.500 | 0.250 | n/a | 1.000 | 0.900 | 2026-01-01T00:00:00.000Z |",
    "| b.gguf | n2 | 256 | 50.00 | 0.750 | 0.500 | 0.125 | 0.500 | 0.400 | 2026-01-02T00:00:00.000Z |",
    "",
  ]);
});

test("leaderboard: --sort-by throughput_tps orders B first", async () => {
  seedLeaderboard();

  const { stdout: stdoutSep } = await captureProcessStreams(() =>
    runEval(["leaderboard", "--sort-by", "throughput_tps"]),
  );
  const linesSep = stdoutSep.split("\n");
  expect(linesSep[2]).toBe(
    "| b.gguf | n2 | 256 | 50.00 | 0.750 | 0.500 | 0.125 | 0.500 | 0.400 | 2026-01-02T00:00:00.000Z |",
  );

  const { stdout: stdoutEq } = await captureProcessStreams(() =>
    runEval(["leaderboard", "--sort-by=throughput_tps"]),
  );
  const linesEq = stdoutEq.split("\n");
  expect(linesEq[2]).toBe(
    "| b.gguf | n2 | 256 | 50.00 | 0.750 | 0.500 | 0.125 | 0.500 | 0.400 | 2026-01-02T00:00:00.000Z |",
  );
});

test("leaderboard: --sort-by unknown falls back to composite (A first)", async () => {
  seedLeaderboard();

  const { result, stdout } = await captureProcessStreams(() =>
    runEval(["leaderboard", "--sort-by", "nope"]),
  );
  expect(result).toBe(0);
  const lines = stdout.split("\n");
  expect(lines[2]).toBe(
    "| a.gguf | n1 | 512 | 12.35 | 0.500 | 0.250 | n/a | 1.000 | 0.900 | 2026-01-01T00:00:00.000Z |",
  );
});

test("leaderboard: SQL injection in --sort-by is harmless, table survives", async () => {
  const dbPath = seedLeaderboard();

  const { result } = await captureProcessStreams(() =>
    runEval(["leaderboard", "--sort-by", "model; DROP TABLE leaderboard"]),
  );
  expect(result).toBe(0);

  const verifyDb = new Database(dbPath, { readonly: true });
  const counts = verifyDb.query("SELECT COUNT(*) AS n FROM leaderboard").all() as {
    n: number;
  }[];
  expect(counts[0]?.n).toBe(2);
  verifyDb.close();
});

test("leaderboard: --node filters to matching row", async () => {
  seedLeaderboard();

  const { stdout: stdoutN2 } = await captureProcessStreams(() =>
    runEval(["leaderboard", "--node", "n2"]),
  );
  expect(stdoutN2.split("\n")).toEqual([
    "| model | node | ub | throughput_tps | tool_call_score | context_8k_score | context_16k_score | json_score | composite | asof |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "| b.gguf | n2 | 256 | 50.00 | 0.750 | 0.500 | 0.125 | 0.500 | 0.400 | 2026-01-02T00:00:00.000Z |",
    "",
  ]);

  const { stdout: stdoutN1Eq } = await captureProcessStreams(() =>
    runEval(["leaderboard", "--node=n1"]),
  );
  expect(stdoutN1Eq.split("\n")).toEqual([
    "| model | node | ub | throughput_tps | tool_call_score | context_8k_score | context_16k_score | json_score | composite | asof |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "| a.gguf | n1 | 512 | 12.35 | 0.500 | 0.250 | n/a | 1.000 | 0.900 | 2026-01-01T00:00:00.000Z |",
    "",
  ]);
});

test("leaderboard: missing DB throws", async () => {
  mkdirSync(join(devStorage, "eval"), { recursive: true });
  // eslint-disable-next-line @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- bun:test expect(...).rejects is not typed as a Thenable.
  await expect(runEval(["leaderboard"])).rejects.toThrow();
});
