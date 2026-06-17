import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform as nodePlatform } from "node:os";
import { basename, dirname, join } from "node:path";

import { llamactlHome } from "../config/env.js";
import { infraCurrentSymlink } from "./layout.js";

/**
 * Service adapter for supervised infra packages (embersynth, sirius).
 * Non-service packages (llama-cpp) ignore this module.
 *
 * Design:
 *   * Each service gets its own LaunchAgent / systemd user unit.
 *   * ExecStart points at <base>/<pkg>/current/bin/<pkg>, so version
 *     flips happen automatically when the layout symlink flips —
 *     restart the service and it picks up the new binary.
 *   * Service env vars from NodeRun flow straight into the unit.
 *   * Logs land under ~/.llamactl/logs/<pkg>.{log,err}, same shape
 *     as the agent itself.
 *
 * This module generates unit files + writes them. Actual
 * launchctl/systemctl subprocess calls live next to the tRPC procs
 * in router.ts so the subprocess surface stays out of pure-function
 * modules that want to be bun-test-friendly.
 */

export type ServiceHost = "darwin" | "linux";

export function currentServiceHost(): ServiceHost | null {
  const p = nodePlatform();
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  return null;
}

export function infraServiceLabel(pkg: string): string {
  return `com.llamactl.infra.${pkg}`;
}

export function defaultServicesDir(
  host: ServiceHost,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = env.HOME ?? homedir();
  if (host === "darwin") return join(home, "Library", "LaunchAgents");
  return join(home, ".config", "systemd", "user");
}

export function infraServiceUnitPath(
  pkg: string,
  host: ServiceHost,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = defaultServicesDir(host, env);
  if (host === "darwin") return join(dir, `${infraServiceLabel(pkg)}.plist`);
  return join(dir, `llamactl-infra-${pkg}.service`);
}

export function defaultInfraLogsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LLAMACTL_INFRA_LOGS_DIR?.trim();
  if (override) return override;
  const base = llamactlHome(env);
  return join(base, "logs");
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export interface RenderServiceUnitOptions {
  pkg: string;
  infraBase: string; // ~/.llamactl/infra — where <pkg>/current lives
  logDir: string; // ~/.llamactl/logs
  env: Record<string, string>;
  /** argv tail after <current-bin>/<pkg>. Empty by default — most
   *  services take their config via env vars, not flags. */
  args?: string[];
  /** Override the binary path convention. Default:
   *  <infraBase>/<pkg>/current/bin/<pkg>. Some packages name the
   *  entry differently (embersynth may ship src/index.ts piped
   *  through bun run). Future slices pull this from the pkg spec. */
  binaryPath?: string;
}

export function defaultBinaryPath(pkg: string, infraBase: string): string {
  return join(infraCurrentSymlink(pkg, infraBase), "bin", pkg);
}

