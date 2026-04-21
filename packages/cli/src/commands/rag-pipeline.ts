import { existsSync, readFileSync, statSync, watchFile, unwatchFile } from 'node:fs';
import { resolve } from 'node:path';
import type { NodeClient } from '@llamactl/remote';
import { getNodeClient } from '../dispatcher.js';

const USAGE = `Usage: llamactl rag pipeline <subcommand>

Subcommands:
  apply -f <file.yaml>
      Persist a RagPipeline manifest under
      $DEV_STORAGE/rag-pipelines/<name>/spec.yaml. Does not execute.

  run <name> [--dry-run] [--json]
      Execute an applied pipeline. --dry-run walks fetch + chunk
      without calling adapter.store. --json emits a single-line
      RunSummary.

  list [--json]
      Enumerate every applied pipeline with its last-run summary.

  get <name>
      Print the stored manifest as YAML.

  rm <name>
      Delete the spec + journal + state. Does not touch already-
      stored documents in the destination rag node.

  logs <name> [--follow] [--tail=<N>]
      Stream the ingest journal. Default --tail=50.
      --follow polls at 500ms intervals.
`;

export interface RagPipelineTestSeams {
  nodeClient?: NodeClient;
  /** Override the journal file resolver for logs tests. Default maps
   *  through the remote package's `journalPathFor(name)`. */
  journalPathFor?: (name: string) => string;
}

let testSeams: RagPipelineTestSeams = {};

export function __setRagPipelineTestSeams(seams: RagPipelineTestSeams): void {
  testSeams = { ...seams };
}

export function __resetRagPipelineTestSeams(): void {
  testSeams = {};
}

function client(): NodeClient {
  return testSeams.nodeClient ?? getNodeClient();
}

export async function runRagPipeline(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'apply':
      return runApply(rest);
    case 'run':
      return runRun(rest);
    case 'list':
    case 'ls':
      return runList(rest);
    case 'get':
      return runGet(rest);
    case 'rm':
    case 'remove':
      return runRemove(rest);
    case 'logs':
      return runLogs(rest);
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown rag pipeline subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}

// ---- apply ----------------------------------------------------------

interface ApplyOpts {
  file: string;
}

function parseApplyFlags(args: string[]): ApplyOpts | { error: string } {
  let file = '';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-f' || arg === '--file') {
      file = args[++i] ?? '';
    } else if (arg.startsWith('--file=')) {
      file = arg.slice('--file='.length);
    } else if (arg === '-h' || arg === '--help') {
      return { error: 'help' };
    } else if (arg.startsWith('-')) {
      return { error: `Unknown flag: ${arg}` };
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }
  }
  if (!file) return { error: 'rag pipeline apply: -f <file.yaml> is required' };
  return { file };
}

async function runApply(args: string[]): Promise<number> {
  const parsed = parseApplyFlags(args);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  const absPath = resolve(parsed.file);
  if (!existsSync(absPath)) {
    process.stderr.write(`rag pipeline apply: file not found: ${absPath}\n`);
    return 1;
  }
  const manifestYaml = readFileSync(absPath, 'utf8');
  try {
    const res = await client().ragPipelineApply.mutate({ manifestYaml });
    process.stdout.write(
      `${res.created ? 'applied' : 'updated'} rag pipeline '${res.name}'\n  path: ${res.path}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`rag pipeline apply: ${(err as Error).message}\n`);
    return 1;
  }
}

// ---- run ------------------------------------------------------------

interface RunOpts {
  name: string;
  dryRun: boolean;
  json: boolean;
}

function parseRunFlags(args: string[]): RunOpts | { error: string } {
  let name = '';
  let dryRun = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') return { error: 'help' };
    else if (arg.startsWith('-')) return { error: `Unknown flag: ${arg}` };
    else if (!name) name = arg;
    else return { error: `Unexpected argument: ${arg}` };
  }
  if (!name) return { error: 'rag pipeline run: <name> is required' };
  return { name, dryRun, json };
}

async function runRun(args: string[]): Promise<number> {
  const parsed = parseRunFlags(args);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  try {
    const res = await client().ragPipelineRun.mutate({
      name: parsed.name,
      dryRun: parsed.dryRun,
    });
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
      return 0;
    }
    const s = res.summary;
    process.stdout.write(
      `${parsed.dryRun ? 'dry-ran' : 'ran'} pipeline '${parsed.name}' in ${s.elapsed_ms}ms\n` +
        `  total_docs: ${s.total_docs} (skipped ${s.skipped_docs})\n` +
        `  total_chunks: ${s.total_chunks}\n` +
        `  errors: ${s.errors}\n` +
        `  per_source:\n` +
        s.per_source
          .map(
            (p) =>
              `    - ${p.source}  docs=${p.docs} chunks=${p.chunks} errors=${p.errors}`,
          )
          .join('\n') +
        '\n',
    );
    return 0;
  } catch (err) {
    process.stderr.write(`rag pipeline run: ${(err as Error).message}\n`);
    return 1;
  }
}

// ---- list -----------------------------------------------------------

async function runList(args: string[]): Promise<number> {
  const json = args.includes('--json');
  for (const a of args) {
    if (a !== '--json' && a !== '-h' && a !== '--help') {
      process.stderr.write(`Unknown flag: ${a}\n\n${USAGE}`);
      return 1;
    }
    if (a === '-h' || a === '--help') {
      process.stdout.write(USAGE);
      return 0;
    }
  }
  try {
    const res = await client().ragPipelineList.query();
    if (json) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
      return 0;
    }
    if (res.pipelines.length === 0) {
      process.stdout.write('(no rag pipelines applied)\n');
      return 0;
    }
    for (const p of res.pipelines) {
      const dest = `${p.manifest.spec.destination.ragNode}/${p.manifest.spec.destination.collection}`;
      const sources = p.manifest.spec.sources.map((s) => s.kind).join(',');
      const last = p.lastRun
        ? `last=${p.lastRun.at} docs=${p.lastRun.summary.total_docs} chunks=${p.lastRun.summary.total_chunks}`
        : 'never-run';
      process.stdout.write(
        `${p.name}\n  → ${dest}  (sources: ${sources})  ${last}\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`rag pipeline list: ${(err as Error).message}\n`);
    return 1;
  }
}

