import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";

import type { WorkloadEval } from "../types.js";

export const KV_WARM_BENCH_FRONTIERS = [2048, 4096, 8192, 16384, 32768] as const;
export const KV_WARM_BENCH_DEFAULT_PROXY_BASE_URL = "http://127.0.0.1:8089";
export const KV_WARM_BENCH_DEFAULT_MARKDOWN_PATH =
  "docs/benchmarks/2026-05-24-kv-warm-restore-template.md";

const KV_WARM_BENCH_CSV_HEADER =
  "promptSize,t_cold_ms,t_cold_first_byte_ms,t_warm_min_ms,t_warm_p50_ms,t_warm_p95_ms,ratio_cold_over_warm,kv_warm_hit_total,kv_cold_miss_total,kv_false_hit_total";

export interface KvWarmBenchArgs {
  proxyBaseUrl?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  frontiers?: number[];
  warmRuns?: number;
  dataRoot?: string;
  outPath?: string;
  seed?: number;
}

export interface KvWarmBenchRequestTiming {
  firstByteMs: number;
  completeMs: number;
}

export interface KvWarmBenchCounterSnapshot {
  kv_warm_hit_total: number;
  kv_cold_miss_total: number;
  kv_false_hit_total: number;
}

export interface KvWarmBenchRow {
  promptSize: number;
  tColdMs: number;
  tColdFirstByteMs: number;
  tWarmMinMs: number;
  tWarmP50Ms: number;
  tWarmP95Ms: number;
  ratioColdOverWarm: number;
  kvWarmHitTotal: number;
  kvColdMissTotal: number;
  kvFalseHitTotal: number;
}

export interface KvWarmBenchMarkdownInput {
  generatedAtIso: string;
  model: string;
  proxyBaseUrl: string;
  machine: string;
  os: string;
  frontiers: number[];
  warmRuns: number;
  rows: KvWarmBenchRow[];
}

interface NormalizedKvWarmBenchArgs {
  proxyBaseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  frontiers: number[];
  warmRuns: number;
  dataRoot: string;
  outPath: string;
  seed: number;
}

function stableToken(seed: number, index: number): string {
  let x = (seed ^ (index * 0x45d9f3b)) >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return `t${x.toString(36).padStart(7, "0")}`;
}

function buildPromptWithStableWords(seed: number, wordCount: number): string {
  const safeWordCount = Math.max(1, Math.floor(wordCount));
  const tokens: string[] = [];
  for (let i = 0; i < safeWordCount; i += 1) {
    tokens.push(stableToken(seed, i));
  }
  return `KV-WARM-BENCH-SEED=${seed}\n${tokens.join(" ")}`;
}

export function buildDeterministicPrompt(opts: { approxTokens: number; seed?: number }): string {
  const approxTokens = Math.max(16, Math.floor(opts.approxTokens));
  const seed = opts.seed ?? 11;
  return buildPromptWithStableWords(seed, approxTokens);
}

export const KV_WARM_BENCH_TOKENIZE_FALLBACK_WARNING =
  "kv-warm-bench: /v1/tokenize unavailable; interpreting --frontiers as approximate word counts";

export type KvWarmBenchTokenize = (prompt: string) => Promise<number>;

export async function createTokenizeClient(args: {
  proxyBaseUrl: string;
  model: string;
  onWarn?: (message: string) => void;
}): Promise<KvWarmBenchTokenize | null> {
  const endpoint = `${args.proxyBaseUrl}/v1/tokenize`;
  const warn =
    args.onWarn ??
    ((message: string) => {
      console.warn(message);
    });
  const probe = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: args.model,
      prompt: buildDeterministicPrompt({ approxTokens: 16, seed: 11 }),
    }),
  });
  if (!probe.ok) {
    warn(KV_WARM_BENCH_TOKENIZE_FALLBACK_WARNING);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = await probe.json();
  } catch {
    warn(KV_WARM_BENCH_TOKENIZE_FALLBACK_WARNING);
    return null;
  }
  const probeTokens =
    typeof (parsed as { n_tokens?: unknown }).n_tokens === "number"
      ? Math.floor((parsed as { n_tokens: number }).n_tokens)
      : Number.NaN;
  if (!Number.isFinite(probeTokens) || probeTokens <= 0) {
    warn(KV_WARM_BENCH_TOKENIZE_FALLBACK_WARNING);
    return null;
  }
  return async (prompt: string) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: args.model, prompt }),
    });
    if (!response.ok) {
      throw new Error(
        `kv-warm-bench: HTTP ${response.status} from ${endpoint}: ${await response.text()}`,
      );
    }
    const payload = (await response.json()) as { n_tokens?: unknown };
    const nTokens =
      typeof payload.n_tokens === "number" ? Math.floor(payload.n_tokens) : Number.NaN;
    if (!Number.isFinite(nTokens) || nTokens <= 0) {
      throw new Error(`kv-warm-bench: invalid /v1/tokenize payload from ${endpoint}`);
    }
    return nTokens;
  };
}