export function renderLaunchdPlist(opts: RenderServiceUnitOptions): string {
  const pkg = xmlEscape(opts.pkg);
  const label = infraServiceLabel(opts.pkg);
  const binary = xmlEscape(opts.binaryPath ?? defaultBinaryPath(opts.pkg, opts.infraBase));
  const logDir = xmlEscape(opts.logDir);
  const args = (opts.args ?? []).map(xmlEscape);
  const envItems = Object.entries(opts.env)
    .map(([k, v]) => `      <key>${xmlEscape(k)}</key>\n      <string>${xmlEscape(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${binary}</string>${args.map((a) => `\n      <string>${a}</string>`).join("")}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logDir}/${pkg}.log</string>
    <key>StandardErrorPath</key>
    <string>${logDir}/${pkg}.err</string>
    <key>EnvironmentVariables</key>
    <dict>
${envItems || ""}
    </dict>
</dict>
</plist>
`;
}

export function renderSystemdUnit(opts: RenderServiceUnitOptions): string {
  const binary = opts.binaryPath ?? defaultBinaryPath(opts.pkg, opts.infraBase);
  const exec = [binary, ...(opts.args ?? [])].join(" ");
  const envLines = Object.entries(opts.env)
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join("\n");
  return `[Unit]
Description=llamactl infra service: ${opts.pkg}
Documentation=https://github.com/frozename/llamactl
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
Restart=always
RestartSec=3
${envLines}
StandardOutput=append:${opts.logDir}/${opts.pkg}.log
StandardError=append:${opts.logDir}/${opts.pkg}.err

[Install]
WantedBy=default.target
`;
}

export function renderServiceUnit(host: ServiceHost, opts: RenderServiceUnitOptions): string {
  return host === "darwin" ? renderLaunchdPlist(opts) : renderSystemdUnit(opts);
}

export interface WriteServiceUnitOptions extends RenderServiceUnitOptions {
  /** Host override for tests / cross-generation. Defaults to the
   *  current OS. */
  host?: ServiceHost;
  /** Directory to write into — defaults to the standard user-scoped
   *  path per-host. */
  dir?: string;
  env_proc?: NodeJS.ProcessEnv;
}

export interface WrittenServiceUnit {
  host: ServiceHost;
  path: string;
  label: string;
}

export function writeServiceUnit(opts: WriteServiceUnitOptions): WrittenServiceUnit {
  const host = opts.host ?? currentServiceHost();
  if (!host) {
    throw new Error(`writeServiceUnit: unsupported host platform ${nodePlatform()}`);
  }
  const dir = opts.dir ?? defaultServicesDir(host, opts.env_proc);
  mkdirSync(dir, { recursive: true });
  const unitPath =
    host === "darwin"
      ? join(dir, `${infraServiceLabel(opts.pkg)}.plist`)
      : join(dir, `llamactl-infra-${opts.pkg}.service`);
  const body = renderServiceUnit(host, opts);
  writeFileSync(unitPath, body, "utf8");
  try {
    chmodSync(unitPath, 0o644);
  } catch {
    // best-effort
  }
  return {
    host,
    path: unitPath,
    label: infraServiceLabel(opts.pkg),
  };
}

export function removeServiceUnit(
  pkg: string,
  host: ServiceHost = currentServiceHost() ?? "darwin",
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const path = infraServiceUnitPath(pkg, host, env);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * Read back whatever unit file is currently on disk for a pkg —
 * useful for diffing before re-writing and for surfacing what the
 * running service is configured with. Returns null when no unit
 * exists.
 */
export function readServiceUnit(
  pkg: string,
  host: ServiceHost = currentServiceHost() ?? "darwin",
  env: NodeJS.ProcessEnv = process.env,
): { path: string; body: string } | null {
  const path = infraServiceUnitPath(pkg, host, env);
  if (!existsSync(path)) return null;
  return { path, body: readFileSync(path, "utf8") };
}

export function unitBaseName(path: string): string {
  const base = basename(path);
  if (base.endsWith(".plist")) return base.replace(/\.plist$/, "");
  return base.replace(/\.service$/, "");
}

// ---- Lifecycle subprocess wiring --------------------------------
//
// Shell out to launchctl / systemctl to drive the services. Kept in
// this file so callers have one place to look for "everything about
// a service unit", but marked async + taking an injectable runner
// so tests can stub the subprocess.

export type ServiceLifecycleAction = "start" | "stop" | "reload" | "status";

export type SubprocessRunner = (cmd: string[]) => Promise<{
  code: number;
  stdout: string;
  stderr: string;
}>;

async function defaultRunner(cmd: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function launchctlArgs(action: ServiceLifecycleAction, label: string, plistPath: string): string[] {
  switch (action) {
    case "start":
      return ["launchctl", "load", plistPath];
    case "stop":
      return ["launchctl", "unload", plistPath];
    case "reload":
      return ["launchctl", "kickstart", "-k", `gui/${String(process.getuid?.() ?? 501)}/${label}`];
    case "status":
      return ["launchctl", "list", label];
  }
}

function systemctlArgs(action: ServiceLifecycleAction, unitName: string): string[] {
  switch (action) {
    case "start":
      return ["systemctl", "--user", "start", unitName];
    case "stop":
      return ["systemctl", "--user", "stop", unitName];
    case "reload":
      return ["systemctl", "--user", "restart", unitName];
    case "status":
      return ["systemctl", "--user", "is-active", unitName];
  }
}

export interface ServiceLifecycleOptions {
  pkg: string;
  action: ServiceLifecycleAction;
  host?: ServiceHost;
  env?: NodeJS.ProcessEnv;
  runner?: SubprocessRunner;
}

export interface ServiceLifecycleResult {
  host: ServiceHost;
  label: string;
  cmd: string[];
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Drive a service unit through its lifecycle. Returns the subprocess
 * outcome so callers can surface exit codes + stderr to operators.
 * Validates the unit file exists before start/reload to avoid
 * launchctl/systemctl's opaque "could not find service" errors.
 */
export async function runServiceLifecycle(
  opts: ServiceLifecycleOptions,
): Promise<ServiceLifecycleResult> {
  const host = opts.host ?? currentServiceHost();
  if (!host) {
    throw new Error(`runServiceLifecycle: unsupported host ${nodePlatform()}`);
  }
  const runner = opts.runner ?? defaultRunner;
  const label = infraServiceLabel(opts.pkg);
  const unitPath = infraServiceUnitPath(opts.pkg, host, opts.env);

  // Start / reload should fail loudly if the unit file is missing —
  // most likely cause is "operator ran install but forgot to wire
  // service:true in the spec".
  if ((opts.action === "start" || opts.action === "reload") && !existsSync(unitPath)) {
    throw new Error(
      `runServiceLifecycle: no unit file at ${unitPath} — is this pkg marked service:true in its spec?`,
    );
  }

  const cmd =
    host === "darwin"
      ? launchctlArgs(opts.action, label, unitPath)
      : systemctlArgs(opts.action, `llamactl-infra-${opts.pkg}.service`);
  const { code, stdout, stderr } = await runner(cmd);
  return { host, label, cmd, code, stdout, stderr };
}

// ---- Control-plane bulk restart (restart-on-deploy) -------------
//
// llamactl's long-running control-plane services (controller,
// fleet-supervisor, internal-proxy/node-agent) have no reconcile
// loop on their HTTP servers — the only way to reload fresh code
// after a deploy is to kickstart the launchd jobs. Labels are
// discovered at RUNTIME from `launchctl list`, NOT from repo plist
// files, because at least one service (the controller) is registered
// live-only with no repo plist.

const DEFAULT_CONTROL_PLANE_PREFIX = "com.llamactl.";

/**
 * The known long-running control-plane launchd services. restart-control-plane
 * restricts to this allowlist (fail-closed) so a stray com.llamactl.* job — e.g. a
 * StartInterval cleanup cron — is never force-restarted. The controller is listed
 * even though it has no repo plist (registered live-only): only its label is needed.
 */
export const CONTROL_PLANE_LABELS: readonly string[] = [
  "com.llamactl.controller",
  "com.llamactl.fleet-supervisor",
  "com.llamactl.internal-proxy",
  "com.llamactl.node-agent",
];

/**
 * Parse `launchctl list` stdout (tab-separated `PID\tStatus\tLabel`
 * with a header row) and return the set of labels whose 3rd column
 * starts with `prefix`, DEDUPED and SORTED ascending. The header row
 * (`...\tLabel`) won't match the prefix, but blank lines and short
 * rows are skipped defensively too.
 */
export function parseControlPlaneLabels(
  launchctlListStdout: string,
  prefix: string = DEFAULT_CONTROL_PLANE_PREFIX,
): string[] {
  const labels = new Set<string>();
  for (const line of launchctlListStdout.split("\n")) {
    if (line.trim() === "") continue;
    const cols = line.split("\t");
    if (cols.length < 3) continue;
    // Strip a trailing \r so CRLF-terminated launchctl output doesn't leave a
    // stray carriage return on the label (which still passes startsWith but then
    // corrupts the gui/<uid>/<label> kickstart arg into an opaque failure).
    const label = cols[2]?.replace(/\r$/, "");
    if (label?.startsWith(prefix)) labels.add(label);
  }
  return [...labels].sort();
}

export interface RestartControlPlaneResult {
  host: ServiceHost | null;
  restarted: { label: string; code: number; stdout: string; stderr: string }[];
  dryRun: boolean;
  skippedReason?: string;
}

export interface RestartControlPlaneOptions {
  runner?: SubprocessRunner;
  prefix?: string;
  allowlist?: readonly string[];
  host?: ServiceHost; // override for tests
  dryRun?: boolean;
  uid?: number; // override for tests; default process.getuid?.() ?? 501
}

/**
 * Restart every running com.llamactl.* launchd service so they reload
 * fresh code after a deploy. Discovers labels from `launchctl list` at
 * runtime, then `launchctl kickstart -k`s each in order, collecting
 * every outcome (never aborts on a single failure). darwin-only —
 * a no-op (not an error) elsewhere.
 */
export async function restartControlPlane(
  opts?: RestartControlPlaneOptions,
): Promise<RestartControlPlaneResult> {
  const host = opts?.host ?? currentServiceHost();
  if (host !== "darwin") {
    return {
      host: host ?? null,
      restarted: [],
      dryRun: !!opts?.dryRun,
      skippedReason:
        "restart-control-plane is darwin-only (launchctl); nothing to restart on this host",
    };
  }

  const runner = opts?.runner ?? defaultRunner;
  const list = await runner(["launchctl", "list"]);
  const discovered = parseControlPlaneLabels(list.stdout, opts?.prefix);
  // Fail-closed: only restart known control-plane services. A stray com.llamactl.*
  // job (e.g. a StartInterval cleanup cron) matches the prefix but must never be
  // force-kickstarted off its schedule.
  const allowlist = opts?.allowlist ?? CONTROL_PLANE_LABELS;
  const labels = discovered.filter((l) => allowlist.includes(l));

  if (opts?.dryRun) {
    return {
      host,
      restarted: labels.map((label) => ({ label, code: 0, stdout: "", stderr: "" })),
      dryRun: true,
    };
  }

  const uid = String(opts?.uid ?? process.getuid?.() ?? 501);
  const restarted: RestartControlPlaneResult["restarted"] = [];
  for (const label of labels) {
    const { code, stdout, stderr } = await runner([
      "launchctl",
      "kickstart",
      "-k",
      `gui/${uid}/${label}`,
    ]);
    restarted.push({ label, code, stdout, stderr });
  }
  return { host, restarted, dryRun: false };
}

// Re-export dirname for the tRPC handler that wants to ensure the
// parent dir before writing, without having to add a node:path import
// to router.ts just for that.
export { dirname };
