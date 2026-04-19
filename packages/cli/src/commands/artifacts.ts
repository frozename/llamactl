import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { platform as nodePlatform, arch as nodeArch } from 'node:os';

const USAGE = `llamactl artifacts — manage pre-built llamactl-agent binaries

USAGE:
  llamactl artifacts list
  llamactl artifacts build-agent [--target=<platform>] [--src=<path>] [--dir=<path>]
  llamactl artifacts show-path [--target=<platform>] [--dir=<path>]

Pre-built binaries live under <LLAMACTL_ARTIFACTS_DIR or
\$DEV_STORAGE/artifacts or ~/.llamactl/artifacts>/agent/<platform>/
and are served by central's /artifacts/agent/<platform> endpoint.

build-agent runs \`bun build --compile\` against packages/cli/src/bin.ts
to produce a self-contained binary. Works only from a source checkout;
pre-compiled llamactl binaries can't rebuild themselves. Pass --src to
override the source path when the heuristic (relative to this module's
own __dirname) doesn't find bin.ts.

FLAGS:
  --target=<platform>   darwin-arm64 | darwin-x64 | linux-x64 |
                        linux-arm64. Default: the current host.
  --src=<path>          Path to packages/cli/src/bin.ts. Default: auto.
  --dir=<path>          Override the artifacts directory.

EXAMPLES:
  llamactl artifacts list
  llamactl artifacts build-agent                       # current platform
  llamactl artifacts build-agent --target=linux-x64    # cross-compile
  llamactl artifacts show-path --target=linux-arm64
`;

type Platform = 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64';
const ALLOWED_PLATFORMS: Platform[] = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];

function currentPlatform(): Platform | null {
  const p = nodePlatform();
  const a = nodeArch();
  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64';
  if (p === 'darwin' && a === 'x64') return 'darwin-x64';
  if (p === 'linux' && a === 'x64') return 'linux-x64';
  if (p === 'linux' && a === 'arm64') return 'linux-arm64';
  return null;
}

function defaultArtifactsDir(): string {
  const override = process.env.LLAMACTL_ARTIFACTS_DIR?.trim();
  if (override) return override;
  const base = process.env.DEV_STORAGE?.trim() || join(process.env.HOME ?? '.', '.llamactl');
  return join(base, 'artifacts');
}

function agentBinaryPath(platform: Platform, dir: string): string {
  return join(dir, 'agent', platform, 'llamactl-agent');
}

/**
 * Locate packages/cli/src/bin.ts relative to this module. Works for
 * `bun run` / `bun <abs-path>` invocations where import.meta.dir is
 * a real filesystem path — the typical source-checkout case. Fails
 * gracefully when llamactl is running as a bun-compile'd binary (no
 * source alongside the binary).
 */
function resolveSourceDefault(): string | null {
  // import.meta.dir of this file is `.../packages/cli/src/commands`.
  // bin.ts sits one directory up.
  const candidate = resolve(import.meta.dir, '..', 'bin.ts');
  return existsSync(candidate) ? candidate : null;
}

interface BuildFlags {
  target: Platform;
  src: string | null;
  dir: string;
}

function parseBuildFlags(argv: string[]): BuildFlags | { error: string } {
  const current = currentPlatform();
  const flags: BuildFlags = {
    target: current ?? 'darwin-arm64',
    src: resolveSourceDefault(),
    dir: defaultArtifactsDir(),
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { error: '__help' };
    const eq = arg.indexOf('=');
    if (!arg.startsWith('--') || eq < 0) {
      return { error: `artifacts build-agent: flags must be --key=value (${arg})` };
    }
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    switch (key) {
      case 'target':
        if (!ALLOWED_PLATFORMS.includes(value as Platform)) {
          return {
            error: `artifacts build-agent: unsupported --target ${value} (allowed: ${ALLOWED_PLATFORMS.join(', ')})`,
          };
        }
        flags.target = value as Platform;
        break;
      case 'src':
        flags.src = value;
        break;
      case 'dir':
        flags.dir = value;
        break;
      default:
        return { error: `artifacts build-agent: unknown flag --${key}` };
    }
  }
  return flags;
}

