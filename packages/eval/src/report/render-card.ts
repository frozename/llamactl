import type { SubBenchScores } from "../score/compose.js";
import type { LeaderboardRow } from "../store/sqlite.js";

export type HardwareMatrixRow = LeaderboardRow;

export interface ThroughputDetail {
  name: string;
  predicted_per_second: number;
}

export interface ToolCallingFailure {
  name: string;
  reason: "no tool_calls" | "wrong tool" | "args mismatch" | "invalid JSON";
}

export interface ContextRetrievalDetail {
  depth: 4096 | 8192 | 16384;
  score: number;
}

export interface JsonOutputFailure {
  name: string;
  reason: "no JSON" | "schema validation failed";
}

export interface SubBenchDetail {
  name: string;
  scores: SubBenchScores;
  throughput?: {
    mean_tps: number;
    samples?: ThroughputDetail[];
  };
  toolCalling?: {
    score: number;
    failures?: ToolCallingFailure[];
  };
  contextRetrieval?: {
    scores: ContextRetrievalDetail[];
  };
  jsonOutput?: {
    score: number;
    failures?: JsonOutputFailure[];
  };
  notes?: string;
}

export interface RenderCardInput {
  modelId: string;
  source: {
    ggufPath: string;
    fileSizeBytes: number;
    hfRepo?: string | null;
    hfSha?: string | null;
  };
  hwMatrix: HardwareMatrixRow[];
  subBenches: SubBenchDetail[];
}

function fmtBytes(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024);
  return `${gib.toFixed(2)} GiB`;
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function strengthNames(best: HardwareMatrixRow | undefined): { strong: string[]; weak: string[] } {
  if (!best) return { strong: [], weak: [] };
  const throughput = Math.min(1, best.throughput_tps / 30);
  const entries = [
    ["throughput", throughput],
    ["tool-calling", best.tool_call_score],
    ["context retrieval", best.context_8k_score],
    ["JSON output", best.json_score],
  ] as const;
  return {
    strong: entries.filter(([, score]) => score >= 0.6).map(([name]) => name),
    weak: entries.filter(([, score]) => score < 0.3).map(([name]) => name),
  };
}

function formatFailureList(items?: readonly { name: string; reason: string }[]): string[] {
  if (!items || items.length === 0)
    return ["(no per-prompt details available — re-run to regenerate)"];
  return items.map((item) => `- ${item.name}: ${item.reason}`);
}

function formatThroughputDetail(detail?: SubBenchDetail["throughput"]): string[] {
  if (!detail) return ["(no per-prompt details available — re-run to regenerate)"];
  const lines = [`- mean: ${detail.mean_tps.toFixed(2)} tps`];
  if (detail.samples && detail.samples.length > 0) {
    const sorted = [...detail.samples].sort(
      (a, b) => a.predicted_per_second - b.predicted_per_second,
    );
    const slowest = sorted[0];
    const fastest = sorted.at(-1);
    if (slowest && fastest) {
      lines.push(
        `- spread: slowest ${slowest.name} ${slowest.predicted_per_second.toFixed(2)} tps, fastest ${fastest.name} ${fastest.predicted_per_second.toFixed(2)} tps`,
      );
    }
  }
  return lines;
}

function formatContextDetail(detail?: SubBenchDetail["contextRetrieval"]): string[] {
  if (!detail) return ["(no per-prompt details available — re-run to regenerate)"];
  const scores = new Map(detail.scores.map((item) => [item.depth, item.score]));
  return ([4096, 8192, 16384] as const).map(
    (depth) =>
      `- ${String(depth / 1024)}k: ${String(Math.round((scores.get(depth) ?? 0) * 3))}/3 found`,
  );
}

function verdictForBest(best: HardwareMatrixRow | undefined): string {
  if (!best) return "No runs recorded yet.";
  const { strong, weak } = strengthNames(best);
  const strongText = strong.length > 0 ? strong.join(", ") : "none";
  const weakText = weak.length > 0 ? weak.join(", ") : "none";
  if (best.composite >= 0.7) {
    return `Solid agentic candidate — strong across ${strongText}.`;
  }
  if (best.composite >= 0.4) {
    return `Mixed — strong at ${strongText}, weak at ${weakText}. Use selectively.`;
  }
  return `Not recommended for agentic roles — weak at ${weakText}.`;
}

export function renderCard(input: RenderCardInput): string {
  const lines: string[] = [];
  lines.push(`# Model Eval: ${input.modelId}`);
  lines.push("");
  lines.push("## Identity");
  lines.push(`- GGUF: ${input.source.ggufPath}`);
  lines.push(`- File size: ${fmtBytes(input.source.fileSizeBytes)}`);
  if (input.source.hfRepo) lines.push(`- HF repo: ${input.source.hfRepo}`);
  if (input.source.hfSha) lines.push(`- HF SHA: ${input.source.hfSha}`);
  lines.push("");
  lines.push("## Hardware Matrix");
  lines.push("| node | ub | throughput_tps | ttft_ms | composite | asof |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const row of input.hwMatrix) {
    lines.push(
      `| ${row.node} | ${String(row.ub)} | ${row.throughput_tps.toFixed(2)} | ${row.ttft_ms.toFixed(0)} | ${row.composite.toFixed(3)} | ${row.asof} |`,
    );
  }
  lines.push("");
  lines.push("## Sub-Bench Details");
  for (const bench of input.subBenches) {
    lines.push(`### ${bench.name}`);
    lines.push("#### Throughput");
    lines.push(...formatThroughputDetail(bench.throughput));
    lines.push("#### Tool-Calling");
    lines.push(
      `- score: ${bench.toolCalling ? fmtPct(bench.toolCalling.score) : fmtPct(bench.scores.tool_call_score)}`,
    );
    lines.push(...formatFailureList(bench.toolCalling?.failures));
    lines.push("#### Context Retrieval");
    lines.push(...formatContextDetail(bench.contextRetrieval));
    lines.push("#### JSON Output");
    lines.push(
      `- score: ${bench.jsonOutput ? fmtPct(bench.jsonOutput.score) : fmtPct(bench.scores.json_score)}`,
    );
    lines.push(...formatFailureList(bench.jsonOutput?.failures));
    if (bench.notes) lines.push(`- notes: ${bench.notes}`);
    lines.push("");
  }
  lines.push("## Tuning Sweep");
  lines.push("| ub | composite | throughput_tps |");
  lines.push("| --- | --- | --- |");
  for (const row of input.hwMatrix) {
    lines.push(
      `| ${String(row.ub)} | ${row.composite.toFixed(3)} | ${row.throughput_tps.toFixed(2)} |`,
    );
  }
  lines.push("");
  lines.push("## Verdict");
  const best = [...input.hwMatrix].sort((a, b) => b.composite - a.composite)[0];
  lines.push(
    best
      ? `Best result is ${best.node} ub ${String(best.ub)} with composite ${best.composite.toFixed(3)}. ${verdictForBest(best)}`
      : "No runs recorded yet.",
  );
  return lines.join("\n");
}
