import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NodeClient } from '@llamactl/remote';
import { getNodeClient } from '../dispatcher.js';

const USAGE = `Usage: llamactl rag bench -f <file.yaml | ->

Runs a RagBench manifest (operator-supplied query set + expected
hits) against a rag node and prints a hit-rate + mean reciprocal
rank report. Treat this as a quality gate before shipping a new
collection or after tweaking an embedder binding.

Manifest shape (YAML):

  apiVersion: llamactl/v1
  kind: RagBench
  metadata: { name: docs-quality }
  spec:
    node: kb-pg                   # required
    collection: docs              # optional — defaults to node default
    topK: 10                      # default 10; per-query override below
    queries:
      - query: how does on_duplicate replace work
        expected_doc_id: docs/rag-pipelines.md
      - query: what is the scheduler loop
        expected_substring: startPipelineScheduler
        topK: 5                   # override for this query

Each query must set \`expected_doc_id\`, \`expected_substring\`, or
both. A hit = any top-k result matches. Reports hit rate + MRR
across all queries.

Flags:
  -f <file.yaml | ->         Manifest file. '-' reads from stdin so
                             bench manifests can be piped in.
  --json                     Single-line JSON report (pipable).
  -h, --help                 Print this help.
`;

export interface RagBenchTestSeams {
  nodeClient?: NodeClient;
  readStdinYaml?: () => string;
}

let testSeams: RagBenchTestSeams = {};

export function __setRagBenchTestSeams(seams: RagBenchTestSeams): void {
  testSeams = { ...seams };
}

export function __resetRagBenchTestSeams(): void {
  testSeams = {};
}

function client(): NodeClient {
  return testSeams.nodeClient ?? getNodeClient();
}

interface Opts {
  file: string;
  json: boolean;
}

function parseFlags(args: string[]): Opts | { error: string } {
  let file = '';
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-f' || arg === '--file') {
      file = args[++i] ?? '';
    } else if (arg.startsWith('--file=')) {
      file = arg.slice('--file='.length);
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '-h' || arg === '--help') {
      return { error: 'help' };
    } else if (arg.startsWith('-')) {
      return { error: `Unknown flag: ${arg}` };
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }
  }
  if (!file) return { error: 'rag bench: -f <file.yaml | -> is required' };
  return { file, json };
}

export async function runRagBenchCli(args: string[]): Promise<number> {
  const parsed = parseFlags(args);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  let manifestYaml: string;
  if (parsed.file === '-') {
    const reader = testSeams.readStdinYaml ?? (() => readFileSync(0, 'utf8'));
    try {
      manifestYaml = reader();
    } catch (err) {
      process.stderr.write(
        `rag bench: failed reading manifest from stdin: ${(err as Error).message}\n`,
      );
      return 1;
    }
    if (!manifestYaml.trim()) {
      process.stderr.write('rag bench: stdin was empty — pipe a RagBench YAML in.\n');
      return 1;
    }
  } else {
    const absPath = resolve(parsed.file);
    if (!existsSync(absPath)) {
      process.stderr.write(`rag bench: file not found: ${absPath}\n`);
      return 1;
    }
    manifestYaml = readFileSync(absPath, 'utf8');
  }

  let report;
  try {
    report = await client().ragBench.mutate({ manifestYaml });
  } catch (err) {
    process.stderr.write(`rag bench: ${(err as Error).message}\n`);
    return 1;
  }

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  }

  // Human-readable summary. Single-screen: headline metrics first,
  // then a compact per-query breakdown (miss first so failures are
  // easy to scan to).
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push(`RagBench: ${report.manifest.metadata.name}`);
  lines.push(
    `  node ${report.manifest.spec.node}` +
      (report.manifest.spec.collection
        ? ` / collection ${report.manifest.spec.collection}`
        : '') +
      ` · topK ${report.manifest.spec.topK}`,
  );
  lines.push('');
  lines.push(
    `  hit rate  ${pct(report.hitRate)}  (${report.hits}/${report.totalQueries - report.errors} scored)`,
  );
  lines.push(`  MRR       ${report.mrr.toFixed(4)}`);
  if (report.errors > 0) {
    lines.push(`  errors    ${report.errors}`);
  }
  lines.push(`  elapsed   ${report.elapsed_ms}ms`);
  lines.push('');
  lines.push('  per-query:');
  const misses = report.perQuery.filter((q) => q.hitRank === null && !q.error);
  const errs = report.perQuery.filter((q) => q.error !== undefined);
  const hits = report.perQuery.filter((q) => q.hitRank !== null);
  for (const q of errs) {
    lines.push(`    [err ] ${q.query} — ${q.error}`);
  }
  for (const q of misses) {
    lines.push(`    [miss] ${q.query}`);
  }
  for (const q of hits) {
    lines.push(
      `    [hit ] ${q.query} — rank ${q.hitRank} via ${q.hitKind} (${q.matchedDocId})`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  // Exit non-zero when ANY query failed to hit — this is a quality
  // gate and the CI-style "treat bench result as pass/fail" pattern
  // expects a meaningful exit code.
  return report.hitRate === 1 && report.errors === 0 ? 0 : 2;
}
