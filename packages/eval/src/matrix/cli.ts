import { Database } from 'bun:sqlite';
import { runMatrix } from './runner.js';
import type { ModelSpec, WorkloadEval } from './types.js';

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function getKnownWorkloads(): Record<string, WorkloadEval> {
  return {
    'memory-efficacy-binary': {
      name: 'memory-efficacy-binary',
      corpus_path: '/tmp/memory-efficacy-binary.jsonl',
      prompt_builder: (row) => row,
      scorer: (_row, completion) => ({
        metrics: { score: completion.length },
        prediction: completion,
      }),
    },
  };
}

async function main(): Promise<void> {
  const modelsPath = getArg('--models');
  const workloadsArg = getArg('--workloads');
  const outDb = getArg('--out-db');
  if (!modelsPath || !workloadsArg || !outDb) {
    throw new Error('usage: --models <json> --workloads <names> --out-db <path>');
  }

  const models = (await Bun.file(modelsPath).json()) as ModelSpec[];
  const knownWorkloads = getKnownWorkloads();
  const workloads = workloadsArg.split(',').map((name) => {
    const workload = knownWorkloads[name];
    if (!workload) {
      throw new Error(`unknown workload: ${name}`);
    }
    return workload;
  });

  const db = new Database(outDb);
  const result = await runMatrix({ models, workloads, db });
  console.log(`runId=${result.runId} cellsWritten=${result.cellsWritten}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
