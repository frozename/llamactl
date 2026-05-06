import { describe, expect, test } from 'bun:test';
import { renderCard } from '../src/report/render-card.js';

describe('renderCard', () => {
  test('renders populated sub-bench details', () => {
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
          name: 'Throughput',
          scores: {
            throughput_tps: 24.5,
            tool_call_score: 0.8,
            context_8k_score: 0.9,
            context_16k_score: 0.7,
            json_score: 1,
          },
          throughput: {
            mean_tps: 24.5,
            samples: [
              { name: 'slow', predicted_per_second: 20.25 },
              { name: 'fast', predicted_per_second: 28.75 },
            ],
          },
        },
        {
          name: 'Tool-Calling',
          scores: {
            throughput_tps: 24.5,
            tool_call_score: 0.8,
            context_8k_score: 0.9,
            context_16k_score: 0.7,
            json_score: 1,
          },
          toolCalling: {
            score: 0.8,
            failures: [
              { name: 'find_user', reason: 'wrong tool' },
              { name: 'delete_file', reason: 'args mismatch' },
            ],
          },
        },
        {
          name: 'Context Retrieval',
          scores: {
            throughput_tps: 24.5,
            tool_call_score: 0.8,
            context_8k_score: 0.9,
            context_16k_score: 0.7,
            json_score: 1,
          },
          contextRetrieval: {
            scores: [
              { depth: 4096, score: 1 },
              { depth: 8192, score: 2 / 3 },
              { depth: 16384, score: 1 / 3 },
            ],
          },
        },
        {
          name: 'JSON Output',
          scores: {
            throughput_tps: 24.5,
            tool_call_score: 0.8,
            context_8k_score: 0.9,
            context_16k_score: 0.7,
            json_score: 1,
          },
          jsonOutput: {
            score: 1,
            failures: [{ name: 'emit_schema', reason: 'schema validation failed' }],
          },
        },
      ],
    });

    expect(md).toContain('# Model Eval: qwen36-27b');
    expect(md).toContain('## Identity');
    expect(md).toContain('| node | ub | throughput_tps | ttft_ms | composite | asof |');
    expect(md).toContain('## Sub-Bench Details');
    expect(md).toContain('### Throughput');
    expect(md).toContain('- mean: 24.50 tps');
    expect(md).toContain('slowest slow 20.25 tps, fastest fast 28.75 tps');
    expect(md).toContain('### Tool-Calling');
    expect(md).toContain('- score: 80.0%');
    expect(md).toContain('- find_user: wrong tool');
    expect(md).toContain('- delete_file: args mismatch');
    expect(md).toContain('### Context Retrieval');
    expect(md).toContain('- 4k: 3/3 found');
    expect(md).toContain('- 8k: 2/3 found');
    expect(md).toContain('- 16k: 1/3 found');
    expect(md).toContain('### JSON Output');
    expect(md).toContain('- score: 100.0%');
    expect(md).toContain('- emit_schema: schema validation failed');
    expect(md).toContain('## Tuning Sweep');
    expect(md).toContain('## Verdict');
  });

  test.each([
    {
      composite: 0.82,
      throughput_tps: 24.5,
      tool_call_score: 0.8,
      context_8k_score: 0.8,
      context_16k_score: 0.8,
      json_score: 0.8,
      expected: 'Solid agentic candidate — strong across throughput, tool-calling, context retrieval, JSON output.',
    },
    {
      composite: 0.475,
      throughput_tps: 24.5,
      tool_call_score: 0.2,
      context_8k_score: 0.7,
      context_16k_score: 0.2,
      json_score: 0.1,
      expected: 'Mixed — strong at throughput, context retrieval, weak at tool-calling, JSON output. Use selectively.',
    },
    {
      composite: 0.2,
      throughput_tps: 5,
      tool_call_score: 0.1,
      context_8k_score: 0.2,
      context_16k_score: 0.1,
      json_score: 0.1,
      expected: 'Not recommended for agentic roles — weak at throughput, tool-calling, context retrieval, JSON output.',
    },
  ])('renders verdict for composite $composite', (row) => {
    const md = renderCard({
      modelId: 'qwen36-27b',
      source: { ggufPath: '/models/qwen.gguf', fileSizeBytes: 1073741824 },
      hwMatrix: [
        {
          model: 'qwen36-27b',
          node: 'local',
          ub: 512,
          throughput_tps: row.throughput_tps,
          ttft_ms: 1234,
          tool_call_score: row.tool_call_score,
          context_8k_score: row.context_8k_score,
          context_16k_score: row.context_16k_score,
          json_score: row.json_score,
          composite: row.composite,
          asof: '2026-05-05T00:00:00.000Z',
        },
      ],
      subBenches: [],
    });

    expect(md).toContain(row.expected);
  });
});
