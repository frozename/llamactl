import { bench, build, ctx, env as envMod, target as targetMod } from '@llamactl/core';
import type { ModelClass } from '@llamactl/core';

const USAGE = `Usage: llamactl bench <subcommand>

Subcommands:
  show <target>             Print the latest tuned bench record for the target.
                            target may be a named preset (best, vision, fast,
                            balanced, qwen, qwen27, etc.), a rel path, or
                            'current' (default) to use LOCAL_AI_SOURCE_MODEL.

  history [target]          Print the 20 most recent bench-history rows.
                            target 'all' (default) shows every model; any
                            other value filters to that rel.

  compare [class] [scope]   Side-by-side view of tuned bench + vision rows for
                            every catalog entry. class and scope default to 'all'.
                            A 'vision=' continuation line is emitted under any
                            row that has a recorded vision bench.

  preset <target> [auto|text|vision] [--json]
                            Sweep llama-bench across the three canonical
                            profiles (default / throughput / conservative) and
                            save the fastest as the tuned record for the
                            target. --json emits the structured result.

  vision <target> [--json]  Run the real multimodal bench via llama-mtmd-cli
                            on the target's mmproj sibling and record the
                            timings into bench-vision.tsv. --json emits JSON.
`;

function printShow(opts: {
  machine: string;
  rel: string;
  mode: string;
  ctx: string;
  build: string;
  profile: string;
  gen_ts: number | string;
  prompt_ts: number | string;
  updated_at: string;
  launch_args: string;
}): void {
  const { machine, rel, mode, ctx, build, profile, gen_ts, prompt_ts, updated_at, launch_args } =
    opts;
  process.stdout.write(
    [
      `machine=${machine}`,
      `model=${rel}`,
      `mode=${mode}`,
      `ctx=${ctx}`,
      `build=${build}`,
      `profile=${profile}`,
      `gen_tps=${gen_ts}`,
      `prompt_tps=${prompt_ts}`,
      `updated_at=${updated_at}`,
      `launch_args=${launch_args}`,
      '',
    ].join('\n'),
  );
}

async function runShow(args: string[]): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }

  const target = args[0] ?? 'current';
  const rel = targetMod.resolveTarget(target);
  if (!rel) {
    process.stderr.write(`Unknown model target: ${target}\n`);
    return 1;
  }

  const resolved = envMod.resolveEnv();
  const rows = bench.readBenchProfiles(bench.benchProfileFile(resolved));
  const mode = bench.defaultModeForRel(rel, resolved);
  const ctxValue = ctx.ctxForModel(rel, resolved);
  const buildId = build.resolveBuildId(resolved);
  const machine = bench.machineLabel(resolved);

  const row = bench.findLatestProfile(rows, {
    machine,
    rel,
    mode,
    ctx: ctxValue,
    build: buildId,
  });
  if (row) {
    printShow({
      machine: row.machine,
      rel: row.rel,
      mode: row.mode,
      ctx: row.ctx,
      build: row.build,
      profile: row.profile,
      gen_ts: row.gen_ts,
      prompt_ts: row.prompt_ts,
      updated_at: row.updated_at,
      launch_args: bench.serverProfileArgs(row.profile),
    });
    return 0;
  }

  const legacy = bench.findLegacyProfile(rows, rel);
  if (legacy) {
    printShow({
      machine: 'legacy',
      rel: legacy.rel,
      mode: 'legacy',
      ctx: 'legacy',
      build: 'legacy',
      profile: legacy.profile,
      gen_ts: legacy.gen_ts,
      prompt_ts: legacy.prompt_ts,
      updated_at: legacy.updated_at,
      launch_args: bench.serverProfileArgs(legacy.profile),
    });
    return 0;
  }

  process.stdout.write(`No tuned launch profile recorded for ${rel}\n`);
  return 1;
}

