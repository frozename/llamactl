import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import type {
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from 'node:child_process';
import { infraArtifactsFetch } from '@llamactl/remote';
import {
  agentBinaryPath,
  ALLOWED_PLATFORMS,
  buildAgentBinary,
  currentPlatform,
  defaultArtifactsDir,
  resolveSourceDefault,
  type Platform,
} from '../artifacts.js';
import {
  buildSystemPlist,
  buildUserPlist,
  type BuildPlistOptions,
} from './templates.js';

/**
 * `llamactl agent install-launchd` — resolve an agent binary, render a
 * launchd plist via Phase 2 templates, write it, launchctl-load it,
 * and poll for a healthy PID. See
 * `/Users/acordeiro/.claude/plans/agent-binary-install-flow.md` Phase 3
 * for the design rationale.
 */

export const INSTALL_LAUNCHD_USAGE = `Usage: llamactl agent install-launchd [flags]

Install the agent as a macOS LaunchAgent (user scope) or LaunchDaemon
(system scope), starting from either a fetched release binary, a local
bun build --compile, or a caller-supplied path.

Flags (all --key=value):
  --scope=user|system          default: user
  --binary=<path>              use an existing binary at this path
  --from-release=<tag>         fetch from GitHub Release vX.Y.Z
  --from-source                build locally via artifacts build-agent
  --install-path=<path>        target install path
                               default: /usr/local/bin/llamactl-agent
  --dir=<path>                 agent data dir (passed to \`agent serve --dir=\`)
                               default: \$DEV_STORAGE/agent/<node-name-or-hostname>
  --log-dir=<path>             launchd stdout/stderr log dir
                               default: \$HOME/.llamactl-launchd-logs
  --env=KEY=VAL                additional env vars for the plist;
                               repeatable: --env=HF_HOME=/foo --env=DEV_STORAGE=/bar
  --label=<label>              service label
                               default: com.llamactl.agent (user)
                                        com.llamactl.agent.daemon (system)
  --repo=<owner/repo>          for --from-release; default: frozename/llamactl
  --dry-run                    print plist + launchctl plan; no disk writes
  --force                      overwrite existing plist + binary

--binary / --from-release / --from-source are mutually exclusive. If
none is given, --from-source is assumed.
`;

// -----------------------------------------------------------------------------
// Dependency-injection surface (for tests)
// -----------------------------------------------------------------------------

/**
 * Minimal child_process.spawnSync signature we rely on. Narrowed to the
 * `encoding: 'utf8'` overload — every launchctl/plutil invocation in
 * this module reads string stdout/stderr.
 */
export type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

/**
 * The fs surface the handler needs. Kept narrow so tests don't
 * accidentally widen coupling to the full node:fs module.
 */
export interface FsLike {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  writeFileSync: typeof writeFileSync;
  readFileSync: typeof readFileSync;
  chmodSync: typeof chmodSync;
  copyFileSync: typeof copyFileSync;
  unlinkSync: typeof unlinkSync;
  statSync: typeof statSync;
  accessSync: typeof accessSync;
}

/**
 * Release-fetch surface — matches `infraArtifactsFetch.fetchAgentRelease`
 * exactly so the default wiring is a plain passthrough.
 */
export type FetchAgentReleaseFn = typeof infraArtifactsFetch.fetchAgentRelease;

/**
 * Local-build surface — matches `buildAgentBinary` from artifacts.ts.
 */
export type BuildAgentBinaryFn = typeof buildAgentBinary;

/**
 * sleeper(ms) is the polling-interval `setTimeout` wrapper. Injectable so
 * tests can drive the poll loop without burning 500ms intervals.
 */
export type Sleeper = (ms: number) => Promise<void>;

/** Clock surface for deterministic polling. */
export type NowFn = () => number;

export interface InstallLaunchdDeps {
  spawnSync: SpawnSyncLike;
  fs: FsLike;
  fetchAgentRelease: FetchAgentReleaseFn;
  buildAgentBinary: BuildAgentBinaryFn;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  now: NowFn;
  sleep: Sleeper;
  /** Allows tests to pretend to be root. Defaults to process.getuid. */
  getuid: () => number;
  /** Platform override for tests. Defaults to process.platform. */
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

function defaultDeps(): InstallLaunchdDeps {
  return {
    spawnSync: nodeSpawnSync as unknown as SpawnSyncLike,
    fs: {
      existsSync,
      mkdirSync,
      writeFileSync,
      readFileSync,
      chmodSync,
      copyFileSync,
      unlinkSync,
      statSync,
      accessSync,
    },
    fetchAgentRelease: infraArtifactsFetch.fetchAgentRelease,
    buildAgentBinary,
    stdout: (chunk: string): void => {
      process.stdout.write(chunk);
    },
    stderr: (chunk: string): void => {
      process.stderr.write(chunk);
    },
    now: Date.now,
    sleep: (ms: number): Promise<void> =>
      new Promise((r) => setTimeout(r, ms)),
    // process.getuid is missing on Windows; install-launchd is a
    // macOS-only command, so the process.platform guard upstream
    // short-circuits before this ever runs there.
    getuid: (): number =>
      typeof process.getuid === 'function' ? process.getuid() : 0,
    platform: process.platform,
    env: process.env,
  };
}

// -----------------------------------------------------------------------------
// Flag parsing
// -----------------------------------------------------------------------------

export type BinarySource =
  | { kind: 'binary'; path: string }
  | { kind: 'release'; tag: string }
  | { kind: 'source' };

export interface InstallLaunchdFlags {
  scope: 'user' | 'system';
  source: BinarySource;
  installPath: string;
  /** Undefined → resolved later from dev storage + node name. */
  dir: string | undefined;
  logDir: string | undefined;
  /** Extra env vars from --env=KEY=VAL (repeatable). */
  envOverrides: Record<string, string>;
  label: string | undefined;
  repo: string;
  dryRun: boolean;
  force: boolean;
}

export function parseInstallLaunchdFlags(
  argv: string[],
): InstallLaunchdFlags | { error: string } {
  let scope: 'user' | 'system' = 'user';
  let binaryPath: string | undefined;
  let releaseTag: string | undefined;
  let fromSource = false;
  let installPath = '/usr/local/bin/llamactl-agent';
  let dir: string | undefined;
  let logDir: string | undefined;
  const envOverrides: Record<string, string> = {};
  let label: string | undefined;
  let repo = 'frozename/llamactl';
  let dryRun = false;
  let force = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      return { error: '__help' };
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg === '--from-source') {
      fromSource = true;
      continue;
    }
    const [k, v] = splitFlag(arg);
    if (v === undefined) {
      return {
        error: `agent install-launchd: flag must be --key=value (or a known bare flag): ${arg}`,
      };
    }
    switch (k) {
      case '--scope':
        if (v !== 'user' && v !== 'system') {
          return { error: `agent install-launchd: --scope must be user|system (got ${v})` };
        }
        scope = v;
        break;
      case '--binary':
        binaryPath = v;
        break;
      case '--from-release':
        if (v.length === 0) {
          return { error: 'agent install-launchd: --from-release requires a tag (e.g. v0.4.0)' };
        }
        releaseTag = v;
        break;
      case '--install-path':
        installPath = v;
        break;
      case '--dir':
        dir = v;
        break;
      case '--log-dir':
        logDir = v;
        break;
      case '--env': {
        const eq = v.indexOf('=');
        if (eq <= 0) {
          return { error: `agent install-launchd: --env must be KEY=VAL (got ${v})` };
        }
        const key = v.slice(0, eq);
        const value = v.slice(eq + 1);
        envOverrides[key] = value;
        break;
      }
      case '--label':
        label = v;
        break;
      case '--repo':
        repo = v;
        break;
      default:
        return { error: `agent install-launchd: unknown flag ${k}` };
    }
  }

  // Mutual exclusivity — at most one of --binary, --from-release,
  // --from-source. If none set, default to --from-source.
  const sourceFlags = [
    binaryPath !== undefined ? 'binary' : null,
    releaseTag !== undefined ? 'release' : null,
    fromSource ? 'source' : null,
  ].filter((x): x is string => x !== null);
  if (sourceFlags.length > 1) {
    return {
      error:
        'agent install-launchd: --binary, --from-release, --from-source are mutually exclusive ' +
        `(got: ${sourceFlags.join(', ')})`,
    };
  }
  let source: BinarySource;
  if (binaryPath !== undefined) {
    source = { kind: 'binary', path: binaryPath };
  } else if (releaseTag !== undefined) {
    source = { kind: 'release', tag: releaseTag };
  } else {
    source = { kind: 'source' };
  }

  return {
    scope,
    source,
    installPath,
    dir,
    logDir,
    envOverrides,
    label,
    repo,
    dryRun,
    force,
  };
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf('=');
  if (eq < 0) return [arg, undefined];
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

// -----------------------------------------------------------------------------
// Platform detection
// -----------------------------------------------------------------------------

/**
 * Map a (platform, arch) tuple to the bun-compile target slug used for
 * release assets. Returns null on unsupported combinations. This is a
 * thin wrapper over {@link currentPlatform} from artifacts.ts —
 * duplicated here only as a named alias so the install-launchd
 * subcommand reads naturally. Could be centralised later.
 */
export function currentBunTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): Platform | null {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  return null;
}

