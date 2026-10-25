import { userInfo } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_UNITS, parseSystemctlShow } from "../update/services.js";
import {
  type BinarySource,
  buildPlistEnv,
  defaultAgentDir,
  defaultDeps,
  type InstallLaunchdDeps,
  resolveBinary,
} from "./index.js";
import { buildSystemdUnit, type BuildSystemdUnitOptions } from "./systemd-template.js";

/**
 * `llamactl agent install-systemd` — the Linux counterpart to
 * install-launchd: resolve an agent binary, render a systemd unit via
 * systemd-template.ts, write it, enable + restart it via systemctl, and
 * poll for a healthy MainPID. Same --key=value grammar and dependency
 * injection surface as install-launchd.
 */

export const INSTALL_SYSTEMD_USAGE = `Usage: llamactl agent install-systemd [flags]

Install the agent as a systemd user unit (scope=user) or system unit
(scope=system) on Linux, starting from either a fetched release binary,
a local bun build --compile, or a caller-supplied path.

Flags (all --key=value):
  --scope=user|system          default: user
  --binary=<path>              use an existing binary at this path
  --from-release=<tag>         fetch from GitHub Release vX.Y.Z
  --from-source                build locally via artifacts build-agent
  --install-path=<path>        target install path (absolute)
                                default: $HOME/.local/bin/llamactl-agent (user)
                                         /usr/local/bin/llamactl-agent (system)
  --dir=<path>                 agent data dir, absolute (passed to \`agent serve --dir=\`)
                                default: $DEV_STORAGE/agent/<node-name-or-hostname>
  --bind=<host>                address passed to \`agent serve --bind=\`
                                default: bindHost from agent.yaml (127.0.0.1)
  --port=<n>                   port passed to \`agent serve --port=\` (1-65535)
                                default: port from agent.yaml
  --log-dir=<path>             stdout/stderr log dir, absolute
                                default: systemd journal
  --env=KEY=VAL                additional env vars for the unit;
                                repeatable: --env=HF_HOME=/foo --env=DEV_STORAGE=/bar
  --env-file=<path>            EnvironmentFile= path (absolute); repeatable
  --repo=<owner/repo>          for --from-release; default: frozename/llamactl
  --dry-run                    print unit + systemctl plan; no disk writes
  --force                      overwrite existing unit file + binary

--binary / --from-release / --from-source are mutually exclusive. If
none is given, --from-source is assumed.

User-scope units stop at logout unless lingering is enabled:
  loginctl enable-linger $(whoami)
`;

// -----------------------------------------------------------------------------
// Flag parsing
// -----------------------------------------------------------------------------

export interface InstallSystemdFlags {
  scope: "user" | "system";
  source: BinarySource;
  /** Undefined → resolved per-scope at run time ($HOME/.local/bin vs /usr/local/bin). */
  installPath: string | undefined;
  dir: string | undefined;
  bind: string | undefined;
  port: number | undefined;
  logDir: string | undefined;
  envOverrides: Record<string, string>;
  envFiles: string[];
  repo: string;
  dryRun: boolean;
  force: boolean;
}