async function runHistory(args: string[]): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }

  const targetArg = args[0] ?? 'all';
  const resolved = envMod.resolveEnv();
  const rows = bench.readBenchHistory(bench.benchHistoryFile(resolved));

  let filterRel: string | null = null;
  if (targetArg !== 'all' && targetArg !== '') {
    const rel = targetMod.resolveTarget(targetArg);
    if (!rel) {
      process.stderr.write(`Unknown model target: ${targetArg}\n`);
      return 1;
    }
    filterRel = rel;
  }

  // Historical shell output interleaves current and legacy rows in their
  // file order (which is append order, close enough to chronological) and
  // tail-20s the result. Mirror that by walking both lists once per line
  // in the source file — but since readBenchHistory split them, we merge
  // back by taking the last 20 across both, preserving temporal order by
  // updated_at.
  type Line = { updated_at: string; text: string };
  const lines: Line[] = [];
  for (const r of rows.current) {
    if (filterRel && r.rel !== filterRel) continue;
    lines.push({
      updated_at: r.updated_at,
      text: `${r.updated_at} | ${r.machine} | model=${r.rel} | mode=${r.mode} | ctx=${r.ctx} | build=${r.build} | profile=${r.profile} | gen_tps=${r.gen_ts} | prompt_tps=${r.prompt_ts} | launch_args=${r.launch_args}`,
    });
  }
  for (const r of rows.legacy) {
    if (filterRel && r.rel !== filterRel) continue;
    lines.push({
      updated_at: r.updated_at,
      text: `${r.updated_at} | legacy | model=${r.rel} | profile=${r.profile} | gen_tps=${r.gen_ts} | prompt_tps=${r.prompt_ts} | launch_args=${r.launch_args}`,
    });
  }

  if (lines.length === 0 && rows.current.length === 0 && rows.legacy.length === 0) {
    process.stdout.write('No benchmark history recorded yet\n');
    return 1;
  }

  lines.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  const tail = lines.slice(-20);
  for (const line of tail) process.stdout.write(`${line.text}\n`);
  return 0;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

async function runCompare(args: string[]): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }

  const classFilter = (args[0] ?? 'all') as BenchCompareClassFilter;
  const scopeFilter = args[1] ?? 'all';

  const rows = bench.benchCompare({ classFilter, scopeFilter });
  if (rows.length === 0) {
    process.stdout.write(`class=${classFilter} scope=${scopeFilter}\n`);
    return 0;
  }

  // If no row has a tuned record at all, the shell exits 1 with a "No tuned
  // launch profiles recorded yet" message. Match that behaviour.
  if (!bench.hasAnyTunedRecord(rows)) {
    process.stdout.write('No tuned launch profiles recorded yet\n');
    return 1;
  }

  process.stdout.write(`class=${classFilter} scope=${scopeFilter}\n`);

  type Tuned = NonNullable<bench.BenchCompareRow['tuned']>;
  const sortable: Array<{ row: bench.BenchCompareRow; tuned: Tuned }> = [];
  const missing: bench.BenchCompareRow[] = [];
  for (const row of rows) {
    if (row.tuned) sortable.push({ row, tuned: row.tuned });
    else missing.push(row);
  }

  sortable.sort((a, b) => {
    const ga = Number.parseFloat(a.tuned.gen_tps);
    const gb = Number.parseFloat(b.tuned.gen_tps);
    if (gb !== ga) return gb - ga;
    const pa = Number.parseFloat(a.tuned.prompt_tps);
    const pb = Number.parseFloat(b.tuned.prompt_tps);
    return pb - pa;
  });

  for (const { row, tuned } of sortable) {
    const label = padRight(row.label, 24);
    const cls = padRight(row.class, 11);
    const scope = padRight(row.scope, 16);
    const gen = padRight(tuned.gen_tps, 10);
    const prompt = padRight(tuned.prompt_tps, 10);
    const profile = padRight(tuned.profile, 12);
    const mode = padRight(row.mode, 6);
    const ctx = padRight(row.ctx, 6);
    const installed = padRight(row.installed ? 'yes' : 'no', 3);
    process.stdout.write(
      `${label} class=${cls} scope=${scope} gen=${gen} prompt=${prompt} tuned=${profile} mode=${mode} ctx=${ctx} installed=${installed} model=${row.rel}\n`,
    );
    if (row.vision) {
      const pad = padRight('', 24);
      const loadMs = padRight(row.vision.load_ms, 7);
      const encodeMs = padRight(row.vision.image_encode_ms, 5);
      const vPrompt = padRight(row.vision.prompt_tps, 9);
      const vGen = padRight(row.vision.gen_tps, 9);
      process.stdout.write(
        `${pad} vision=         load_ms=${loadMs} encode_ms=${encodeMs} prompt_tps=${vPrompt} gen_tps=${vGen} updated=${row.vision.updated_at}\n`,
      );
    }
  }

  if (missing.length > 0) {
    process.stdout.write('\nmissing_benchmarks:\n');
    for (const row of missing) {
      const label = padRight(row.label, 24);
      const cls = padRight(row.class, 11);
      const scope = padRight(row.scope, 16);
      const mode = padRight(row.mode, 6);
      const ctx = padRight(row.ctx, 6);
      const installed = padRight(row.installed ? 'yes' : 'no', 3);
      process.stdout.write(
        `${label} class=${cls} scope=${scope} mode=${mode} ctx=${ctx} installed=${installed} model=${row.rel}\n`,
      );
    }
  }

  return 0;
}