// -----------------------------------------------------------------------------
// Binary resolution
// -----------------------------------------------------------------------------

export interface ResolveBinaryOptions {
  source: BinarySource;
  installPath: string;
  scope: 'user' | 'system';
  repo: string;
  dryRun: boolean;
  deps: InstallLaunchdDeps;
}

/**
 * Resolve a binary according to `opts.source` and leave it at
 * `opts.installPath` with mode 0755. Returns the install path on
 * success; throws on failure with a human-readable message.
 */
export async function resolveBinary(opts: ResolveBinaryOptions): Promise<string> {
  const { source, installPath, scope, repo, dryRun, deps } = opts;

  // System-scope writes to /usr/local/bin or /opt typically need root.
  // Fail fast rather than silently producing a permissions error halfway
  // through the flow.
  if (scope === 'system' && looksLikePrivilegedPath(installPath) && deps.getuid() !== 0) {
    throw new Error(
      `Installing to ${installPath} requires root. Re-run with sudo, or use ` +
        `--install-path=<writable-path>.`,
    );
  }

  if (source.kind === 'binary') {
    return resolveBinaryFromPath(source.path, installPath, dryRun, deps);
  }
  if (source.kind === 'release') {
    return resolveBinaryFromRelease(source.tag, installPath, repo, dryRun, deps);
  }
  return resolveBinaryFromSource(installPath, dryRun, deps);
}

