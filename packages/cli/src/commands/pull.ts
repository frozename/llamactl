import { autotune, bench, pull } from '@llamactl/core';

const USAGE = `Usage: llamactl pull <subcommand>

Subcommands:
  pull <hf-repo> [target-dir] [--json]
      Bulk pull every file in the repo. Default target is
      $LLAMA_CPP_MODELS/<repo-basename>. (No auto-tune.)

  pull file <hf-repo> <gguf-file> [--json] [--no-tune]
      Pull a single GGUF plus any mmproj sidecar the repo advertises.
      After a successful pull of a previously-absent file, runs
      \`bench preset\` (and \`bench vision\` when applicable) unless
      --no-tune is set or LLAMA_CPP_AUTO_TUNE_ON_PULL is disabled.

  pull candidate <hf-repo> [gguf-file] [profile] [--json] [--no-tune]
      Resolve the best GGUF for the machine profile (via HF model-info
      + profile quant ladder) and pull it. Same auto-tune behaviour as
      \`pull file\`.

All forms stream \`hf download\` / \`llama-bench\` stderr to this
process's stderr so the user sees progress. With --json, child output
is suppressed from stdout (a single JSON summary is written at the end).
`;

interface ParsedArgs {
  positional: string[];
  json: boolean;
  noTune: boolean;
}

function parseArgs(args: string[]): ParsedArgs | { error: string } {
  const positional: string[] = [];
  let json = false;
  let noTune = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '--no-tune') noTune = true;
    else if (arg === '-h' || arg === '--help') return { error: 'help' };
    else if (arg.startsWith('--')) return { error: `Unknown flag: ${arg}` };
    else positional.push(arg);
  }
  return { positional, json, noTune };
}

/**
 * Forward child output lines to stderr so tqdm + bench progress stay
 * visible regardless of --json. Accepts the union of PullEvent and
 * BenchEvent — both carry line-based events with the same shape.
 */
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

async function runPullRepo(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ('error' in parsed) {
    const stream = parsed.error === 'help' ? process.stdout : process.stderr;
    stream.write(USAGE);
    return parsed.error === 'help' ? 0 : 1;
  }
  const [repo, target] = parsed.positional;
  if (!repo) {
    process.stderr.write('Usage: llamactl pull <hf-repo> [target-dir] [--json]\n');
    return 1;
  }

  const result = await pull.pullRepo({
    repo,
    targetDir: target,
    onEvent: forwardStream,
  });
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.code === 0) {
    process.stdout.write(`Pulled ${result.repo} into ${result.target}\n`);
  }
  return result.code === 0 ? 0 : 1;
}

function printTuneSummary(report: autotune.MaybeTuneAfterPullResult): void {
  if (report.preset.ran) {
    const r = report.preset.result;
    process.stdout.write(
      `Auto-tuned ${r.rel}: profile=${r.bestProfile} gen_tps=${r.gen_ts} prompt_tps=${r.prompt_ts}\n`,
    );
  } else {
    process.stdout.write(`Auto-tune skipped: ${report.preset.reason.message}\n`);
  }
  if (report.vision.ran) {
    const v = report.vision.result;
    process.stdout.write(
      `Auto vision bench: prompt_tps=${v.prompt_tps} gen_tps=${v.gen_tps} load_ms=${v.load_ms}\n`,
    );
  } else if (report.preset.ran) {
    process.stdout.write(`Auto vision bench skipped: ${report.vision.reason.message}\n`);
  }
}

async function runPullFile(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ('error' in parsed) {
    const stream = parsed.error === 'help' ? process.stdout : process.stderr;
    stream.write(USAGE);
    return parsed.error === 'help' ? 0 : 1;
  }
  const [repo, file] = parsed.positional;
  if (!repo || !file) {
    process.stderr.write('Usage: llamactl pull file <hf-repo> <gguf-file> [--json] [--no-tune]\n');
    return 1;
  }

  const result = await pull.pullRepoFile({
    repo,
    file,
    onEvent: forwardStream,
  });
  if (result.code !== 0) {
    if (parsed.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 1;
  }

  let tune: autotune.MaybeTuneAfterPullResult | null = null;
  if (!parsed.noTune) {
    tune = await autotune.maybeTuneAfterPull({
      rel: result.rel,
      wasMissing: result.wasMissing,
      onEvent: forwardStream,
    });
  }

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ ...result, tune }, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Pulled ${result.rel} (wasMissing=${result.wasMissing}${result.mmproj ? `, mmproj=${result.mmproj}` : ''})\n`,
    );
    if (tune) printTuneSummary(tune);
  }
  return 0;
}

async function runPullCandidate(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ('error' in parsed) {
    const stream = parsed.error === 'help' ? process.stdout : process.stderr;
    stream.write(USAGE);
    return parsed.error === 'help' ? 0 : 1;
  }
  const [repo, file, profile] = parsed.positional;
  if (!repo) {
    process.stderr.write(
      'Usage: llamactl pull candidate <hf-repo> [gguf-file] [profile] [--json] [--no-tune]\n',
    );
    return 1;
  }

  const result = await pull.pullCandidate({
    repo,
    file,
    profile,
    onEvent: forwardStream,
  });
  if ('error' in result) {
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ error: result.error }, null, 2)}\n`);
    } else {
      process.stderr.write(`${result.error}\n`);
    }
    return 1;
  }
  if (result.code !== 0) {
    if (parsed.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 1;
  }

  let tune: autotune.MaybeTuneAfterPullResult | null = null;
  if (!parsed.noTune) {
    tune = await autotune.maybeTuneAfterPull({
      rel: result.rel,
      wasMissing: result.wasMissing,
      onEvent: forwardStream,
    });
  }

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ ...result, tune }, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Pulled ${result.rel} (source=${result.picked.source}, profile=${result.picked.profile}, wasMissing=${result.wasMissing}${result.mmproj ? `, mmproj=${result.mmproj}` : ''})\n`,
    );
    if (tune) printTuneSummary(tune);
  }
  return 0;
}

export async function runPull(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
    process.stdout.write(USAGE);
    return sub ? 0 : 1;
  }
  switch (sub) {
    case 'file':
      return runPullFile(rest);
    case 'candidate':
      return runPullCandidate(rest);
    default:
      // First positional wasn't a subcommand — treat the whole argv
      // as a bulk `pull <repo> [target]` call. Keeps `llamactl pull
      // <repo>` terse for the common case.
      return runPullRepo(args);
  }
}
