import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  ensureMatrixSchema,
  insertCellRow,
  listCellRows,
  runMatrix,
  type CellRow,
  type ModelSpec,
  type WorkloadEval,
} from '../src/index.js';

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

function makeWorkload(name: string): WorkloadEval {
  return {
    name,
    corpus_path: `/corpora/${name}.jsonl`,
    prompt_builder: (row) => row,
    scorer: (_row, completion) => ({
      metrics: { score: completion.length },
      prediction: completion,
    }),
  };
}

describe('matrix store', () => {
  test('round-trips cell rows', () => {
    const db = new Database(':memory:');
    ensureMatrixSchema(db);

    const row: CellRow = {
      run_id: 'run-1',
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
  test('writes one cell per model workload pair', async () => {
    const db = new Database(':memory:');
    const run = await runMatrix({
      models: [makeModel('model-a'), makeModel('model-b')],
      workloads: [makeWorkload('memory-efficacy-binary')],
      db,
    });

    expect(run.cellsWritten).toBe(2);
    expect(listCellRows(db, { run_id: run.runId })).toHaveLength(2);
  });

  test('writes the full cross product', async () => {
    const db = new Database(':memory:');
    const run = await runMatrix({
      models: [makeModel('model-a'), makeModel('model-b'), makeModel('model-c')],
      workloads: [makeWorkload('workload-a'), makeWorkload('workload-b')],
      db,
    });

    expect(run.cellsWritten).toBe(6);
    expect(listCellRows(db, { run_id: run.runId })).toHaveLength(6);
  });
});