function looksLikePrivilegedPath(p: string): boolean {
  return p.startsWith('/usr/local/') || p.startsWith('/opt/') || p.startsWith('/usr/bin/');
}

function resolveBinaryFromPath(
  sourcePath: string,
  installPath: string,
  dryRun: boolean,
  deps: InstallLaunchdDeps,
): string {
  if (!deps.fs.existsSync(sourcePath)) {
    throw new Error(`--binary=${sourcePath} does not exist`);
  }
  try {
    deps.fs.accessSync(sourcePath, fsConstants.X_OK);
  } catch {
    throw new Error(`--binary=${sourcePath} is not executable (run chmod +x)`);
  }
  if (sourcePath === installPath) {
    return installPath;
  }
  if (!dryRun) {
    deps.fs.mkdirSync(dirname(installPath), { recursive: true });
    deps.fs.copyFileSync(sourcePath, installPath);
    deps.fs.chmodSync(installPath, 0o755);
    try {
      deps.fs.accessSync(installPath, fsConstants.X_OK);
    } catch {
      throw new Error(
        `binary copied to ${installPath} but is not executable — check filesystem permissions`,
      );
    }
  }
  return installPath;
}

async function resolveBinaryFromRelease(
  tag: string,
  installPath: string,
  repo: string,
  dryRun: boolean,
  deps: InstallLaunchdDeps,
): Promise<string> {
  const target = currentBunTarget(deps.platform, process.arch);
  if (!target) {
    throw new Error(
      `--from-release: could not detect current bun target for platform=${deps.platform} arch=${process.arch}`,
    );
  }
  if (dryRun) {
    deps.stderr(
      `agent install-launchd: would fetch ${repo}@${tag} for ${target} ` +
        `and install to ${installPath}\n`,
    );
    return installPath;
  }
  deps.stderr(
    `agent install-launchd: fetching ${repo}@${tag} for ${target}…\n`,
  );
  const result = await deps.fetchAgentRelease({
    repo,
    version: tag,
    target,
    verifySig: 'best-effort',
  });
  if (!result.ok) {
    throw new Error(
      `agent install-launchd: release fetch failed (${result.reason}) — ${result.message}`,
    );
  }
  deps.fs.mkdirSync(dirname(installPath), { recursive: true });
  deps.fs.copyFileSync(result.path, installPath);
  deps.fs.chmodSync(installPath, 0o755);
  try {
    deps.fs.accessSync(installPath, fsConstants.X_OK);
  } catch {
    throw new Error(
      `binary copied to ${installPath} but is not executable — check filesystem permissions`,
    );
  }
  return installPath;
}

