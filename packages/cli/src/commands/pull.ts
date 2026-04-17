import { pull } from '@llamactl/core';

const USAGE = `Usage: llamactl pull <subcommand>

Subcommands:
  pull <hf-repo> [target-dir] [--json]
      Bulk pull every file in the repo. Default target is
      $LLAMA_CPP_MODELS/<repo-basename>.

  pull file <hf-repo> <gguf-file> [--json]
      Pull a single GGUF plus any mmproj sidecar the repo advertises.
      Emits { rel, wasMissing } on --json so callers (shell shim,
      Electron main) can drive post-pull auto-tune.

  pull candidate <hf-repo> [gguf-file] [profile] [--json]
      Resolve the best GGUF for the machine profile (via HF model-info
      + profile quant ladder) and pull it. The optional file override
      short-circuits the picker.

All forms stream \`hf download\` stderr to this process's stderr so the
user sees progress. With --json, child output is suppressed and only a
single JSON summary is written on stdout at the end.
`;

interface ParsedArgs {
  positional: string[];
  json: boolean;
}

function parseArgs(args: string[]): ParsedArgs | { error: string } {
  const positional: string[] = [];
  let json = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') return { error: 'help' };
    else if (arg.startsWith('--')) return { error: `Unknown flag: ${arg}` };
    else positional.push(arg);
  }
  return { positional, json };
}

/**
 * Forward child progress to this process's stderr so the user always
 * sees `hf download`'s tqdm bars, regardless of whether --json is set.
 * The only thing --json affects is the final stdout summary; child
 * output never makes it onto stdout (that would break JSON parsing).
 */
function forwardStderr() {
  return (e: pull.PullEvent) => {
    if (e.type === 'stderr' || e.type === 'stdout') {
      process.stderr.write(`${e.line}\n`);
    } else if (e.type === 'start') {
      process.stderr.write(`$ ${e.command} ${e.args.join(' ')}\n`);
    }
  };
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
    onEvent: forwardStderr(),
  });
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.code === 0) {
    process.stdout.write(`Pulled ${result.repo} into ${result.target}\n`);
  }
  return result.code === 0 ? 0 : 1;
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
    process.stderr.write('Usage: llamactl pull file <hf-repo> <gguf-file> [--json]\n');
    return 1;
  }

  const result = await pull.pullRepoFile({
    repo,
    file,
    onEvent: forwardStderr(),
  });
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.code === 0) {
    process.stdout.write(
      `Pulled ${result.rel} (wasMissing=${result.wasMissing}${result.mmproj ? `, mmproj=${result.mmproj}` : ''})\n`,
    );
  }
  return result.code === 0 ? 0 : 1;
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
      'Usage: llamactl pull candidate <hf-repo> [gguf-file] [profile] [--json]\n',
    );
    return 1;
  }

  const result = await pull.pullCandidate({
    repo,
    file,
    profile,
    onEvent: forwardStderr(),
  });
  if ('error' in result) {
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ error: result.error }, null, 2)}\n`);
    } else {
      process.stderr.write(`${result.error}\n`);
    }
    return 1;
  }
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.code === 0) {
    process.stdout.write(
      `Pulled ${result.rel} (source=${result.picked.source}, profile=${result.picked.profile}, wasMissing=${result.wasMissing}${result.mmproj ? `, mmproj=${result.mmproj}` : ''})\n`,
    );
  }
  return result.code === 0 ? 0 : 1;
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
