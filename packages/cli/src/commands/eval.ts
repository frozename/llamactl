import { existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  composite,
  killServer,
  queryRows,
  renderCard,
  runContextRetrieval,
  runJsonOutput,
  runThroughput,
  runToolCalling,
  spawnServer,
  waitForHealth,
  upsertRow,
} from '../../../eval/src/index.js';
import { getGlobals } from '../dispatcher.js';

const USAGE = `Usage: llamactl eval <subcommand>

Subcommands:
  run <model> [--node <name>] [--ub <256|512>] [--all]
      Run all four sub-benches against a real llama-server, persist the
      results to SQLite, and write JSON + markdown artifacts under
      $DEV_STORAGE/eval/<run-ts>/.
  report <model>
      Regenerate the markdown report card for <model> from SQLite.
  leaderboard [--node <name>] [--sort-by <field>]
      Print the eval leaderboard table to stdout.
`;

function envValue(name: string): string {
  return process.env[name] ?? '';
}

function ensureEvalRoot(): string {
  const devStorage = envValue('DEV_STORAGE');
  if (!devStorage) throw new Error('DEV_STORAGE is not set; run eval "$(bun packages/cli/src/bin.ts env --eval)" first');
  const root = join(devStorage, 'eval');
  mkdirSync(root, { recursive: true });
  return root;
}

function modelPathForRel(rel: string): string {
  const models = envValue('LLAMA_CPP_MODELS');
  if (!models) throw new Error('LLAMA_CPP_MODELS is not set');
  return join(models, rel);
}

function parseUb(value: string | undefined): 256 | 512 {
  return value === '256' ? 256 : 512;
}

async function runEvalRun(args: string[]): Promise<number> {
  const model = args[0];
  if (!model) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  let node = 'local';
  let ub: 256 | 512 = 512;
  let all = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--node') node = args[++i] ?? node;
    else if (arg.startsWith('--node=')) node = arg.slice('--node='.length);
    else if (arg === '--ub') ub = parseUb(args[++i]);
    else if (arg.startsWith('--ub=')) ub = parseUb(arg.slice('--ub='.length));
    else if (arg === '--all') all = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return 0;
    } else {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      return 1;
    }
  }
  const evalRoot = ensureEvalRoot();
  const runTs = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(evalRoot, runTs);
  mkdirSync(runDir, { recursive: true });
  const dbPath = join(evalRoot, 'leaderboard.sqlite');
  const db = new Database(dbPath);
  const modelPath = modelPathForRel(model);
  if (!existsSync(modelPath)) {
    process.stderr.write(`missing model: ${modelPath}\n`);
    db.close();
    return 1;
  }
  const binaryRoot = envValue('LLAMA_CPP_BIN');
  if (!binaryRoot) {
    process.stderr.write('LLAMA_CPP_BIN is not set\n');
    db.close();
    return 1;
  }
  const binary = join(binaryRoot, 'llama-server');
  const ubs: Array<256 | 512> = all ? [256, 512] : [ub];
  try {
    for (const currentUb of ubs) {
      const server = await spawnServer(
        binary,
        { modelPath, port: 18181, ub: currentUb },
        join(runDir, `server-ub${currentUb}.log`),
      );
      try {
        await waitForHealth(server.url, server.proc);
        const throughput = await runThroughput(server.url);
        const toolCalling = await runToolCalling(server.url);
        const contextRetrieval = await runContextRetrieval(server.url);
        const jsonOutput = await runJsonOutput(server.url);
        const row = {
          model,
          node,
          ub: currentUb,
          throughput_tps: throughput.mean_tps,
          ttft_ms: throughput.total_wall_ms / Math.max(1, throughput.samples.length),
          tool_call_score: toolCalling.tool_call_score,
          context_8k_score: contextRetrieval.context_8192_score,
          context_16k_score: contextRetrieval.context_16384_score,
          json_score: jsonOutput.json_score,
          composite: composite({
            throughput_tps: throughput.mean_tps,
            tool_call_score: toolCalling.tool_call_score,
            context_8k_score: contextRetrieval.context_8192_score,
            context_16k_score: contextRetrieval.context_16384_score,
            json_score: jsonOutput.json_score,
          }),
          asof: new Date().toISOString(),
        };
        upsertRow(db, row);
        await Bun.write(join(runDir, `${basename(model)}-ub${currentUb}.json`), JSON.stringify({ throughput, toolCalling, contextRetrieval, jsonOutput, row }, null, 2));
      } finally {
        await killServer(server);
      }
    }
    const rows = queryRows(db, { node, sort_by: 'composite' });
    const card = renderCard({
      modelId: model,
      source: { ggufPath: modelPath, fileSizeBytes: Bun.file(modelPath).size, hfRepo: null, hfSha: null },
      hwMatrix: rows.filter((r) => r.model === model),
      subBenches: [],
    });
    const cardPath = join('docs', 'superpowers', 'specs', `${runTs.slice(0, 10)}-model-eval-${basename(model, '.gguf')}.md`);
    await Bun.write(cardPath, card);
    process.stdout.write(`${cardPath}\n`);
    return 0;
  } finally {
    db.close();
  }
}