interface InstallSystemdFlagState {
  scope: "user" | "system";
  binaryPath: string | undefined;
  releaseTag: string | undefined;
  fromSource: boolean;
  installPath: string | undefined;
  dir: string | undefined;
  bind: string | undefined;
  port: number | undefined;
  logDir: string | undefined;
  envOverrides: Record<string, string>;
  envFiles: string[];
  repo: string;
  dryRun: boolean;
  force: boolean;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Newlines in unit values would let a flag smuggle directives into the
// unit file. Reject them at the parser so nothing is copied or written
// before buildSystemdUnit's throw would fire.
function rejectNewline(flag: string, v: string): { error: string } | null {
  if (/\n|\r/.test(v)) {
    return { error: `agent install-systemd: ${flag} must not contain newline characters` };
  }
  return null;
}

function requireAbsolutePath(flag: string, v: string): { error: string } | null {
  const newline = rejectNewline(flag, v);
  if (newline) return newline;
  if (!v.startsWith("/")) {
    return { error: `agent install-systemd: ${flag} must be an absolute path (got ${v})` };
  }
  return null;
}

function applySystemdEnvFlag(v: string, state: InstallSystemdFlagState): { error: string } | null {
  const eq = v.indexOf("=");
  if (eq <= 0) {
    return { error: `agent install-systemd: --env must be KEY=VAL (got ${v})` };
  }
  const key = v.slice(0, eq);
  if (!ENV_KEY_RE.test(key)) {
    return {
      error: `agent install-systemd: invalid --env key "${key}" (expected [A-Za-z_][A-Za-z0-9_]*)`,
    };
  }
  const newline = rejectNewline("--env value", v.slice(eq + 1));
  if (newline) return newline;
  state.envOverrides[key] = v.slice(eq + 1);
  return null;
}

function applySystemdPortFlag(v: string, state: InstallSystemdFlagState): { error: string } | null {
  if (!/^\d+$/.test(v)) {
    return { error: `agent install-systemd: --port must be an integer 1-65535 (got ${v})` };
  }
  const n = Number.parseInt(v, 10);
  if (n < 1 || n > 65535) {
    return { error: `agent install-systemd: --port must be an integer 1-65535 (got ${v})` };
  }
  state.port = n;
  return null;
}

function applySystemdSourceOrPathFlag(
  k: string,
  v: string,
  state: InstallSystemdFlagState,
): { error: string } | null {
  switch (k) {
    case "--binary":
      state.binaryPath = v;
      return null;
    case "--from-release":
      if (v.length === 0) {
        return { error: "agent install-systemd: --from-release requires a tag (e.g. v0.4.0)" };
      }
      state.releaseTag = v;
      return null;
    case "--install-path": {
      const err = requireAbsolutePath("--install-path", v);
      if (err) return err;
      state.installPath = v;
      return null;
    }
    case "--dir": {
      const err = requireAbsolutePath("--dir", v);
      if (err) return err;
      state.dir = v;
      return null;
    }
    case "--log-dir": {
      const err = requireAbsolutePath("--log-dir", v);
      if (err) return err;
      state.logDir = v;
      return null;
    }
    default:
      return { error: `agent install-systemd: unknown flag ${k}` };
  }
}

function applySystemdKeyValueFlag(
  k: string,
  v: string,
  state: InstallSystemdFlagState,
): { error: string } | null {
  switch (k) {
    case "--scope":
      if (v !== "user" && v !== "system") {
        return { error: `agent install-systemd: --scope must be user|system (got ${v})` };
      }
      state.scope = v;
      return null;
    case "--bind": {
      const newline = rejectNewline("--bind", v);
      if (newline) return newline;
      state.bind = v;
      return null;
    }
    case "--port":
      return applySystemdPortFlag(v, state);
    case "--env":
      return applySystemdEnvFlag(v, state);
    case "--env-file": {
      const err = requireAbsolutePath("--env-file", v);
      if (err) return err;
      state.envFiles.push(v);
      return null;
    }
    case "--repo":
      state.repo = v;
      return null;
    default:
      return applySystemdSourceOrPathFlag(k, v, state);
  }
}

function applySystemdArg(arg: string, state: InstallSystemdFlagState): { error: string } | null {
  if (arg === "--help" || arg === "-h") {
    return { error: "__help" };
  }
  if (arg === "--dry-run") {
    state.dryRun = true;
    return null;
  }
  if (arg === "--force") {
    state.force = true;
    return null;
  }
  if (arg === "--from-source") {
    state.fromSource = true;
    return null;
  }
  const [k, v] = splitFlag(arg);
  if (v === undefined) {
    return {
      error: `agent install-systemd: flag must be --key=value (or a known bare flag): ${arg}`,
    };
  }
  return applySystemdKeyValueFlag(k, v, state);
}

function resolveSystemdBinarySource(
  state: InstallSystemdFlagState,
): BinarySource | { error: string } {
  const sourceFlags = [
    state.binaryPath !== undefined ? "binary" : null,
    state.releaseTag !== undefined ? "release" : null,
    state.fromSource ? "source" : null,
  ].filter((x): x is string => x !== null);
  if (sourceFlags.length > 1) {
    return {
      error:
        "agent install-systemd: --binary, --from-release, --from-source are mutually exclusive " +
        `(got: ${sourceFlags.join(", ")})`,
    };
  }
  if (state.binaryPath !== undefined) {
    return { kind: "binary", path: state.binaryPath };
  }
  if (state.releaseTag !== undefined) {
    return { kind: "release", tag: state.releaseTag };
  }
  return { kind: "source" };
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  if (eq < 0) return [arg, undefined];
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

export function parseInstallSystemdFlags(argv: string[]): InstallSystemdFlags | { error: string } {
  const state: InstallSystemdFlagState = {
    scope: "user",
    binaryPath: undefined,
    releaseTag: undefined,
    fromSource: false,
    installPath: undefined,
    dir: undefined,
    bind: undefined,
    port: undefined,
    logDir: undefined,
    envOverrides: {},
    envFiles: [],
    repo: "frozename/llamactl",
    dryRun: false,
    force: false,
  };

  for (const arg of argv) {
    const err = applySystemdArg(arg, state);
    if (err) return err;
  }

  const source = resolveSystemdBinarySource(state);
  if ("error" in source) return source;

  return {
    scope: state.scope,
    source,
    installPath: state.installPath,
    dir: state.dir,
    bind: state.bind,
    port: state.port,
    logDir: state.logDir,
    envOverrides: state.envOverrides,
    envFiles: state.envFiles,
    repo: state.repo,
    dryRun: state.dryRun,
    force: state.force,
  };
}

// -----------------------------------------------------------------------------
// Targets + preconditions
// -----------------------------------------------------------------------------

interface InstallSystemdTargets {
  unitName: string;
  unitPath: string;
  installPath: string;
  dirArg: string;
}

function resolveSystemdTargets(
  deps: InstallLaunchdDeps,
  parsed: InstallSystemdFlags,
): InstallSystemdTargets {
  const homeDir = deps.env["HOME"] ?? "";
  const unitName = DEFAULT_UNITS.systemd.agent;
  const unitPath =
    parsed.scope === "system"
      ? join("/etc/systemd/system", unitName)
      : join(homeDir, ".config", "systemd", "user", unitName);
  const installPath =
    parsed.installPath ??
    (parsed.scope === "system"
      ? "/usr/local/bin/llamactl-agent"
      : join(homeDir, ".local", "bin", "llamactl-agent"));
  const dirArg = parsed.dir ?? defaultAgentDir(deps, homeDir);
  return { unitName, unitPath, installPath, dirArg };
}

function checkSystemdPreconditions(
  deps: InstallLaunchdDeps,
  parsed: InstallSystemdFlags,
): number | null {
  if (parsed.scope === "system" && deps.getuid() !== 0) {
    deps.stderr("agent install-systemd: --scope=system requires root. Re-run with sudo.\n");
    return 1;
  }
  // install-systemd is Linux-only — systemctl doesn't exist elsewhere.
  // Allow --dry-run on any platform so operators can preview from macOS
  // workstations, mirroring install-launchd's inverse behaviour.
  if (deps.platform !== "linux" && !parsed.dryRun) {
    deps.stderr(
      `agent install-systemd: only supported on Linux (got platform=${deps.platform}). ` +
        `Run with --dry-run to preview the unit on other platforms.\n`,
    );
    return 1;
  }
  return null;
}

function systemdUser(deps: InstallLaunchdDeps): string {
  const fromEnv = deps.env["USER"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    return userInfo().username;
  } catch {
    return "nobody";
  }
}

function isLoopbackBind(bind: string): boolean {
  return bind === "localhost" || bind === "::1" || bind === "[::1]" || bind.startsWith("127.");
}

// Without --bind, `agent serve` falls back to bindHost from agent.yaml,
// which defaults to 127.0.0.1 — warn in both dry-run and live runs so
// plans get corrected before a node is deployed unreachable.
function warnIfLoopbackBind(deps: InstallLaunchdDeps, bind: string | undefined): void {
  if (bind !== undefined && !isLoopbackBind(bind)) return;
  const cause =
    bind === undefined
      ? "--bind is omitted, so agent serve uses bindHost from agent.yaml (default 127.0.0.1)"
      : `--bind=${bind} is a loopback address`;
  deps.stderr(
    `agent install-systemd: warning: ${cause}; the agent stays on loopback and other ` +
      `fleet nodes cannot reach it. Pass --bind=<addr> to expose it.\n`,
  );
}

// -----------------------------------------------------------------------------
// Unit assembly + plan printing
// -----------------------------------------------------------------------------

function assembleSystemdUnit(
  deps: InstallLaunchdDeps,
  parsed: InstallSystemdFlags,
  targets: InstallSystemdTargets,
  installedPath: string,
): string {
  const args = ["agent", "serve", `--dir=${targets.dirArg}`];
  if (parsed.bind !== undefined) args.push(`--bind=${parsed.bind}`);
  if (parsed.port !== undefined) args.push(`--port=${String(parsed.port)}`);
  const options: BuildSystemdUnitOptions = {
    scope: parsed.scope,
    execPath: installedPath,
    args,
    env: buildPlistEnv(deps.env, parsed.envOverrides),
    envFiles: parsed.envFiles,
  };
  if (parsed.logDir !== undefined) options.logDir = parsed.logDir;
  if (parsed.scope === "system") options.workingDir = targets.dirArg;
  return buildSystemdUnit(options);
}

function printSystemdDryRunPlan(
  deps: InstallLaunchdDeps,
  parsed: InstallSystemdFlags,
  unit: string,
  targets: InstallSystemdTargets,
): void {
  const flag = systemdCtlFlag(parsed.scope);
  deps.stdout(unit);
  deps.stdout("\n");
  deps.stdout(`# unit path: ${targets.unitPath}\n`);
  deps.stdout(`# systemctl ${flag}daemon-reload\n`);
  deps.stdout(`# systemctl ${flag}enable ${targets.unitName}\n`);
  deps.stdout(`# systemctl ${flag}restart ${targets.unitName}\n`);
  if (parsed.scope === "user") {
    deps.stdout(`# loginctl enable-linger ${systemdUser(deps)}  (if Linger=no)\n`);
  }
}

function printSystemdSummary(
  deps: InstallLaunchdDeps,
  parsed: InstallSystemdFlags,
  targets: InstallSystemdTargets,
  installedPath: string,
  pid: number | undefined,
): void {
  const logs =
    parsed.logDir !== undefined
      ? `tail -f ${join(parsed.logDir, "stderr.log")}`
      : `journalctl ${systemdCtlFlag(parsed.scope)}-u ${targets.unitName} -f`;
  deps.stdout(
    `Installed:\n` +
      `  binary: ${installedPath}\n` +
      `  unit:   ${targets.unitPath}\n` +
      `  scope:  ${parsed.scope}\n` +
      `  pid:    ${String(pid)}\n` +
      `\n` +
      `Follow logs with:\n` +
      `  ${logs}\n`,
  );
}

// -----------------------------------------------------------------------------
// systemctl drive + polling
// -----------------------------------------------------------------------------

function systemdCtlArgs(scope: "user" | "system"): string[] {
  return scope === "system" ? [] : ["--user"];
}

function systemdCtlFlag(scope: "user" | "system"): string {
  return scope === "system" ? "" : "--user ";
}

interface SystemdPollResult {
  ok: boolean;
  pid?: number;
  reason?: string;
}

// A missing systemctl can leave stdout/stderr null at runtime even
// though SpawnSyncReturns<string> types them as strings; read through
// this shape so a stubbed/failed probe degrades instead of crashing.
interface SpawnProbeResult {
  status: number | null;
  stdout: string | null;
  stderr: string | null;
  error?: Error | null;
}

function firstPresent(...values: (string | null | undefined)[]): string {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return "";
}

/**
 * Poll `systemctl show` for up to `timeoutMs`, declaring healthy only
 * when the unit reports ActiveState=active with a positive MainPID.
 */
async function pollSystemdUnitActive(
  unitName: string,
  scope: "user" | "system",
  deps: InstallLaunchdDeps,
  timeoutMs = 15000,
  pollIntervalMs = 500,
): Promise<SystemdPollResult> {
  const deadline = deps.now() + timeoutMs;
  let lastState = "";
  while (deps.now() < deadline) {
    const res: SpawnProbeResult = deps.spawnSync(
      "systemctl",
      [...systemdCtlArgs(scope), "show", "-p", "ActiveState", "-p", "MainPID", unitName],
      { encoding: "utf8" },
    );
    const props = parseSystemctlShow(res.stdout ?? "");
    const pid = Number.parseInt(props["MainPID"] ?? "", 10);
    if (res.status === 0 && props["ActiveState"] === "active" && Number.isFinite(pid) && pid > 0) {
      return { ok: true, pid };
    }
    lastState = props["ActiveState"] ?? "";
    await deps.sleep(pollIntervalMs);
  }
  return {
    ok: false,
    reason:
      lastState === ""
        ? "timeout waiting for the unit to become active"
        : `timeout waiting for the unit to become active; last ActiveState=${lastState}`,
  };
}

/**
 * A user manager (and its units) stops at logout unless lingering is on.
 * Warn-only: the agent is running now, and auto-enabling lingering is
 * out of scope for an installer subcommand.
 */
function checkLinger(deps: InstallLaunchdDeps, scope: "user" | "system"): void {
  if (scope !== "user") return;
  const user = systemdUser(deps);
  const res: SpawnProbeResult = deps.spawnSync("loginctl", ["show-user", user, "-p", "Linger"], {
    encoding: "utf8",
  });
  const stdout = res.stdout ?? "";
  if (stdout.includes("Linger=yes")) return;
  const cause =
    res.error !== null && res.error !== undefined
      ? `could not check lingering for ${user} (${res.error.message})`
      : `lingering is off for ${user}`;
  deps.stderr(
    `agent install-systemd: warning: ${cause}; the unit stops at logout ` +
      `and takes the agent with it. Keep it up across logout with: loginctl enable-linger ${user}\n`,
  );
}

interface ExecuteSystemdInstallOpts {
  deps: InstallLaunchdDeps;
  parsed: InstallSystemdFlags;
  targets: InstallSystemdTargets;
  unit: string;
}

interface ExecuteSystemdInstallResult {
  code: number;
  pid?: number;
}

async function executeSystemdInstall(
  opts: ExecuteSystemdInstallOpts,
): Promise<ExecuteSystemdInstallResult> {
  const { deps, parsed, targets, unit } = opts;

  deps.fs.mkdirSync(dirname(targets.unitPath), { recursive: true });
  if (parsed.logDir !== undefined) deps.fs.mkdirSync(parsed.logDir, { recursive: true });
  deps.fs.writeFileSync(targets.unitPath, unit, { encoding: "utf8", mode: 0o644 });

  const steps: string[][] = [
    ["daemon-reload"],
    ["enable", targets.unitName],
    ["restart", targets.unitName],
  ];
  for (const step of steps) {
    const res: SpawnProbeResult = deps.spawnSync(
      "systemctl",
      [...systemdCtlArgs(parsed.scope), ...step],
      {
        encoding: "utf8",
      },
    );
    if (res.status !== 0) {
      const detail = firstPresent(res.stderr, res.stdout, res.error?.message);
      deps.stderr(`agent install-systemd: systemctl ${step.join(" ")} failed: ${detail}\n`);
      return { code: 1 };
    }
  }

  const poll = await pollSystemdUnitActive(targets.unitName, parsed.scope, deps);
  if (!poll.ok) {
    deps.stderr(
      `agent install-systemd: service did not become active — ${String(poll.reason)}\n` +
        `Inspect with: journalctl ${systemdCtlFlag(parsed.scope)}-u ${targets.unitName} -n 50\n`,
    );
    return { code: 1 };
  }

  checkLinger(deps, parsed.scope);
  return { code: 0, ...(poll.pid !== undefined ? { pid: poll.pid } : {}) };
}

// -----------------------------------------------------------------------------
// Top-level handler
// -----------------------------------------------------------------------------

async function resolveBinaryOrReport(
  deps: InstallLaunchdDeps,
  parsed: InstallSystemdFlags,
  installPath: string,
): Promise<string | null> {
  try {
    return await resolveBinary({
      source: parsed.source,
      installPath,
      scope: parsed.scope,
      repo: parsed.repo,
      dryRun: parsed.dryRun,
      deps,
    });
  } catch (err) {
    deps.stderr(`${(err as Error).message}\n`);
    return null;
  }
}

export async function runAgentInstallSystemd(
  argv: string[],
  depsOverride?: Partial<InstallLaunchdDeps>,
): Promise<number> {
  const deps: InstallLaunchdDeps = { ...defaultDeps(), ...(depsOverride ?? {}) };
  const parsed = parseInstallSystemdFlags(argv);
  if ("error" in parsed) {
    if (parsed.error === "__help") {
      deps.stdout(INSTALL_SYSTEMD_USAGE);
      return 0;
    }
    deps.stderr(`${parsed.error}\n\n${INSTALL_SYSTEMD_USAGE}`);
    return 1;
  }

  const preconditionExit = checkSystemdPreconditions(deps, parsed);
  if (preconditionExit !== null) return preconditionExit;

  const targets = resolveSystemdTargets(deps, parsed);

  // Guard before any binary copy or subprocess — same overwrite
  // protection install-launchd gives the plist.
  if (!parsed.dryRun && deps.fs.existsSync(targets.unitPath) && !parsed.force) {
    deps.stderr(`unit file already exists at ${targets.unitPath}; pass --force to overwrite.\n`);
    return 1;
  }

  const installedPath = await resolveBinaryOrReport(deps, parsed, targets.installPath);
  if (installedPath === null) return 1;

  // The parser rejects newline-bearing flag values, so a throw here
  // means an unexpected template failure — report it instead of
  // crashing the CLI after the binary has already been copied.
  let unit: string;
  try {
    unit = assembleSystemdUnit(deps, parsed, targets, installedPath);
  } catch (err) {
    deps.stderr(`agent install-systemd: ${(err as Error).message}\n`);
    return 1;
  }
  warnIfLoopbackBind(deps, parsed.bind);

  if (parsed.dryRun) {
    printSystemdDryRunPlan(deps, parsed, unit, targets);
    return 0;
  }

  const result = await executeSystemdInstall({ deps, parsed, targets, unit });
  if (result.code !== 0) return result.code;

  printSystemdSummary(deps, parsed, targets, installedPath, result.pid);
  return 0;
}
