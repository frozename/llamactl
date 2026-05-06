import promptsRaw from '../fixtures/prompts-throughput.json' with { type: 'json' };
import { buildCompletionRequest, completeChat } from '../client.js';

export interface ThroughputSample {
  name: string;
  predicted_per_second: number;
  predicted_n: number;
  wallMs: number;
}

export interface ThroughputResult {
  samples: ThroughputSample[];
  mean_tps: number;
  p10_tps: number;
  p90_tps: number;
  total_predicted: number;
  total_wall_ms: number;
}

export function aggregateThroughput(samples: ThroughputSample[]): ThroughputResult {
  const tps = samples.map((s) => s.predicted_per_second).sort((a, b) => a - b);
  if (tps.length === 0) {
    return {
      samples,
      mean_tps: 0,
      p10_tps: 0,
      p90_tps: 0,
      total_predicted: 0,
      total_wall_ms: 0,
    };
  }
  const mean = tps.reduce((a, b) => a + b, 0) / tps.length;
  const pct = (p: number): number => tps[Math.min(tps.length - 1, Math.floor(p * tps.length))]!;
  return {
    samples,
    mean_tps: mean,
    p10_tps: pct(0.1),
    p90_tps: pct(0.9),
    total_predicted: samples.reduce((a, s) => a + s.predicted_n, 0),
    total_wall_ms: samples.reduce((a, s) => a + s.wallMs, 0),
  };
}

export async function runThroughput(url: string): Promise<ThroughputResult> {
  const samples: ThroughputSample[] = [];
  for (const p of promptsRaw as Array<{ name: string; prompt: string }>) {
    const req = buildCompletionRequest({
      messages: [{ role: 'user', content: p.prompt }],
      maxTokens: 192,
      seed: 42,
    });
    const { resp, wallMs } = await completeChat(url, req);
    samples.push({
      name: p.name,
      predicted_per_second: resp.timings?.predicted_per_second ?? 0,
      predicted_n: Number(resp.timings?.predicted_n ?? resp.usage?.completion_tokens ?? 0),
      wallMs: Number(wallMs ?? 0),
    });
  }
  return aggregateThroughput(samples);
}
