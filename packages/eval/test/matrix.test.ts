import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  aggregateMetrics,
  ensureMatrixSchema,
  insertCellRow,
  listCellRows,
  runMatrix,
  type CellRow,
  type ModelSpec,
  type WorkloadEval,
} from '../src/index.js';
import { memoryEfficacyBinaryWorkload } from '../src/index.js';

function makeModel(name: string): ModelSpec {
  return {
    name,
    gguf_path: `/models/${name}.gguf`,
    quant: 'Q4',
    family: 'test',
    size_params: '1b',
    host: '127.0.0.1',
    port: 8080,
    extra_args: [],
  };
}

describe('matrix store', () => {
  test('round-trips cell rows', () => {
    const db = new Database(':memory:');
    ensureMatrixSchema(db);

    const row: CellRow = {
      run_id: 'run-1',
      runner_version: 0,
      model_name: 'model-a',
      workload_name: 'workload-a',
      model_spec_json: JSON.stringify({ name: 'model-a' }),
      n_rows: 3,
      primary_metric_name: 'accuracy',
      primary_metric_value: 0.75,
      per_class_metrics_json: JSON.stringify({ ok: 1 }),
      latency_p50_ms: 12.5,
      latency_p95_ms: 20.5,
      throughput_tps: 4.2,
      errors: 0,
      started_at: '2026-05-17T00:00:00.000Z',
      finished_at: '2026-05-17T00:01:00.000Z',
      host_machine: 'host-a',
    };

    insertCellRow(db, row);

    expect(listCellRows(db)).toEqual([row]);
  });
});

describe('runMatrix', () => {
  test('runs the binary memory-efficacy workload end to end', async () => {
    const db = new Database(':memory:');
    const tmpPath = `/tmp/memory-efficacy-binary-${randomUUID()}.jsonl`;
    const jsonl = [
      JSON.stringify({
        messages: [
          { role: 'user', content: 'Is this memory related?' },
          { role: 'assistant', content: JSON.stringify({ memory_related: true, reason: 'x' }) },
        ],
      }),
      JSON.stringify({
        messages: [
          { role: 'user', content: 'Is this memory related?' },
          { role: 'assistant', content: JSON.stringify({ memory_related: false, reason: 'y' }) },
        ],
      }),
    ].join('\n');
    await Bun.write(tmpPath, jsonl);
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"memory_related":true}' } }],
          usage: { completion_tokens: 5 },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    try {
    const workload: WorkloadEval = {
      ...memoryEfficacyBinaryWorkload,
      corpus_path: tmpPath,
    };
      const run = await runMatrix({
        models: [makeModel('model-a')],
        workloads: [workload],
        db,
      });
      expect(run.cellsWritten).toBe(1);
      const rows = listCellRows(db, { run_id: run.runId });
      expect(rows).toHaveLength(1);
      const [cell] = rows;
      expect(cell.runner_version).toBe(1);
      expect(cell.n_rows).toBe(2);
      expect(cell.run_id).toMatch(/^\d{4}-\d{2}-\d{2}T.+-[0-9a-f]{8}$/);
      const expected = aggregateMetrics([
        { pred: 'true', gold: 'true' },
        { pred: 'true', gold: 'false' },
      ]);
      expect(cell.primary_metric_value).toBeCloseTo(expected.macro_f1, 5);
    } finally {
      globalThis.fetch = origFetch;
      try {
        rmSync(tmpPath);
      } catch {}
    }
  });
});
