import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { platform as nodePlatform, arch as nodeArch } from 'node:os';
import { infraArtifactsFetch } from '@llamactl/remote';

const USAGE = `llamactl artifacts — manage pre-built llamactl-agent binaries

USAGE:
  llamactl artifacts list
  llamactl artifacts build-agent [--target=<platform>] [--src=<path>] [--dir=<path>]
  llamactl artifacts fetch [--version=<v>] [--target=<p>] [--repo=<owner/repo>] [--dir=<path>] [--verify-sig[=mode]]
  llamactl artifacts prune [--target=<p>] [--keep=<N>] [--dir=<path>] [--execute]
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
  --verify-sig[=mode]   fetch only. Cosign-keyless signature check:
                          best-effort (default when flag is bare) —
                            verify when .sig + .cert + cosign are
                            all present; skip silently otherwise.
                          require — fail if verification cannot be
                            completed.
                          skip (default) — never touch signatures.

  --keep=<N>            prune only. Versions to keep per platform.
                        Default 3. Active version never pruned.
  --execute             prune only. Without it, prune prints the
                        dry-run plan and exits 0.

EXAMPLES:
  llamactl artifacts list
  llamactl artifacts build-agent                       # current platform
  llamactl artifacts build-agent --target=linux-x64    # cross-compile
  llamactl artifacts fetch --version=v0.4.0            # download from GitHub
  llamactl artifacts fetch --version=latest --target=linux-arm64
  llamactl artifacts prune                             # dry-run
  llamactl artifacts prune --keep=5 --execute          # actually delete
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

async function runFetch(argv: string[]): Promise<number> {
  const flags: {
    version: string;
    target: string | undefined;
    repo: string;
    dir: string;
    verifySig: 'skip' | 'best-effort' | 'require';
  } = {
    version: 'latest',
    target: (currentPlatform() as string | null) ?? undefined,
    repo: 'frozename/llamactl',
    dir: defaultArtifactsDir(),
    verifySig: 'skip',
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return 0;
    }
    // --verify-sig without a value means best-effort.
    if (arg === '--verify-sig') {
      flags.verifySig = 'best-effort';
      continue;
    }
    const eq = arg.indexOf('=');
    if (!arg.startsWith('--') || eq < 0) {
      process.stderr.write(`artifacts fetch: flags must be --key=value (${arg})\n`);
      return 1;
    }
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    switch (key) {
      case 'version':
        flags.version = value;
        break;
      case 'target':
        flags.target = value;
        break;
      case 'repo':
        flags.repo = value;
        break;
      case 'dir':
        flags.dir = value;
        break;
      case 'verify-sig':
        if (value !== 'skip' && value !== 'best-effort' && value !== 'require') {
          process.stderr.write(
            `artifacts fetch: --verify-sig must be skip|best-effort|require (got ${value})\n`,
          );
          return 1;
        }
        flags.verifySig = value;
        break;
      default:
        process.stderr.write(`artifacts fetch: unknown flag --${key}\n`);
        return 1;
    }
  }
  if (!flags.target) {
    process.stderr.write(
      `artifacts fetch: could not detect current platform (${nodePlatform()}/${nodeArch()}); pass --target=<p>.\n`,
    );
    return 1;
  }
  process.stderr.write(
    `artifacts fetch: ${flags.repo} ${flags.version} → ${flags.target}\n`,
  );
  const result = await infraArtifactsFetch.fetchAgentRelease({
    repo: flags.repo,
    version: flags.version,
    target: flags.target,
    artifactsDir: flags.dir,
    verifySig: flags.verifySig,
  });
  if (!result.ok) {
    process.stderr.write(`artifacts fetch: ${result.reason} — ${result.message}\n`);
    return 1;
  }
  const sig = result.signature;
  const sigLine =
    sig.verified === true
      ? `cosign:  verified (${sig.reason})`
      : sig.verified === false
        ? `cosign:  FAILED — ${sig.reason}`
        : `cosign:  skipped (${sig.reason})`;
  process.stdout.write(
    `${result.path}\n` +
      `  version: ${result.version}\n` +
      `  target:  ${result.target}\n` +
      `  size:    ${(result.bytes / (1024 * 1024)).toFixed(1)} MB\n` +
      `  sha256:  ${result.sha256}\n` +
      `  ${sigLine}\n`,
  );
  return 0;
}

function runPrune(argv: string[]): number {
  const flags: {
    target: string | undefined;
    keep: number;
    dir: string;
    execute: boolean;
  } = {
    target: undefined,
    keep: 3,
    dir: defaultArtifactsDir(),
    execute: false,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return 0;
    }
    if (arg === '--execute') {
      flags.execute = true;
      continue;
    }
    const eq = arg.indexOf('=');
    if (!arg.startsWith('--') || eq < 0) {
      process.stderr.write(`artifacts prune: flags must be --key=value (${arg})\n`);
      return 1;
    }
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    switch (key) {
      case 'target':
        if (!ALLOWED_PLATFORMS.includes(value as Platform)) {
          process.stderr.write(
            `artifacts prune: unsupported --target ${value} (allowed: ${ALLOWED_PLATFORMS.join(', ')})\n`,
          );
          return 1;
        }
        flags.target = value;
        break;
      case 'keep':
        {
          const n = Number.parseInt(value, 10);
          if (!Number.isFinite(n) || n < 0) {
            process.stderr.write(`artifacts prune: --keep must be a non-negative integer (got ${value})\n`);
            return 1;
          }
          flags.keep = n;
        }
        break;
      case 'dir':
        flags.dir = value;
        break;
      default:
        process.stderr.write(`artifacts prune: unknown flag --${key}\n`);
        return 1;
    }
  }
  const result = infraArtifactsFetch.pruneAgentArtifacts({
    artifactsDir: flags.dir,
    ...(flags.target !== undefined ? { target: flags.target } : {}),
    keep: flags.keep,
    execute: flags.execute,
  });
  if (result.inspected.length === 0) {
    process.stdout.write(`no versioned agent artifacts under ${flags.dir}\n`);
    return 0;
  }
  process.stdout.write(
    `artifacts prune: ${result.inspected.length} installed, keep=${flags.keep}, ` +
      `${result.candidates.length} candidate(s)${flags.execute ? '' : ' (dry-run — pass --execute to remove)'}\n`,
  );
  for (const c of result.candidates) {
    const age = Math.max(0, Math.floor((Date.now() - c.mtimeMs) / 86400_000));
    const sizeMb = (c.bytes / (1024 * 1024)).toFixed(1);
    const mark = flags.execute
      ? result.removed.some((r) => r.path === c.path)
        ? 'REMOVED'
        : 'FAILED '
      : 'WOULD  ';
    process.stdout.write(
      `  ${mark}\t${c.target}\t${c.tag}\t${sizeMb} MB\t${age}d old\t${c.path}\n`,
    );
  }
  if (flags.execute && result.removed.length !== result.candidates.length) {
    process.stderr.write(
      `artifacts prune: ${result.candidates.length - result.removed.length} candidate(s) could not be removed — inspect manually\n`,
    );
    return 1;
  }
  return 0;
}

export async function runArtifacts(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'list':
      return runList(rest);
    case 'prune':
      return runPrune(rest);
    case 'build-agent':
      return runBuildAgent(rest);
    case 'fetch':
      return runFetch(rest);
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
