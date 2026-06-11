import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

import type {
  ContextRetrievalDetail,
  JsonOutputFailure,
  LeaderboardRow,
  SubBenchDetail,
  ThroughputDetail,
  ToolCallingFailure,
} from "../../../eval/src/index.js";

import {
  composite,
  killServer,
  queryRows,
  renderCard,
  runContextRetrieval,
  runJsonOutput,
  runThroughput,
  runToolCalling,
  spawnServer,
  upsertRow,
  waitForHealth,
} from "../../../eval/src/index.js";
import { getGlobals } from "../dispatcher.js";
import { required } from "../required.js";

const USAGE = `Usage: llamactl eval <subcommand>

Subcommands:
  run <model> [--node <name>] [--ub <256|512>] [--all] [--url <http://...>]
      Run all four sub-benches against a real llama-server, persist the
      results to SQLite, and write JSON + markdown artifacts under
      $DEV_STORAGE/eval/<run-ts>/.
      With --url, hit a pre-existing remote server (model arg becomes
      just a tag for the leaderboard row; no local spawn or kill).
  report <model>
      Regenerate the markdown report card for <model> from SQLite.
  leaderboard [--node <name>] [--sort-by <field>]
      Print the eval leaderboard table to stdout.
`;

function envValue(name: string): string {
  return process.env[name] ?? "";
}

function ensureEvalRoot(): string {
  const devStorage = envValue("DEV_STORAGE");
  if (!devStorage)
    throw new Error(
      'DEV_STORAGE is not set; run eval "$(bun packages/cli/src/bin.ts env --eval)" first',
    );
  const root = join(devStorage, "eval");
  mkdirSync(root, { recursive: true });
  return root;
}

function modelPathForRel(rel: string): string {
  const models = envValue("LLAMA_CPP_MODELS");
  if (!models) throw new Error("LLAMA_CPP_MODELS is not set");
  return join(models, rel);
}

function parseUb(value: string | undefined): 256 | 512 {
  return value === "256" ? 256 : 512;
}

function toolCallingFailures(
  result: Awaited<ReturnType<typeof runToolCalling>>,
): ToolCallingFailure[] {
  return result.prompts.flatMap<ToolCallingFailure>((prompt) => {
    if (prompt.score.score === 1) return [];
    if (!prompt.score.valid_json) return [{ name: prompt.name, reason: "invalid JSON" }];
    if (prompt.expected.should_call && !prompt.score.correct_decision)
      return [{ name: prompt.name, reason: "no tool_calls" }];
    if (!prompt.score.correct_tool) return [{ name: prompt.name, reason: "wrong tool" }];
    return [{ name: prompt.name, reason: "args mismatch" }];
  });
}

function jsonOutputFailures(
  result: Awaited<ReturnType<typeof runJsonOutput>>,
): JsonOutputFailure[] {
  return result.prompts.flatMap<JsonOutputFailure>((prompt) => {
    if (prompt.valid) return [];
    return [
      {
        name: prompt.name,
        reason: prompt.parsed === null ? "no JSON" : "schema validation failed",
      },
    ];
  });
}

function contextDetails(
  result: Awaited<ReturnType<typeof runContextRetrieval>>,
): ContextRetrievalDetail[] {
  return [
    { depth: 4096, score: result.context_4096_score },
    { depth: 8192, score: result.context_8192_score },
    { depth: 16384, score: result.context_16384_score },
  ];
}

function throughputDetails(result: Awaited<ReturnType<typeof runThroughput>>): {
  mean_tps: number;
  samples: ThroughputDetail[];
} {
  return {
    mean_tps: result.mean_tps,
    samples: result.samples.map((sample) => ({
      name: sample.name,
      predicted_per_second: sample.predicted_per_second,
    })),
  };
}

interface EvalRunFlags {
  ub: 256 | 512;
  all: boolean;
  remoteUrl: string | null;
}

function parseEvalRunFlags(args: string[]): EvalRunFlags | { error: string } | { help: true } {
  let ub: 256 | 512 = 512;
  let all = false;
  let remoteUrl: string | null = null;
  for (let i = 1; i < args.length; i++) {
    const arg = required(args[i]);
    if (arg === "--ub") ub = parseUb(args[++i]);
    else if (arg.startsWith("--ub=")) ub = parseUb(arg.slice("--ub=".length));
    else if (arg === "--all") all = true;
    else if (arg === "--url") remoteUrl = args[++i] ?? null;
    else if (arg.startsWith("--url=")) remoteUrl = arg.slice("--url=".length);
    else if (arg === "-h" || arg === "--help") {
      return { help: true };
    } else {
      return { error: `Unknown flag: ${arg}` };
    }
  }
  return { ub, all, remoteUrl };
}

