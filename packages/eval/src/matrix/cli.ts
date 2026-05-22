import { Database } from 'bun:sqlite';
import { runMatrix } from './runner.js';
import { listCellRows } from './store.js';
import { memoryEfficacyBinaryWorkload } from './workloads/memory-efficacy-binary.js';
import { memoryEfficacy4wayWorkload } from './workloads/memory-efficacy-4way.js';
import { memoryEfficacy4wayBalancedWorkload } from './workloads/memory-efficacy-4way-balanced.js';
import { taskRefinerRubricWorkload } from './workloads/task-refiner-rubric.js';
import { toolCallGrammarWorkload } from './workloads/tool-call-grammar.js';
import { memoryRecallWorkload } from './workloads/memory-recall.js';
import { projectBriefGenWorkload } from './workloads/project-brief-gen.js';
import { renderCsvReport, renderMarkdownReport } from './report.js';
import type { ModelSpec, WorkloadEval } from './types.js';

export interface MatrixCliArgs {
  modelsPath: string;
  workloadsArg: string;
  outDb: string;
  concurrency: number;
  report?: 'md' | 'csv' | 'both';
  reportOut?: string;
  runId?: string;
  reportAllRuns: boolean;
  corpusOverrides?: Map<string, string>;
}

export function parseCorpusOverrides(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0 || eq === trimmed.length - 1) {
      throw new Error(`--corpus-override entry must be workload=path, got: ${trimmed}`);
    }
    const workload = trimmed.slice(0, eq).trim();
    const path = trimmed.slice(eq + 1).trim();
    if (!workload || !path) {
      throw new Error(`--corpus-override entry must be workload=path, got: ${trimmed}`);
    }
    if (out.has(workload)) {
      throw new Error(`--corpus-override has duplicate entry for workload: ${workload}`);
    }
    out.set(workload, path);
  }
  return out;
}

export function parseArgs(argv: string[]): MatrixCliArgs {
  const readArg = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const modelsPath = readArg('--models');
  const workloadsArg = readArg('--workloads');
  const outDb = readArg('--out-db') ?? 'packages/eval/results/matrix.db';
  const concurrencyRaw = readArg('--concurrency');
  const report = readArg('--report') as MatrixCliArgs['report'];
  const reportOut = readArg('--report-out');
  const runId = readArg('--run-id');
  const reportAllRuns = argv.includes('--report-all-runs');
  const corpusOverrideRaw = readArg('--corpus-override');
  const concurrency = concurrencyRaw ? Number.parseInt(concurrencyRaw, 10) : 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error('--concurrency must be an integer between 1 and 8');
  }
  if (runId && reportAllRuns) {
    throw new Error('--run-id and --report-all-runs are mutually exclusive');
  }
  if (!modelsPath || !workloadsArg) {
    throw new Error('usage: --models <json> --workloads <names> [--out-db <path>] [--concurrency <1-8>] (default packages/eval/results/matrix.db)');
  }
  const corpusOverrides = corpusOverrideRaw ? parseCorpusOverrides(corpusOverrideRaw) : undefined;
  return { modelsPath, workloadsArg, outDb, concurrency, report, reportOut, runId, reportAllRuns, corpusOverrides };
}

function validateModelSpec(value: unknown): ModelSpec {
  if (typeof value !== 'object' || value === null) {
    throw new Error('invalid ModelSpec: missing/bad field name');
  }
  const spec = value as Record<string, unknown>;
  const engine = typeof spec.engine === 'string' ? spec.engine : 'llamacpp';
  const modelPathField: keyof ModelSpec = engine === 'omlx' ? 'mlx_model_dir' : 'gguf_path';
  const required: Array<keyof ModelSpec> = [
    'name',
    modelPathField,
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
  const optional: Array<keyof Pick<ModelSpec, 'binary' | 'start_args' | 'managed' | 'structured_outputs_supported'>> = [
    'binary',
    'start_args',
    'managed',
    'structured_outputs_supported',
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
  return spec as unknown as ModelSpec;
}

function getKnownWorkloads(): Record<string, WorkloadEval> {
  return {
    'memory-efficacy-binary': memoryEfficacyBinaryWorkload,
    'memory-efficacy-4way': memoryEfficacy4wayWorkload,
    'memory-efficacy-4way-balanced': memoryEfficacy4wayBalancedWorkload,
    'task-refiner-rubric': taskRefinerRubricWorkload,
    'tool-call-grammar': toolCallGrammarWorkload,
    'memory-recall': memoryRecallWorkload,
    'project-brief-gen': projectBriefGenWorkload,
  };
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('usage: --models <json> --workloads <names> --out-db <path> [--concurrency <1-8>] [--report md|csv|both] [--report-out <path>] [--corpus-override workload=path[,...]]');
    return;
  }
  const { modelsPath, workloadsArg, outDb, concurrency, report, reportOut, runId, reportAllRuns, corpusOverrides } = parseArgs(process.argv.slice(2));

  const models = ((await Bun.file(modelsPath).json()) as unknown[]).map(validateModelSpec);
  if (models.length === 0) {
    throw new Error(`--models points to an empty list (${modelsPath}); nothing to bench`);
  }
  const knownWorkloads = getKnownWorkloads();
  const workloads = workloadsArg.split(',').map((name) => {
    const workload = knownWorkloads[name];
    if (!workload) {
      throw new Error(`unknown workload: ${name}`);
    }
    return workload;
  });
  if (corpusOverrides) {
    const requested = new Set(workloads.map((w) => w.name));
    for (const overrideName of corpusOverrides.keys()) {
      if (!requested.has(overrideName)) {
        throw new Error(`--corpus-override references workload ${overrideName} which is not in --workloads`);
      }
    }
  }

  const db = new Database(outDb);
  const result = await runMatrix({ models, workloads, db, runId, corpusOverrides, concurrency });
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