async function resolveBinaryFromSource(
  installPath: string,
  dryRun: boolean,
  deps: InstallLaunchdDeps,
): Promise<string> {
  const target = currentBunTarget(deps.platform, process.arch);
  if (!target) {
    throw new Error(
      `--from-source: could not detect current bun target for platform=${deps.platform} arch=${process.arch}`,
    );
  }
  const src = resolveSourceDefault();
  const artifactsDir = defaultArtifactsDir();
  const producedPath = agentBinaryPath(target, artifactsDir);
  if (dryRun) {
    deps.stderr(
      `agent install-launchd: would build ${target} from source ` +
        `(src: ${src ?? 'auto-detect'}) → ${producedPath} → ${installPath}\n`,
    );
    return installPath;
  }
  deps.stderr(
    `agent install-launchd: building ${target} from source (src: ${src ?? 'auto-detect'})…\n`,
  );
  const result = await deps.buildAgentBinary({
    target,
    src,
    dir: artifactsDir,
  });
  if (!result.ok) {
    const why = result.reason ?? `bun build exited ${result.code}`;
    throw new Error(`agent install-launchd: local build failed — ${why}`);
  }
  deps.fs.mkdirSync(dirname(installPath), { recursive: true });
  deps.fs.copyFileSync(result.outPath, installPath);
  deps.fs.chmodSync(installPath, 0o755);
  try {
    deps.fs.accessSync(installPath, fsConstants.X_OK);
  } catch {
    throw new Error(
      `binary copied to ${installPath} but is not executable — check filesystem permissions`,
    );
  }
  return installPath;
}

// -----------------------------------------------------------------------------
// Plist assembly
// -----------------------------------------------------------------------------

/**
 * Non-secret env vars the agent reads from its environment. The bearer
 * token and TLS key material always live in the agent dir, never in the
 * plist (see Phase 3 anti-patterns). --env= flag values take precedence
 * over inherited process env.
 */
const PLIST_ENV_KEYS = [
  'DEV_STORAGE',
  'HF_HOME',
  'LLAMA_CPP_ROOT',
  'LLAMA_CPP_MODELS',
  'LLAMA_CPP_CACHE',
  'LLAMA_CACHE',
  'HUGGINGFACE_HUB_CACHE',
  'OLLAMA_MODELS',
  'AI_ROOT',
] as const;