// ---- get ------------------------------------------------------------

async function runGet(args: string[]): Promise<number> {
  const [name] = args;
  if (!name || name.startsWith('-')) {
    process.stderr.write(`rag pipeline get: <name> is required\n\n${USAGE}`);
    return 1;
  }
  try {
    const res = await client().ragPipelineGet.query({ name });
    const { stringify } = await import('yaml');
    process.stdout.write(stringify(res.manifest));
    return 0;
  } catch (err) {
    process.stderr.write(`rag pipeline get: ${(err as Error).message}\n`);
    return 1;
  }
}

// ---- rm -------------------------------------------------------------

async function runRemove(args: string[]): Promise<number> {
  const [name] = args;
  if (!name || name.startsWith('-')) {
    process.stderr.write(`rag pipeline rm: <name> is required\n\n${USAGE}`);
    return 1;
  }
  try {
    const res = await client().ragPipelineRemove.mutate({ name });
    if (!res.removed) {
      process.stderr.write(`rag pipeline rm: '${name}' not found\n`);
      return 1;
    }
    process.stdout.write(`removed rag pipeline '${name}'\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`rag pipeline rm: ${(err as Error).message}\n`);
    return 1;
  }
}

// ---- logs -----------------------------------------------------------

interface LogsOpts {
  name: string;
  follow: boolean;
  tail: number;
}

function parseLogsFlags(args: string[]): LogsOpts | { error: string } {
  let name = '';
  let follow = false;
  let tail = 50;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--follow' || arg === '-f') follow = true;
    else if (arg.startsWith('--tail=')) {
      const n = Number.parseInt(arg.slice('--tail='.length), 10);
      if (!Number.isFinite(n) || n < 0) return { error: `--tail must be a non-negative integer` };
      tail = n;
    } else if (arg === '--tail') {
      const raw = args[++i];
      const n = Number.parseInt(raw ?? '', 10);
      if (!Number.isFinite(n) || n < 0) return { error: `--tail must be a non-negative integer` };
      tail = n;
    } else if (arg === '-h' || arg === '--help') return { error: 'help' };
    else if (arg.startsWith('-')) return { error: `Unknown flag: ${arg}` };
    else if (!name) name = arg;
    else return { error: `Unexpected argument: ${arg}` };
  }
  if (!name) return { error: 'rag pipeline logs: <name> is required' };
  return { name, follow, tail };
}

async function runLogs(args: string[]): Promise<number> {
  const parsed = parseLogsFlags(args);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  const resolveJournal =
    testSeams.journalPathFor ??
    (async (name: string): Promise<string> => {
      const { journalPathFor } = await import('@llamactl/remote');
      return journalPathFor(name);
    });
  const path =
    typeof resolveJournal === 'function'
      ? await Promise.resolve(resolveJournal(parsed.name))
      : resolveJournal;
  if (!existsSync(path)) {
    process.stderr.write(
      `rag pipeline logs: no journal at ${path} — has the pipeline been run?\n`,
    );
    return 1;
  }
  // Print the last --tail entries.
  const contents = readFileSync(path, 'utf8');
  const lines = contents.split('\n').filter((l) => l.trim().length > 0);
  const start = parsed.tail === 0 ? 0 : Math.max(0, lines.length - parsed.tail);
  for (let i = start; i < lines.length; i++) {
    process.stdout.write(`${lines[i]}\n`);
  }
  if (!parsed.follow) return 0;

  // --follow: watchFile polls every 500ms; emit new lines since the
  // last emitted byte offset. This is portable across platforms where
  // fs.watch event firing is inconsistent for append-only files.
  let lastSize = statSync(path).size;
  await new Promise<void>((res) => {
    const stop = (): void => {
      unwatchFile(path);
      res();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    watchFile(path, { interval: 500 }, (curr) => {
      if (curr.size <= lastSize) return;
      const tailBytes = readFileSync(path, 'utf8').slice(lastSize);
      process.stdout.write(tailBytes);
      lastSize = curr.size;
    });
  });
  return 0;
}
