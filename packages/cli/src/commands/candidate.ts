import { bench, candidateTest, pull } from '@llamactl/core';

const USAGE = `Usage: llamactl candidate <subcommand>

Subcommands:
  test <hf-repo> [gguf-file] [profile] [--json]
      Full candidate pipeline: pick a file, add to the custom catalog
      as a candidate row if new, pull, benchmark (preset + vision when
      applicable), then print a class-filtered bench compare.
`;

function forwardStream(e: pull.PullEvent | bench.BenchEvent): void {
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

function printCompareTable(rows: readonly bench.BenchCompareRow[]): void {
  if (rows.length === 0) return;
  const pad = (s: string, w: number) =>
    s.length >= w ? s : s + ' '.repeat(w - s.length);
  const tuned = rows.filter((r) => r.tuned);
  for (const row of tuned) {
    const t = row.tuned!;
    process.stdout.write(
      `${pad(row.label, 24)} class=${pad(row.class, 11)} gen=${pad(t.gen_tps, 10)} prompt=${pad(t.prompt_tps, 10)} tuned=${pad(t.profile, 12)} mode=${pad(row.mode, 6)} ctx=${pad(row.ctx, 6)} model=${row.rel}\n`,
    );
    if (row.vision) {
      process.stdout.write(
        `${pad('', 24)} vision=         load_ms=${pad(row.vision.load_ms, 7)} encode_ms=${pad(row.vision.image_encode_ms, 5)} prompt_tps=${pad(row.vision.prompt_tps, 9)} gen_tps=${pad(row.vision.gen_tps, 9)} updated=${row.vision.updated_at}\n`,
      );
    }
  }
}

async function runTest(args: string[]): Promise<number> {
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
  const [repo, file, profile] = positional;
  if (!repo) {
    process.stderr.write(
      'Usage: llamactl candidate test <hf-repo> [gguf-file] [profile] [--json]\n',
    );
    return 1;
  }

  const result = await candidateTest.candidateTest({
    repo,
    file,
    profile,
    onEvent: forwardStream,
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

  process.stdout.write(
    [
      `rel=${result.rel}`,
      `machine=${result.machine} mode=${result.mode} ctx=${result.ctx} build=${result.build}`,
      `curated_added=${result.curatedAdded ? 'yes' : 'no'}`,
      `pull_code=${result.pull.code} wasMissing=${result.pull.wasMissing}${result.pull.mmproj ? ` mmproj=${result.pull.mmproj}` : ''}`,
      '',
    ].join('\n'),
  );

  if (result.preset.ran && result.preset.result) {
    const p = result.preset.result;
    process.stdout.write(
      `preset: profile=${p.bestProfile} gen_tps=${p.gen_ts} prompt_tps=${p.prompt_ts}\n`,
    );
  } else {
    process.stdout.write(`preset skipped: ${result.preset.reason ?? 'no reason'}\n`);
  }

  if (result.vision.ran && result.vision.result) {
    const v = result.vision.result;
    process.stdout.write(
      `vision: load_ms=${v.load_ms} encode_ms=${v.image_encode_ms} prompt_tps=${v.prompt_tps} gen_tps=${v.gen_tps}\n`,
    );
  } else {
    process.stdout.write(`vision skipped: ${result.vision.reason ?? 'no reason'}\n`);
  }

  process.stdout.write('\ncompare:\n');
  printCompareTable(result.compare);
  return 0;
}

export async function runCandidate(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'test':
      return runTest(rest);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return sub ? 0 : 1;
    default:
      process.stderr.write(`Unknown candidate subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}