async function runEvalReport(args: string[]): Promise<number> {
  const model = args[0];
  if (!model) return 1;
  const evalRoot = ensureEvalRoot();
  const db = new Database(join(evalRoot, 'leaderboard.sqlite'), { readonly: true });
  try {
    const rows = queryRows(db, { sort_by: 'composite' }).filter((row: { model: string }) => row.model === model);
    const card = renderCard({
      modelId: model,
      source: {
        ggufPath: modelPathForRel(model),
        fileSizeBytes: Bun.file(modelPathForRel(model)).size,
        hfRepo: null,
        hfSha: null,
      },
      hwMatrix: rows,
      subBenches: [],
    });
    const out = join('docs', 'superpowers', 'specs', `${new Date().toISOString().slice(0, 10)}-model-eval-${basename(model, '.gguf')}.md`);
    await Bun.write(out, card);
    process.stdout.write(`${out}\n`);
    return 0;
  } finally {
    db.close();
  }
}

async function runEvalLeaderboard(args: string[]): Promise<number> {
  let node = '';
  let sortBy: string = 'composite';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--node') node = args[++i] ?? '';
    else if (arg.startsWith('--node=')) node = arg.slice('--node='.length);
    else if (arg === '--sort-by') sortBy = args[++i] ?? sortBy;
    else if (arg.startsWith('--sort-by=')) sortBy = arg.slice('--sort-by='.length);
  }
  const evalRoot = ensureEvalRoot();
  const db = new Database(join(evalRoot, 'leaderboard.sqlite'), { readonly: true });
  try {
    const rows = queryRows(db, { node: node || undefined, sort_by: sortBy as any });
    const cols = ['model', 'node', 'ub', 'throughput_tps', 'tool_call_score', 'context_8k_score', 'context_16k_score', 'json_score', 'composite', 'asof'];
    process.stdout.write(`| ${cols.join(' | ')} |\n`);
    process.stdout.write(`| ${cols.map(() => '---').join(' | ')} |\n`);
    for (const row of rows) {
      process.stdout.write(
        `| ${row.model} | ${row.node} | ${row.ub} | ${row.throughput_tps.toFixed(2)} | ${row.tool_call_score.toFixed(3)} | ${row.context_8k_score.toFixed(3)} | ${row.context_16k_score == null ? 'n/a' : row.context_16k_score.toFixed(3)} | ${row.json_score.toFixed(3)} | ${row.composite.toFixed(3)} | ${row.asof} |\n`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

export async function runEval(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'run':
      return runEvalRun(rest);
    case 'report':
      return runEvalReport(rest);
    case 'leaderboard':
      return runEvalLeaderboard(rest);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return sub === undefined ? 1 : 0;
    default:
      process.stderr.write(`Unknown eval subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}