function buildPlistEnv(
  processEnv: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: processEnv.PATH ?? '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
  };
  for (const key of PLIST_ENV_KEYS) {
    const val = processEnv[key];
    if (val !== undefined && val !== '') env[key] = val;
  }
  // --env flag values override everything above.
  for (const [k, v] of Object.entries(overrides)) env[k] = v;
  return env;
}

export interface AssembledPlistArgs {
  label: string;
  installPath: string;
  dirArg: string;
  logDir: string;
  env: Record<string, string>;
  scope: 'user' | 'system';
  user?: string;
  group?: string;
}

export function assemblePlistOptions(a: AssembledPlistArgs): BuildPlistOptions {
  const common: BuildPlistOptions = {
    label: a.label,
    execPath: a.installPath,
    args: ['agent', 'serve', `--dir=${a.dirArg}`],
    logDir: a.logDir,
    env: a.env,
  };
  if (a.scope === 'system') {
    return {
      ...common,
      user: a.user,
      group: a.group,
      workingDir: a.dirArg,
    };
  }
  return common;
}

// -----------------------------------------------------------------------------
// launchctl load + polling
// -----------------------------------------------------------------------------

export interface PollResult {
  ok: boolean;
  pid?: number;
  reason?: string;
}

/**
 * Poll `launchctl print <target>` for up to `timeoutMs`, looking for
 * `state = running` + a positive PID. Returns on first healthy read or
 * after the deadline. The heuristic is conservative — we only declare
 * healthy when launchd reports both signals.
 */
export async function pollLaunchctlHealthy(
  label: string,
  scope: 'user' | 'system',
  deps: InstallLaunchdDeps,
  timeoutMs = 15000,
  pollIntervalMs = 500,
): Promise<PollResult> {
  const deadline = deps.now() + timeoutMs;
  const target =
    scope === 'system' ? `system/${label}` : `gui/${deps.getuid()}/${label}`;
  let lastStdout = '';
  while (deps.now() < deadline) {
    const res = deps.spawnSync('launchctl', ['print', target], { encoding: 'utf8' });
    lastStdout = res.stdout ?? '';
    if (res.status === 0) {
      const pidMatch = /\bpid = (\d+)\b/.exec(lastStdout);
      const stateRunning = /state = running/.test(lastStdout);
      if (stateRunning && pidMatch) {
        const pid = Number.parseInt(pidMatch[1]!, 10);
        if (Number.isFinite(pid) && pid > 0) {
          return { ok: true, pid };
        }
      }
    }
    await deps.sleep(pollIntervalMs);
  }
  return {
    ok: false,
    reason:
      lastStdout.length > 0
        ? `timeout waiting for healthy PID; last launchctl print:\n${lastStdout.slice(0, 400)}`
        : 'timeout waiting for healthy PID',
  };
}

function readStderrTail(logDir: string, deps: InstallLaunchdDeps): string {
  const stderrPath = join(logDir, 'stderr.log');
  if (!deps.fs.existsSync(stderrPath)) return '';
  try {
    const contents = deps.fs.readFileSync(stderrPath, 'utf8');
    return typeof contents === 'string' ? contents.slice(0, 500) : '';
  } catch {
    return '';
  }
}

// -----------------------------------------------------------------------------
// Top-level handler
// -----------------------------------------------------------------------------

