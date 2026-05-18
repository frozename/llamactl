import { Database } from 'bun:sqlite';
import { runMatrix } from './runner.js';
import { listCellRows } from './store.js';
import { memoryEfficacyBinaryWorkload } from './workloads/memory-efficacy-binary.js';
import { memoryEfficacy4wayWorkload } from './workloads/memory-efficacy-4way.js';
import { memoryEfficacy4wayBalancedWorkload } from './workloads/memory-efficacy-4way-balanced.js';
import { taskRefinerRubricWorkload } from './workloads/task-refiner-rubric.js';
import { toolCallGrammarWorkload } from './workloads/tool-call-grammar.js';
import { memoryRecallWorkload } from './workloads/memory-recall.js';
import { renderCsvReport, renderMarkdownReport } from './report.js';
import type { ModelSpec, WorkloadEval } from './types.js';

export interface MatrixCliArgs {
  modelsPath: string;
  workloadsArg: string;
  outDb: string;
  report?: 'md' | 'csv' | 'both';
  reportOut?: string;
  runId?: string;
  reportAllRuns: boolean;
}

export function parseArgs(argv: string[]): MatrixCliArgs {
  const readArg = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const modelsPath = readArg('--models');
  const workloadsArg = readArg('--workloads');
  const outDb = readArg('--out-db');
  const report = readArg('--report') as MatrixCliArgs['report'];
  const reportOut = readArg('--report-out');
  const runId = readArg('--run-id');
  const reportAllRuns = argv.includes('--report-all-runs');
  if (runId && reportAllRuns) {
    throw new Error('--run-id and --report-all-runs are mutually exclusive');
  }
  if (!modelsPath || !workloadsArg || !outDb) {
    throw new Error('usage: --models <json> --workloads <names> --out-db <path>');
  }
  return { modelsPath, workloadsArg, outDb, report, reportOut, runId, reportAllRuns };
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
  const optional: Array<keyof Pick<ModelSpec, 'binary' | 'start_args' | 'managed'>> = [
    'binary',
    'start_args',
    'managed',
  ];
  for (const field of optional) {
    const fieldValue = spec[field];
    const ok =
      field === 'binary'
        ? fieldValue === undefined || typeof fieldValue === 'string'
        : field === 'start_args'
          ? fieldValue === undefined || (Array.isArray(fieldValue) && fieldValue.every((item) => typeof item === 'string'))
          : fieldValue === undefined || typeof fieldValue === 'boolean';
    if (!ok) {
      throw new Error(`invalid ModelSpec: missing/bad field ${String(field)}`);
    }
  }
  return spec as ModelSpec;
}

function getKnownWorkloads(): Record<string, WorkloadEval> {
  return {
    'memory-efficacy-binary': memoryEfficacyBinaryWorkload,
    'memory-efficacy-4way': memoryEfficacy4wayWorkload,
    'memory-efficacy-4way-balanced': memoryEfficacy4wayBalancedWorkload,
    'task-refiner-rubric': taskRefinerRubricWorkload,
    'tool-call-grammar': toolCallGrammarWorkload,
    'memory-recall': memoryRecallWorkload,
  };
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('usage: --models <json> --workloads <names> --out-db <path> [--report md|csv|both] [--report-out <path>]');
    return;
  }
  const { modelsPath, workloadsArg, outDb, report, reportOut, runId, reportAllRuns } = parseArgs(process.argv.slice(2));

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
  const result = await runMatrix({ models, workloads, db, runId });
  if (report) {
    if (!reportOut) {
      throw new Error('--report-out is required when --report is set');
    }
    const cells = reportAllRuns ? listCellRows(db) : listCellRows(db, { run_id: result.runId });
    const reportOpts = reportAllRuns ? {} : { runId: result.runId };
    if (report === 'md') {
      await Bun.write(reportOut, renderMarkdownReport(cells, reportOpts));
    } else if (report === 'csv') {
      await Bun.write(reportOut, renderCsvReport(cells, reportOpts));
    } else if (report === 'both') {
      await Bun.write(`${reportOut}.md`, renderMarkdownReport(cells, reportOpts));
      await Bun.write(`${reportOut}.csv`, renderCsvReport(cells, reportOpts));
    } else {
      throw new Error(`unknown report format: ${report}`);
    }
  }
  console.log(`runId=${result.runId} cellsWritten=${result.cellsWritten}`);
  if (reportAllRuns) {
    console.log('report-mode=all-runs');
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
