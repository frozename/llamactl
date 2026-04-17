import { bench, build, ctx, env as envMod, target as targetMod } from '@llamactl/core';

const USAGE = `Usage: llamactl bench <subcommand>

Subcommands:
  show <target>             Print the latest tuned bench record for the target.
                            target may be a named preset (best, vision, fast,
                            balanced, qwen, qwen27, etc.), a rel path, or
                            'current' (default) to use LOCAL_AI_SOURCE_MODEL.

  history [target]          Print the 20 most recent bench-history rows.
                            target 'all' (default) shows every model; any
                            other value filters to that rel.
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

export async function runBench(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'show':
      return runShow(rest);
    case 'history':
      return runHistory(rest);
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