export async function runAgentInstallLaunchd(
  argv: string[],
  depsOverride?: Partial<InstallLaunchdDeps>,
): Promise<number> {
  const deps: InstallLaunchdDeps = { ...defaultDeps(), ...(depsOverride ?? {}) };
  const parsed = parseInstallLaunchdFlags(argv);
  if ('error' in parsed) {
    if (parsed.error === '__help') {
      deps.stdout(INSTALL_LAUNCHD_USAGE);
      return 0;
    }
    deps.stderr(`${parsed.error}\n\n${INSTALL_LAUNCHD_USAGE}`);
    return 1;
  }

  // install-launchd is macOS-only — launchctl doesn't exist elsewhere.
  // Allow --dry-run on any platform so operators can preview from linux
  // CI boxes, but block the live path.
  if (deps.platform !== 'darwin' && !parsed.dryRun) {
    deps.stderr(
      `agent install-launchd: only supported on macOS (got platform=${deps.platform}). ` +
        `Run with --dry-run to preview the plist on other platforms.\n`,
    );
    return 1;
  }

  // System scope without root — fail early before any subprocess runs.
  if (parsed.scope === 'system' && deps.getuid() !== 0) {
    deps.stderr(
      `agent install-launchd: --scope=system requires root. Re-run with sudo.\n`,
    );
    return 1;
  }

  const label =
    parsed.label ??
    (parsed.scope === 'system' ? 'com.llamactl.agent.daemon' : 'com.llamactl.agent');
  const homeDir = deps.env.HOME ?? '';
  const logDir =
    parsed.logDir ?? (homeDir ? join(homeDir, '.llamactl-launchd-logs') : '/tmp/llamactl-launchd-logs');
  const dirArg = parsed.dir ?? defaultAgentDir(deps, homeDir);
  const plistPath =
    parsed.scope === 'system'
      ? `/Library/LaunchDaemons/${label}.plist`
      : join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);

  let installedPath: string;
  try {
    installedPath = await resolveBinary({
      source: parsed.source,
      installPath: parsed.installPath,
      scope: parsed.scope,
      repo: parsed.repo,
      dryRun: parsed.dryRun,
      deps,
    });
  } catch (err) {
    deps.stderr(`${(err as Error).message}\n`);
    return 1;
  }

  const who = currentUserAndGroup(deps);
  const plistEnv = buildPlistEnv(deps.env, parsed.envOverrides);
  const plistOpts = assemblePlistOptions({
    label,
    installPath: installedPath,
    dirArg,
    logDir,
    env: plistEnv,
    scope: parsed.scope,
    ...(parsed.scope === 'system' ? { user: who.user, group: who.group } : {}),
  });
  const plistBody =
    parsed.scope === 'system' ? buildSystemPlist(plistOpts) : buildUserPlist(plistOpts);

  if (parsed.dryRun) {
    deps.stdout(plistBody);
    deps.stdout('\n');
    deps.stdout(`# plist path: ${plistPath}\n`);
    if (parsed.scope === 'system') {
      deps.stdout(`# launchctl bootout system/${label} 2>/dev/null || true\n`);
      deps.stdout(`# launchctl bootstrap system ${plistPath}\n`);
    } else {
      deps.stdout(`# launchctl unload ${plistPath} 2>/dev/null || true\n`);
      deps.stdout(`# launchctl load ${plistPath}\n`);
    }
    return 0;
  }

  // Overwrite protection.
  if (deps.fs.existsSync(plistPath) && !parsed.force) {
    deps.stderr(
      `plist already exists at ${plistPath}; pass --force to overwrite.\n`,
    );
    return 1;
  }

  // Ensure parent dir exists + log dir exists (launchd writes to
  // StandardErrorPath the moment the service starts, so the directory
  // must be there).
  deps.fs.mkdirSync(dirname(plistPath), { recursive: true });
  deps.fs.mkdirSync(logDir, { recursive: true });
  deps.fs.writeFileSync(plistPath, plistBody, { encoding: 'utf8', mode: 0o644 });

  // Validate the plist syntax before asking launchd to load it —
  // syntax errors surface as an opaque "service inactive" otherwise.
  if (deps.platform === 'darwin') {
    const lint = deps.spawnSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });
    if (lint.status !== 0) {
      try {
        deps.fs.unlinkSync(plistPath);
      } catch {
        // best-effort cleanup
      }
      deps.stderr(
        `plutil -lint rejected the plist; deleted ${plistPath}. Output:\n${
          (lint.stdout ?? '') + (lint.stderr ?? '')
        }\n`,
      );
      return 1;
    }
  } else {
    deps.stderr(`warning: skipping plutil -lint on ${deps.platform}\n`);
  }

  // Unload any previous version so the fresh one takes effect. Errors
  // are expected (first install) and are intentionally ignored.
  if (parsed.scope === 'system') {
    deps.spawnSync('launchctl', ['bootout', `system/${label}`], { encoding: 'utf8' });
    const loadRes = deps.spawnSync(
      'launchctl',
      ['bootstrap', 'system', plistPath],
      { encoding: 'utf8' },
    );
    if (loadRes.status !== 0) {
      deps.stderr(
        `launchctl bootstrap failed: ${loadRes.stderr || loadRes.stdout}\n`,
      );
      return 1;
    }
  } else {
    deps.spawnSync('launchctl', ['unload', plistPath], { encoding: 'utf8' });
    const loadRes = deps.spawnSync('launchctl', ['load', plistPath], {
      encoding: 'utf8',
    });
    if (loadRes.status !== 0) {
      deps.stderr(`launchctl load failed: ${loadRes.stderr || loadRes.stdout}\n`);
      return 1;
    }
  }

  const pollResult = await pollLaunchctlHealthy(label, parsed.scope, deps);
  if (!pollResult.ok) {
    const tail = readStderrTail(logDir, deps);
    const tailBlock = tail.length > 0 ? `\nstderr.log (first 500 chars):\n${tail}\n` : '';
    deps.stderr(
      `agent install-launchd: service did not become healthy — ${pollResult.reason}${tailBlock}`,
    );
    return 1;
  }

  deps.stdout(
    `Installed:\n` +
      `  binary:     ${installedPath}\n` +
      `  plist:      ${plistPath}\n` +
      `  label:      ${label}\n` +
      `  log dir:    ${logDir}\n` +
      `  scope:      ${parsed.scope}\n` +
      `  pid:        ${pollResult.pid}\n` +
      `\n` +
      `Tail logs with:\n` +
      `  tail -f ${join(logDir, 'stderr.log')}\n` +
      `\n` +
      `If the agent needs access to external volumes (e.g. /Volumes/AI-MODELS),\n` +
      `grant Full Disk Access to the binary via:\n` +
      `  System Settings -> Privacy & Security -> Full Disk Access -> + -> ${installedPath}\n` +
      `The binary path is stable across reinstalls so the grant persists.\n`,
  );
  return 0;
}

function defaultAgentDir(deps: InstallLaunchdDeps, homeDir: string): string {
  const devStorage = deps.env.DEV_STORAGE;
  const node = (deps.env.LLAMACTL_NODE_NAME ?? hostname() ?? 'local').trim() || 'local';
  if (devStorage) return join(devStorage, 'agent', node);
  if (homeDir) return join(homeDir, '.llamactl', 'agent', node);
  return join('/tmp', '.llamactl', 'agent', node);
}

function currentUserAndGroup(
  deps: InstallLaunchdDeps,
): { user: string; group: string } {
  let user = deps.env.USER ?? '';
  let group = 'staff';
  try {
    const info = userInfo();
    if (!user) user = info.username;
  } catch {
    // userInfo can throw in sandboxed environments; fallback to env.
  }
  if (!user) user = 'nobody';
  // Linux conventions would vary, but install-launchd is macOS-only.
  // Bundler-level `--scope=system` installs inherit the same user who
  // ran `sudo llamactl agent install-launchd`, which is fine for a v1
  // deployment story — multi-user isolation is out of scope.
  if (deps.platform === 'linux') group = user;
  return { user, group };
}

// Re-export so tests can hit it without duplicating the list.
export { ALLOWED_PLATFORMS };
