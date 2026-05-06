import type { LeaderboardRow } from '../store/sqlite.js';
import type { SubBenchScores } from '../score/compose.js';

export interface HardwareMatrixRow extends LeaderboardRow {}

export interface RenderCardInput {
  modelId: string;
  source: {
    ggufPath: string;
    fileSizeBytes: number;
    hfRepo?: string | null;
    hfSha?: string | null;
  };
  hwMatrix: HardwareMatrixRow[];
  subBenches: Array<{
    name: string;
    scores: SubBenchScores;
    notes?: string;
  }>;
}

function fmtBytes(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024);
  return `${gib.toFixed(2)} GiB`;
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderCard(input: RenderCardInput): string {
  const lines: string[] = [];
  lines.push(`# Model Eval: ${input.modelId}`);
  lines.push('');
  lines.push('## Identity');
  lines.push(`- GGUF: ${input.source.ggufPath}`);
  lines.push(`- File size: ${fmtBytes(input.source.fileSizeBytes)}`);
  if (input.source.hfRepo) lines.push(`- HF repo: ${input.source.hfRepo}`);
  if (input.source.hfSha) lines.push(`- HF SHA: ${input.source.hfSha}`);
  lines.push('');
  lines.push('## Hardware Matrix');
  lines.push('| node | ub | throughput_tps | ttft_ms | composite | asof |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const row of input.hwMatrix) {
    lines.push(
      `| ${row.node} | ${row.ub} | ${row.throughput_tps.toFixed(2)} | ${row.ttft_ms.toFixed(0)} | ${row.composite.toFixed(3)} | ${row.asof} |`,
    );
  }
  lines.push('');
  lines.push('## Sub-Bench Details');
  for (const bench of input.subBenches) {
    lines.push(`### ${bench.name}`);
    lines.push(`- throughput: ${bench.scores.throughput_tps.toFixed(2)} tps`);
    lines.push(`- tool-calling: ${fmtPct(bench.scores.tool_call_score)}`);
    lines.push(`- context-8k: ${fmtPct(bench.scores.context_8k_score)}`);
    lines.push(`- context-16k: ${bench.scores.context_16k_score == null ? 'n/a' : fmtPct(bench.scores.context_16k_score)}`);
    lines.push(`- json: ${fmtPct(bench.scores.json_score)}`);
    if (bench.notes) lines.push(`- notes: ${bench.notes}`);
    lines.push('');
  }
  lines.push('## Tuning Sweep');
  lines.push('| ub | composite | throughput_tps |');
  lines.push('| --- | --- | --- |');
  for (const row of input.hwMatrix) {
    lines.push(`| ${row.ub} | ${row.composite.toFixed(3)} | ${row.throughput_tps.toFixed(2)} |`);
  }
  lines.push('');
  lines.push('## Verdict');
  const best = [...input.hwMatrix].sort((a, b) => b.composite - a.composite)[0];
  lines.push(
    best
      ? `Best result is ${best.node} ub ${best.ub} with composite ${best.composite.toFixed(3)}; use it where throughput and structured-output reliability matter.`
      : 'No runs recorded yet.',
  );
  return lines.join('\n');
}