async function runBuildAgent(argv: string[]): Promise<number> {
  const parsed = parseBuildFlags(argv);
  if ('error' in parsed) {
    if (parsed.error === '__help') {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  if (!parsed.src) {
    process.stderr.write(
      'artifacts build-agent: could not locate packages/cli/src/bin.ts.\n' +
        'Running llamactl from a compiled binary? Use --src=<path-to-source-repo>/packages/cli/src/bin.ts,\n' +
        'or re-run from a source checkout.\n',
    );
    return 1;
  }
  const outPath = agentBinaryPath(parsed.target, parsed.dir);
  mkdirSync(dirname(outPath), { recursive: true });
  process.stderr.write(
    `artifacts build-agent: bun build --compile --target=bun-${parsed.target}\n` +
      `  src: ${parsed.src}\n  out: ${outPath}\n`,
  );
  const proc = Bun.spawn({
    cmd: [
      'bun',
      'build',
      '--compile',
      `--target=bun-${parsed.target}`,
      parsed.src,
      '--outfile',
      outPath,
    ],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) {
    process.stderr.write(`artifacts build-agent: bun build exited ${code}\n`);
    return code === 0 ? 0 : 1;
  }
  process.stderr.write(`artifacts build-agent: wrote ${outPath}\n`);
  return 0;
}

function runList(argv: string[]): number {
  let dir = defaultArtifactsDir();
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return 0;
    }
    const eq = arg.indexOf('=');
    if (arg.startsWith('--dir=') && eq >= 0) {
      dir = arg.slice(eq + 1);
      continue;
    }
    process.stderr.write(`artifacts list: unknown arg ${arg}\n`);
    return 1;
  }
  const rows: Array<{ platform: Platform; path: string; sizeBytes: number }> = [];
  for (const platform of ALLOWED_PLATFORMS) {
    const path = agentBinaryPath(platform, dir);
    if (!existsSync(path)) continue;
    const size = Bun.file(path).size;
    rows.push({ platform, path, sizeBytes: size });
  }
  if (rows.length === 0) {
    process.stdout.write(`no agent binaries under ${dir}/agent/\n`);
    return 0;
  }
  for (const row of rows) {
    process.stdout.write(
      `${row.platform}\t${(row.sizeBytes / (1024 * 1024)).toFixed(1)} MB\t${row.path}\n`,
    );
  }
  return 0;
}

function runShowPath(argv: string[]): number {
  const current = currentPlatform();
  let target: Platform | null = current;
  let dir = defaultArtifactsDir();
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return 0;
    }
    const eq = arg.indexOf('=');
    if (eq < 0) {
      process.stderr.write(`artifacts show-path: unknown arg ${arg}\n`);
      return 1;
    }
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    if (key === 'target') {
      if (!ALLOWED_PLATFORMS.includes(value as Platform)) {
        process.stderr.write(`artifacts show-path: unsupported --target ${value}\n`);
        return 1;
      }
      target = value as Platform;
    } else if (key === 'dir') {
      dir = value;
    } else {
      process.stderr.write(`artifacts show-path: unknown flag --${key}\n`);
      return 1;
    }
  }
  if (!target) {
    process.stderr.write(
      `artifacts show-path: could not detect current platform (${nodePlatform()}/${nodeArch()}); pass --target=<p>.\n`,
    );
    return 1;
  }
  process.stdout.write(`${agentBinaryPath(target, dir)}\n`);
  return 0;
}

export async function runArtifacts(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'list':
      return runList(rest);
    case 'build-agent':
      return runBuildAgent(rest);
    case 'show-path':
      return runShowPath(rest);
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`artifacts: unknown subcommand ${sub}\n\n${USAGE}`);
      return 1;
  }
}