async function runSingleUb(opts: {
  model: string;
  node: string;
  currentUb: 256 | 512;
  remoteUrl: string | null;
  binary: string;
  modelPath: string;
  runDir: string;
  db: Database;
  runTs: string;
}): Promise<void> {
  const { model, node, currentUb, remoteUrl, binary, modelPath, runDir, db, runTs } = opts;
  const server = remoteUrl
    ? { proc: null, url: remoteUrl, logPath: "" }
    : spawnServer(
        binary,
        { modelPath, port: 18181, ub: currentUb, ctxSize: 20480 },
        join(runDir, `server-ub${String(currentUb)}.log`),
      );
  try {
    if (!remoteUrl && server.proc) await waitForHealth(server.url, server.proc);
    const throughput = await runThroughput(server.url);
    const toolCalling = await runToolCalling(server.url);
    const contextRetrieval = await runContextRetrieval(server.url);
    const jsonOutput = await runJsonOutput(server.url);
    const row = {
      model,
      node,
      ub: currentUb,
      throughput_tps: throughput.mean_tps,
      ttft_ms: throughput.total_wall_ms / Math.max(1, throughput.samples.length),
      tool_call_score: toolCalling.tool_call_score,
      context_8k_score: contextRetrieval.context_8192_score,
      context_16k_score: contextRetrieval.context_16384_score,
      json_score: jsonOutput.json_score,
      composite: composite({
        throughput_tps: throughput.mean_tps,
        tool_call_score: toolCalling.tool_call_score,
        context_8k_score: contextRetrieval.context_8192_score,
        context_16k_score: contextRetrieval.context_16384_score,
        json_score: jsonOutput.json_score,
      }),
      asof: new Date().toISOString(),
    };
    upsertRow(db, row);
    await Bun.write(
      join(runDir, `${basename(model)}-ub${String(currentUb)}.json`),
      JSON.stringify({ throughput, toolCalling, contextRetrieval, jsonOutput, row }, null, 2),
    );
    const subBenches: SubBenchDetail[] = [
      {
        name: "Throughput",
        scores: row,
        throughput: throughputDetails(throughput),
      },
      {
        name: "Tool-Calling",
        scores: row,
        toolCalling: {
          score: toolCalling.tool_call_score,
          failures: toolCallingFailures(toolCalling),
        },
      },
      {
        name: "Context Retrieval",
        scores: row,
        contextRetrieval: {
          scores: contextDetails(contextRetrieval),
        },
      },
      {
        name: "JSON Output",
        scores: row,
        jsonOutput: {
          score: jsonOutput.json_score,
          failures: jsonOutputFailures(jsonOutput),
        },
      },
    ];
    const rows = queryRows(db, { node, sort_by: "composite" }).filter((r) => r.model === model);
    const card = renderCard({
      modelId: model,
      source: {
        ggufPath: modelPath || `(remote: ${String(remoteUrl)})`,
        fileSizeBytes: modelPath ? Bun.file(modelPath).size : 0,
        hfRepo: null,
        hfSha: null,
      },
      hwMatrix: rows,
      subBenches,
    });
    const cardPath = join(
      "docs",
      "superpowers",
      "specs",
      `${runTs.slice(0, 10)}-model-eval-${basename(model, ".gguf")}.md`,
    );
    await Bun.write(cardPath, card);
    process.stdout.write(`${cardPath}\n`);
  } finally {
    if (server.proc) await killServer(server);
  }
}