type BenchCompareClassFilter = ModelClass | 'all';

function forwardBenchEvent(e: bench.BenchEvent): void {
  if (e.type === 'stderr' || e.type === 'stdout') {
    process.stderr.write(`${e.line}\n`);
  } else if (e.type === 'start') {
    process.stderr.write(`$ ${e.command} ${e.args.join(' ')}\n`);
  } else if (e.type === 'profile-start') {
    process.stderr.write(`-- profile=${e.profile} --\n`);
  } else if (e.type === 'profile-done') {
    process.stderr.write(
      `-- profile=${e.profile} gen_ts=${e.gen_ts} prompt_ts=${e.prompt_ts} --\n`,
    );
  } else if (e.type === 'profile-fail') {
    process.stderr.write(`-- profile=${e.profile} failed (code=${e.code}) --\n`);
  }
}

async function runPreset(args: string[]): Promise<number> {
  const positional: string[] = [];
  let json = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return 0;
    } else if (arg.startsWith('--')) {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      return 1;
    } else positional.push(arg);
  }
  const target = positional[0] ?? 'current';
  const modeRaw = (positional[1] ?? 'auto') as 'auto' | 'text' | 'vision';
  if (modeRaw !== 'auto' && modeRaw !== 'text' && modeRaw !== 'vision') {
    process.stderr.write(`Unknown bench mode: ${modeRaw}\n`);
    return 1;
  }

  const result = await bench.benchPreset({
    target,
    mode: modeRaw,
    onEvent: forwardBenchEvent,
  });
  if ('error' in result) {
    if (json) process.stdout.write(`${JSON.stringify({ error: result.error }, null, 2)}\n`);
    else process.stderr.write(`${result.error}\n`);
    return 1;
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`Saved tuned launch profile for ${result.rel}\n`);
  process.stdout.write(
    `machine=${result.machine} mode=${result.mode} ctx=${result.ctx} build=${result.build}\n`,
  );
  process.stdout.write(
    `profile=${result.bestProfile} gen_tps=${result.gen_ts} prompt_tps=${result.prompt_ts}\n`,
  );
  return 0;
}

async function runVision(args: string[]): Promise<number> {
  const positional: string[] = [];
  let json = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return 0;
    } else if (arg.startsWith('--')) {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      return 1;
    } else positional.push(arg);
  }
  const target = positional[0] ?? 'current';

  const result = await bench.benchVision({ target, onEvent: forwardBenchEvent });
  if ('error' in result) {
    if (json) process.stdout.write(`${JSON.stringify({ error: result.error }, null, 2)}\n`);
    else process.stderr.write(`${result.error}\n`);
    return 1;
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`Saved vision bench record for ${result.rel}\n`);
  process.stdout.write(
    `machine=${result.machine} rel=${result.rel} ctx=${result.ctx} build=${result.build}\n`,
  );
  process.stdout.write(
    `load_ms=${result.load_ms} image_encode_ms=${result.image_encode_ms} prompt_tps=${result.prompt_tps} gen_tps=${result.gen_tps}\n`,
  );
  return 0;
}

export async function runBench(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'show':
      return runShow(rest);
    case 'history':
      return runHistory(rest);
    case 'compare':
      return runCompare(rest);
    case 'preset':
      return runPreset(rest);
    case 'vision':
      return runVision(rest);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown bench subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}
