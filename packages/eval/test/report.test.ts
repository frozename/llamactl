import { describe, expect, test } from 'bun:test';
import { renderCard } from '../src/report/render-card.js';

describe('renderCard', () => {
  test('renders the expected markdown sections', () => {
    const md = renderCard({
      modelId: 'qwen36-27b',
      source: {
        ggufPath: '/models/qwen.gguf',
        fileSizeBytes: 1073741824,
        hfRepo: 'unsloth/Qwen3.6-27B',
        hfSha: 'abc123',
      },
      hwMatrix: [
        {
          model: 'qwen36-27b',
          node: 'local',
          ub: 512,
          throughput_tps: 24.5,
          ttft_ms: 1234,
          tool_call_score: 0.8,
          context_8k_score: 0.9,
          context_16k_score: 0.7,
          json_score: 1,
          composite: 0.85,
          asof: '2026-05-05T00:00:00.000Z',
        },
      ],
      subBenches: [
        {
          name: 'tool-calling',
          scores: {
            throughput_tps: 24.5,
            tool_call_score: 0.8,
            context_8k_score: 0.9,
            context_16k_score: 0.7,
            json_score: 1,
          },
        },
      ],
    });

    expect(md).toContain('# Model Eval: qwen36-27b');
    expect(md).toContain('## Identity');
    expect(md).toContain('| node | ub | throughput_tps | ttft_ms | composite | asof |');
    expect(md).toContain('## Sub-Bench Details');
    expect(md).toContain('## Tuning Sweep');
    expect(md).toContain('## Verdict');
  });
});
