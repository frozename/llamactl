export interface SubBenchScores {
  throughput_tps: number;
  tool_call_score: number;
  context_8k_score: number;
  context_16k_score?: number | null;
  json_score: number;
}

export function composite(scores: SubBenchScores): number {
  const normalizedThroughput = Math.min(1, scores.throughput_tps / 30);
  const context16k = scores.context_16k_score ?? scores.context_8k_score;
  return (
    0.3 * normalizedThroughput +
    0.3 * scores.tool_call_score +
    0.2 * scores.context_8k_score +
    0.1 * context16k +
    0.1 * scores.json_score
  );
}
