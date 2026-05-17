import { Database } from 'bun:sqlite';
import { runMatrix } from './runner.js';
import { memoryEfficacyBinaryWorkload } from './workloads/memory-efficacy-binary.js';
import type { ModelSpec, WorkloadEval } from './types.js';

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function validateModelSpec(value: unknown): ModelSpec {
  if (typeof value !== 'object' || value === null) {
    throw new Error('invalid ModelSpec: missing/bad field name');
  }
  const spec = value as Record<string, unknown>;
  const required: Array<keyof ModelSpec> = [
    'name',
    'gguf_path',
    'quant',
    'family',
    'size_params',
    'host',
    'port',
    'extra_args',
  ];
  for (const field of required) {
    const fieldValue = spec[field];
    const ok =
      field === 'port'
        ? typeof fieldValue === 'number'
        : field === 'extra_args'
          ? Array.isArray(fieldValue) && fieldValue.every((item) => typeof item === 'string')
          : typeof fieldValue === 'string';
    if (!ok) {
      throw new Error(`invalid ModelSpec: missing/bad field ${String(field)}`);
    }
  }
  return spec as ModelSpec;
}

function getKnownWorkloads(): Record<string, WorkloadEval> {
  return { 'memory-efficacy-binary': memoryEfficacyBinaryWorkload };
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('usage: --models <json> --workloads <names> --out-db <path>');
    return;
  }
  const modelsPath = getArg('--models');
  const workloadsArg = getArg('--workloads');
  const outDb = getArg('--out-db');
  if (!modelsPath || !workloadsArg || !outDb) {
    throw new Error('usage: --models <json> --workloads <names> --out-db <path>');
  }

  const models = ((await Bun.file(modelsPath).json()) as unknown[]).map(validateModelSpec);
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
