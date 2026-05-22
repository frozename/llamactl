import {
  startSupervisorLoop,
  defaultFleetJournalPath,
  appendFleetJournal,
  redactEndpoint,
  type SupervisorLoopOptions,
  type WorkloadTarget,
} from '@llamactl/fleet-supervisor';

const USAGE = `llamactl supervisor — fleet observability + propose-only remediation
  (PROPOSALS WRITE TO JSONL; NO ACTIONS ARE EXECUTED IN V1 — see admit for the
  gate that actually blocks bad loads.)

USAGE:
  llamactl supervisor serve [flags]
  llamactl supervisor tick  [flags]    (alias for --once)

FLAGS:
  --interval=<s>            Seconds between ticks. Default 30.
  --once                    One tick then exit.
  --journal=<path>          Override journal path.
                            Default ~/.llamactl/fleet-supervisor/journal.jsonl
  --node=<name>             Node label. Default 'local'.
  --headroom-mb=<n>         Pressure free_mb threshold. Default 512.
  --compressor-mb=<n>       Pressure compressor_mb threshold. Default 2048.
  --consecutive-ticks=<n>   Pressure consecutive-tick window. Default 3.
  --p95-degraded-ms=<n>     Per-workload p95 degradation threshold. Default 5000.
  --consecutive-errors=<n>  Per-workload consecutive-errors threshold. Default 3.
  --no-workloads            Skip workload probing (mem-only mode).
  --workload=<name@url>     Add a workload target (repeatable).
                            Format: name@url, e.g. gains-host@http://127.0.0.1:8096
  --kind=ModelHost|ModelRun Kind for subsequent --workload entries. Default ModelHost.
  --quiet                   Suppress per-tick stderr summary.

EXAMPLES:
  llamactl supervisor serve --once
  llamactl supervisor serve --once --no-workloads --quiet
  llamactl supervisor serve --interval=30 \\
    --workload=gains-host@http://127.0.0.1:8096 \\
    --workload=granite-3b@http://127.0.0.1:8083
`;

export async function runSupervisor(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(USAGE);
    return sub ? 0 : 1;
  }
  if (sub !== 'serve' && sub !== 'tick') {
    console.error(`Unknown supervisor subcommand: ${sub}`);
    console.error(USAGE);
    return 1;
  }
  let flags: Flags;
  try {
    flags = parseFlags(rest);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const once = sub === 'tick' || flags.once;

  const journalPath = flags.journal ?? defaultFleetJournalPath();
  const writeJournal = (entry: Parameters<NonNullable<SupervisorLoopOptions['writeJournal']>>[0]) =>
    appendFleetJournal(entry, journalPath);

  const loopOpts: SupervisorLoopOptions = {
    node: flags.node,
    workloads: flags.workloads,
    once,
    intervalMs: flags.intervalMs,
    writeJournal,
    pressureThresholds: {
      headroomMinMb: flags.headroomMb,
      compressorWarnMb: flags.compressorMb,
      consecutiveTicks: flags.consecutiveTicks,
    },
    degradationThresholds: {
      consecutiveErrorsForDegraded: flags.consecutiveErrors,
      p95DegradedMs: flags.p95DegradedMs,
    },
  };

  if (!flags.quiet) {
    const wlSummary = flags.workloads.length === 0
      ? '(mem-only)'
      : flags.workloads.map((w) => `${w.name}@${redactEndpoint(w.endpoint)}`).join(', ');
    process.stderr.write(`supervisor: node=${flags.node} interval=${flags.intervalMs}ms once=${once} workloads=${wlSummary}\n`);
    process.stderr.write(`supervisor: journal=${journalPath}\n`);
  }
  if (flags.noWorkloadsConflict) {
    process.stderr.write('supervisor: warning — both --no-workloads and --workload= were passed; --no-workloads wins, workloads ignored.\n');
  }

  const handle = startSupervisorLoop(loopOpts);
  if (!once) {
    process.on('SIGINT', () => handle.stop());
    process.on('SIGTERM', () => handle.stop());
  }
  await handle.done;
  return 0;
}

interface Flags {
  intervalMs: number;
  once: boolean;
  journal?: string;
  node: string;
  headroomMb: number;
  compressorMb: number;
  consecutiveTicks: number;
  p95DegradedMs: number;
  consecutiveErrors: number;
  workloads: WorkloadTarget[];
  noWorkloadsConflict: boolean;
  quiet: boolean;
}

function num(raw: string, prefix: string, fallback: number): number {
  const v = Number(raw.slice(prefix.length));
  if (!Number.isFinite(v) || v < 0) {
    throw new Error(`supervisor: ${prefix.replace(/=$/, '')} must be finite non-negative (got ${raw.slice(prefix.length)})`);
  }
  return v || fallback;
}

function parseFlags(argv: string[]): Flags {
  let intervalMs = 30_000;
  let once = false;
  let journal: string | undefined;
  let node = 'local';
  let headroomMb = 512;
  let compressorMb = 2048;
  let consecutiveTicks = 3;
  let p95DegradedMs = 5000;
  let consecutiveErrors = 3;
  let kind: 'ModelHost' | 'ModelRun' = 'ModelHost';
  const workloads: WorkloadTarget[] = [];
  let noWorkloads = false;
  let quiet = false;

  for (const raw of argv) {
    if (raw === '--once') { once = true; continue; }
    if (raw === '--no-workloads') { noWorkloads = true; continue; }
    if (raw === '--quiet') { quiet = true; continue; }
    if (raw.startsWith('--interval=')) { intervalMs = num(raw, '--interval=', 30) * 1000; continue; }
    if (raw.startsWith('--journal=')) { journal = raw.slice('--journal='.length); continue; }
    if (raw.startsWith('--node=')) { node = raw.slice('--node='.length); continue; }
    if (raw.startsWith('--headroom-mb=')) { headroomMb = num(raw, '--headroom-mb=', 512); continue; }
    if (raw.startsWith('--compressor-mb=')) { compressorMb = num(raw, '--compressor-mb=', 2048); continue; }
    if (raw.startsWith('--consecutive-ticks=')) { consecutiveTicks = num(raw, '--consecutive-ticks=', 3); continue; }
    if (raw.startsWith('--p95-degraded-ms=')) { p95DegradedMs = num(raw, '--p95-degraded-ms=', 5000); continue; }
    if (raw.startsWith('--consecutive-errors=')) { consecutiveErrors = num(raw, '--consecutive-errors=', 3); continue; }
    if (raw.startsWith('--kind=')) {
      const v = raw.slice('--kind='.length);
      if (v === 'ModelHost' || v === 'ModelRun') kind = v;
      continue;
    }
    if (raw.startsWith('--workload=')) {
      const v = raw.slice('--workload='.length);
      const [name, endpoint] = v.split('@', 2);
      if (name && endpoint) workloads.push({ name, endpoint, kind });
      continue;
    }
  }

  return {
    intervalMs,
    once,
    journal,
    node,
    headroomMb,
    compressorMb,
    consecutiveTicks,
    p95DegradedMs,
    consecutiveErrors,
    workloads: noWorkloads ? [] : workloads,
    noWorkloadsConflict: noWorkloads && workloads.length > 0,
    quiet,
  };
}