export async function buildFrontierPrompt(args: {
  frontierTokens: number;
  seed: number;
  tokenize: KvWarmBenchTokenize;
}): Promise<string> {
  const target = Math.max(16, Math.floor(args.frontierTokens));
  let words = Math.max(1, target);
  let prompt = buildPromptWithStableWords(args.seed, words);
  let nTokens = await args.tokenize(prompt);
  if (nTokens === target) return prompt;

  let ratio = nTokens / Math.max(1, words);
  words = Math.max(1, Math.ceil(target / Math.max(ratio, 0.1)));
  prompt = buildPromptWithStableWords(args.seed, words);
  nTokens = await args.tokenize(prompt);
  ratio = nTokens / Math.max(1, words);

  for (let i = 0; i < 2 && nTokens !== target; i += 1) {
    const delta = target - nTokens;
    const step = Math.max(1, Math.ceil(Math.abs(delta) / Math.max(ratio, 0.1)));
    words = delta > 0 ? words + step : Math.max(1, words - step);
    prompt = buildPromptWithStableWords(args.seed, words);
    nTokens = await args.tokenize(prompt);
    ratio = nTokens / Math.max(1, words);
  }

  return prompt;
}

function normalizeArgs(args: KvWarmBenchArgs): NormalizedKvWarmBenchArgs {
  if (!args.model?.trim()) {
    throw new Error("kv-warm-bench: model is required");
  }
  const warmRuns = args.warmRuns ?? 3;
  if (!Number.isInteger(warmRuns) || warmRuns < 1 || warmRuns > 100) {
    throw new Error("kv-warm-bench: warmRuns must be an integer between 1 and 100");
  }
  const frontiers = (args.frontiers ?? [...KV_WARM_BENCH_FRONTIERS]).map((f) => Math.floor(f));
  if (frontiers.length === 0 || frontiers.some((f) => !Number.isInteger(f) || f < 64)) {
    throw new Error("kv-warm-bench: frontiers must be a non-empty list of integers >= 64");
  }
  return {
    proxyBaseUrl: (args.proxyBaseUrl ?? KV_WARM_BENCH_DEFAULT_PROXY_BASE_URL).replace(/\/+$/, ""),
    model: args.model,
    temperature: args.temperature ?? 0,
    maxTokens: args.maxTokens ?? 256,
    frontiers,
    warmRuns,
    dataRoot:
      args.dataRoot ?? process.env.LOCAL_AI_RUNTIME_DIR ?? join(os.homedir(), ".llamactl", "data"),
    outPath: args.outPath ?? KV_WARM_BENCH_DEFAULT_MARKDOWN_PATH,
    seed: args.seed ?? 11,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function formatFixed(v: number): string {
  return v.toFixed(2);
}

export function formatKvWarmBenchCsvRow(row: KvWarmBenchRow): string {
  return [
    String(row.promptSize),
    formatFixed(row.tColdMs),
    formatFixed(row.tColdFirstByteMs),
    formatFixed(row.tWarmMinMs),
    formatFixed(row.tWarmP50Ms),
    formatFixed(row.tWarmP95Ms),
    formatFixed(row.ratioColdOverWarm),
    String(row.kvWarmHitTotal),
    String(row.kvColdMissTotal),
    String(row.kvFalseHitTotal),
  ].join(",");
}

function formatKvWarmBenchTableRow(row: KvWarmBenchRow): string {
  return `| ${row.promptSize} | ${formatFixed(row.tColdMs)} | ${formatFixed(row.tColdFirstByteMs)} | ${formatFixed(row.tWarmMinMs)} | ${formatFixed(row.tWarmP50Ms)} | ${formatFixed(row.tWarmP95Ms)} | ${formatFixed(row.ratioColdOverWarm)} | ${row.kvWarmHitTotal} | ${row.kvColdMissTotal} | ${row.kvFalseHitTotal} |`;
}

function renderKvWarmBenchCsv(rows: KvWarmBenchRow[]): string {
  return [KV_WARM_BENCH_CSV_HEADER, ...rows.map(formatKvWarmBenchCsvRow)].join("\n");
}

export function renderKvWarmBenchMarkdown(input: KvWarmBenchMarkdownInput): string {
  const csv = renderKvWarmBenchCsv(input.rows);
  const tableHeader =
    "| promptSize | t_cold_ms | t_cold_first_byte_ms | t_warm_min_ms | t_warm_p50_ms | t_warm_p95_ms | ratio_cold_over_warm | kv_warm_hit_total | kv_cold_miss_total | kv_false_hit_total |";
  const tableSeparator = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";

  const lines: string[] = [
    "# KV Warm-Restore Bench Template",
    "",
    `- Generated at: ${input.generatedAtIso}`,
    `- Model: ${input.model}`,
    `- Proxy base URL: ${input.proxyBaseUrl}`,
    `- Machine: ${input.machine}`,
    `- OS: ${input.os}`,
    `- Frontiers: ${input.frontiers.join(", ")}`,
    `- Warm runs: ${input.warmRuns}`,
    "",
    "## Per-frontier results",
    "",
    tableHeader,
    tableSeparator,
    ...input.rows.map(formatKvWarmBenchTableRow),
    "",
    "## Raw CSV",
    "",
    "```csv",
    csv,
    "```",
    "",
    "## Decision (to fill in after running)",
    "- [ ] 16k frontier cold/warm ratio ≥ 2.0 → Slice 2 ships, Phase 8 NOT needed",
    "- [ ] Write cost p95 ≤ 100 ms → no cadence work needed",
    "- [ ] False-hit rate (`kv_false_hit_total / kv_warm_hit_total`) ≤ 1% → no equivalence work needed",
    "",
  ];

  return lines.join("\n");
}

async function measureChatCompletion(args: {
  proxyBaseUrl: string;
  model: string;
  prompt: string;
  temperature: number;
  maxTokens: number;
}): Promise<KvWarmBenchRequestTiming> {
  const start = performance.now();
  const response = await fetch(`${args.proxyBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: args.model,
      messages: [{ role: "user", content: args.prompt }],
      temperature: args.temperature,
      max_tokens: args.maxTokens,
      stream: false,
      seed: 1,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `kv-warm-bench: HTTP ${response.status} from ${args.proxyBaseUrl}/v1/chat/completions: ${await response.text()}`,
    );
  }

  const reader = response.body?.getReader();
  let firstByteMs = performance.now() - start;
  if (reader) {
    const first = await reader.read();
    firstByteMs = performance.now() - start;
    while (!first.done) {
      const next = await reader.read();
      if (next.done) break;
    }
    reader.releaseLock();
  } else {
    await response.text();
  }

  const completeMs = performance.now() - start;
  return { firstByteMs, completeMs };
}

export function readKvCountersFromRegistry(dataRoot: string): KvWarmBenchCounterSnapshot {
  const dbPath = join(dataRoot, "kvstore", "registry.db");
  if (!existsSync(dbPath)) {
    return {
      kv_warm_hit_total: 0,
      kv_cold_miss_total: 0,
      kv_false_hit_total: 0,
    };
  }

  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    const warm = db.query("SELECT COALESCE(SUM(hits), 0) AS n FROM kv_entries").get() as {
      n: number;
    } | null;
    const cold = db
      .query(
        "SELECT COALESCE(SUM(CASE WHEN reason='cold' THEN 1 ELSE 0 END), 0) AS n FROM kv_entries",
      )
      .get() as { n: number } | null;
    return {
      kv_warm_hit_total: Number(warm?.n ?? 0),
      kv_cold_miss_total: Number(cold?.n ?? 0),
      // false-hit total is maintained in-process today; registry-only mode cannot read it.
      kv_false_hit_total: 0,
    };
  } finally {
    db.close();
  }
}

export async function runKvWarmBench(args: KvWarmBenchArgs): Promise<{
  rows: KvWarmBenchRow[];
  markdown: string;
  csv: string;
  outputPath: string;
}> {
  const normalized = normalizeArgs(args);
  const rows: KvWarmBenchRow[] = [];
  const tokenize = await createTokenizeClient({
    proxyBaseUrl: normalized.proxyBaseUrl,
    model: normalized.model,
  });

  for (const frontier of normalized.frontiers) {
    const prompt = tokenize
      ? await buildFrontierPrompt({
          frontierTokens: frontier,
          seed: normalized.seed,
          tokenize,
        })
      : buildDeterministicPrompt({ approxTokens: frontier, seed: normalized.seed });

    const cold = await measureChatCompletion({
      proxyBaseUrl: normalized.proxyBaseUrl,
      model: normalized.model,
      prompt,
      temperature: normalized.temperature,
      maxTokens: normalized.maxTokens,
    });

    const warms: number[] = [];
    for (let i = 0; i < normalized.warmRuns; i += 1) {
      const warm = await measureChatCompletion({
        proxyBaseUrl: normalized.proxyBaseUrl,
        model: normalized.model,
        prompt,
        temperature: normalized.temperature,
        maxTokens: normalized.maxTokens,
      });
      warms.push(warm.completeMs);
    }

    const counters = readKvCountersFromRegistry(normalized.dataRoot);
    const tWarmMinMs = warms.length > 0 ? Math.min(...warms) : 0;
    const tWarmP50Ms = percentile(warms, 50);
    const tWarmP95Ms = percentile(warms, 95);

    rows.push({
      promptSize: frontier,
      tColdMs: cold.completeMs,
      tColdFirstByteMs: cold.firstByteMs,
      tWarmMinMs,
      tWarmP50Ms,
      tWarmP95Ms,
      ratioColdOverWarm: tWarmP50Ms > 0 ? cold.completeMs / tWarmP50Ms : 0,
      kvWarmHitTotal: counters.kv_warm_hit_total,
      kvColdMissTotal: counters.kv_cold_miss_total,
      kvFalseHitTotal: counters.kv_false_hit_total,
    });
  }

  const markdown = renderKvWarmBenchMarkdown({
    generatedAtIso: new Date().toISOString(),
    model: normalized.model,
    proxyBaseUrl: normalized.proxyBaseUrl,
    machine: os.hostname(),
    os: `${os.platform()} ${os.release()}`,
    frontiers: normalized.frontiers,
    warmRuns: normalized.warmRuns,
    rows,
  });
  const csv = renderKvWarmBenchCsv(rows);

  mkdirSync(dirname(normalized.outPath), { recursive: true });
  await Bun.write(normalized.outPath, markdown);

  return {
    rows,
    markdown,
    csv,
    outputPath: normalized.outPath,
  };
}

function parseCsvIntegerList(raw: string): number[] {
  return raw
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function parseArgValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}

export function parseKvWarmBenchRunArgs(argv: string[]): KvWarmBenchArgs {
  const model = parseArgValue(argv, "--model");
  if (!model) {
    throw new Error(
      "usage: run kv-warm-bench --model <name> [--proxy <url>] [--temperature <n>] [--max-tokens <n>] [--frontiers <csv>] [--warm-runs <n>] [--data-root <path>] [--out <path>]",
    );
  }
  const proxy = parseArgValue(argv, "--proxy");
  const temperature = parseArgValue(argv, "--temperature");
  const maxTokens = parseArgValue(argv, "--max-tokens");
  const frontiers = parseArgValue(argv, "--frontiers");
  const warmRuns = parseArgValue(argv, "--warm-runs");
  const dataRoot = parseArgValue(argv, "--data-root");
  const outPath = parseArgValue(argv, "--out");
  const seed = parseArgValue(argv, "--seed");

  return {
    model,
    ...(proxy ? { proxyBaseUrl: proxy } : {}),
    ...(temperature ? { temperature: Number.parseFloat(temperature) } : {}),
    ...(maxTokens ? { maxTokens: Number.parseInt(maxTokens, 10) } : {}),
    ...(frontiers ? { frontiers: parseCsvIntegerList(frontiers) } : {}),
    ...(warmRuns ? { warmRuns: Number.parseInt(warmRuns, 10) } : {}),
    ...(dataRoot ? { dataRoot } : {}),
    ...(outPath ? { outPath } : {}),
    ...(seed ? { seed: Number.parseInt(seed, 10) } : {}),
  };
}

export const kvWarmBenchWorkload: WorkloadEval = {
  name: "kv-warm-bench",
  // Dedicated runner workload. This sentinel corpus path makes accidental
  // invocation through runMatrix fail fast with a clear file-not-found.
  corpus_path: "/tmp/kv-warm-bench.use-run-subcommand",
  primary_metric_name: "mean_exact_match",
  prompt_builder: () => ({
    messages: [{ role: "user", content: "run kv-warm-bench via matrix CLI subcommand" }],
  }),
  scorer: () => ({
    metrics: { exact_match: 1 },
    prediction: "bench-only",
    gold: "bench-only",
  }),
};

export function kvWarmBenchCsvHeader(): string {
  return KV_WARM_BENCH_CSV_HEADER;
}