async function runEvalRun(args: string[]): Promise<number> {
  const model = args[0];
  if (!model) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  // --node is a llamactl-global flag consumed by extractGlobalFlags
  // before this function sees args; read it from the globals store.
  const node = getGlobals().nodeName ?? "local";
  const parsed = parseEvalRunFlags(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  if ("help" in parsed) {
    process.stdout.write(USAGE);
    return 0;
  }

  const evalRoot = ensureEvalRoot();
  const runTs = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const runDir = join(evalRoot, runTs);
  mkdirSync(runDir, { recursive: true });
  const dbPath = join(evalRoot, "leaderboard.sqlite");
  const db = new Database(dbPath);
  const modelPath = parsed.remoteUrl ? "" : modelPathForRel(model);
  if (!parsed.remoteUrl && !existsSync(modelPath)) {
    process.stderr.write(`missing model: ${modelPath}\n`);
    db.close();
    return 1;
  }
  const binaryRoot = envValue("LLAMA_CPP_BIN");
  if (!parsed.remoteUrl && !binaryRoot) {
    process.stderr.write("LLAMA_CPP_BIN is not set\n");
    db.close();
    return 1;
  }
  const binary = parsed.remoteUrl ? "" : join(binaryRoot, "llama-server");
  const ubs: (256 | 512)[] = parsed.all ? [256, 512] : [parsed.ub];
  try {
    for (const currentUb of ubs) {
      await runSingleUb({
        model,
        node,
        currentUb,
        remoteUrl: parsed.remoteUrl,
        binary,
        modelPath,
        runDir,
        db,
        runTs,
      });
    }
    return 0;
  } finally {
    db.close();
  }
}

async function runEvalReport(args: string[]): Promise<number> {
  const model = args[0];
  if (!model) return 1;
  const evalRoot = ensureEvalRoot();
  const db = new Database(join(evalRoot, "leaderboard.sqlite"), { readonly: true });
  try {
    const rows = queryRows(db, { sort_by: "composite" }).filter(
      (row: { model: string }) => row.model === model,
    );
    const best = rows[0];
    const card = renderCard({
      modelId: model,
      source: {
        ggufPath: modelPathForRel(model),
        fileSizeBytes: Bun.file(modelPathForRel(model)).size,
        hfRepo: null,
        hfSha: null,
      },
      hwMatrix: rows,
      subBenches: best
        ? [
            { name: "Throughput", scores: best, throughput: { mean_tps: best.throughput_tps } },
            { name: "Tool-Calling", scores: best, toolCalling: { score: best.tool_call_score } },
            {
              name: "Context Retrieval",
              scores: best,
              contextRetrieval: {
                scores: [
                  { depth: 4096, score: best.context_8k_score },
                  { depth: 8192, score: best.context_8k_score },
                  { depth: 16384, score: best.context_16k_score ?? best.context_8k_score },
                ],
              },
            },
            { name: "JSON Output", scores: best, jsonOutput: { score: best.json_score } },
          ]
        : [],
    });
    const out = join(
      "docs",
      "superpowers",
      "specs",
      `${new Date().toISOString().slice(0, 10)}-model-eval-${basename(model, ".gguf")}.md`,
    );
    await Bun.write(out, card);
    process.stdout.write(`${out}\n`);
    return 0;
  } finally {
    db.close();
  }
}

// eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
async function runEvalLeaderboard(args: string[]): Promise<number> {
  let node = "";
  let sortBy: keyof LeaderboardRow = "composite";
  for (let i = 0; i < args.length; i++) {
    const arg = required(args[i]);
    if (arg === "--node") node = args[++i] ?? "";
    else if (arg.startsWith("--node=")) node = arg.slice("--node=".length);
    else if (arg === "--sort-by") sortBy = parseLeaderboardSort(args[++i] ?? sortBy);
    else if (arg.startsWith("--sort-by="))
      sortBy = parseLeaderboardSort(arg.slice("--sort-by=".length));
  }
  const evalRoot = ensureEvalRoot();
  const db = new Database(join(evalRoot, "leaderboard.sqlite"), { readonly: true });
  try {
    const rows = queryRows(db, { node: node || undefined, sort_by: sortBy });
    const cols = [
      "model",
      "node",
      "ub",
      "throughput_tps",
      "tool_call_score",
      "context_8k_score",
      "context_16k_score",
      "json_score",
      "composite",
      "asof",
    ];
    process.stdout.write(`| ${cols.join(" | ")} |\n`);
    process.stdout.write(`| ${cols.map(() => "---").join(" | ")} |\n`);
    for (const row of rows) {
      process.stdout.write(
        // eslint-disable-next-line eqeqeq -- Preserve existing CLI/test semantics while clearing strict lint debt.
        `| ${row.model} | ${row.node} | ${String(row.ub)} | ${row.throughput_tps.toFixed(2)} | ${row.tool_call_score.toFixed(3)} | ${row.context_8k_score.toFixed(3)} | ${row.context_16k_score == null ? "n/a" : row.context_16k_score.toFixed(3)} | ${row.json_score.toFixed(3)} | ${row.composite.toFixed(3)} | ${row.asof} |\n`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

const LEADERBOARD_SORT_KEYS = new Set<keyof LeaderboardRow>([
  "model",
  "node",
  "ub",
  "throughput_tps",
  "ttft_ms",
  "tool_call_score",
  "context_8k_score",
  "context_16k_score",
  "json_score",
  "composite",
  "asof",
]);

function parseLeaderboardSort(value: string): keyof LeaderboardRow {
  return LEADERBOARD_SORT_KEYS.has(value as keyof LeaderboardRow)
    ? (value as keyof LeaderboardRow)
    : "composite";
}

export async function runEval(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "run":
      return await runEvalRun(rest);
    case "report":
      return await runEvalReport(rest);
    case "leaderboard":
      return await runEvalLeaderboard(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(USAGE);
      return sub === undefined ? 1 : 0;
    default:
      process.stderr.write(`Unknown eval subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}
