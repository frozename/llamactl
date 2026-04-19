import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform as nodePlatform } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { infraCurrentSymlink } from './layout.js';

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

export type ServiceHost = 'darwin' | 'linux';

export function currentServiceHost(): ServiceHost | null {
  const p = nodePlatform();
  if (p === 'darwin') return 'darwin';
  if (p === 'linux') return 'linux';
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
  if (host === 'darwin') return join(home, 'Library', 'LaunchAgents');
  return join(home, '.config', 'systemd', 'user');
}

export function infraServiceUnitPath(
  pkg: string,
  host: ServiceHost,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = defaultServicesDir(host, env);
  if (host === 'darwin') return join(dir, `${infraServiceLabel(pkg)}.plist`);
  return join(dir, `llamactl-infra-${pkg}.service`);
}

export function defaultInfraLogsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LLAMACTL_INFRA_LOGS_DIR?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'logs');
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface RenderServiceUnitOptions {
  pkg: string;
  infraBase: string;        // ~/.llamactl/infra — where <pkg>/current lives
  logDir: string;           // ~/.llamactl/logs
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
  return join(infraCurrentSymlink(pkg, infraBase), 'bin', pkg);
}

export function renderLaunchdPlist(opts: RenderServiceUnitOptions): string {
  const pkg = xmlEscape(opts.pkg);
  const label = infraServiceLabel(opts.pkg);
  const binary = xmlEscape(opts.binaryPath ?? defaultBinaryPath(opts.pkg, opts.infraBase));
  const logDir = xmlEscape(opts.logDir);
  const args = (opts.args ?? []).map(xmlEscape);
  const envItems = Object.entries(opts.env)
    .map(([k, v]) => `      <key>${xmlEscape(k)}</key>\n      <string>${xmlEscape(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${binary}</string>${args.map((a) => `\n      <string>${a}</string>`).join('')}
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
${envItems || ''}
    </dict>
</dict>
</plist>
`;
}

export function renderSystemdUnit(opts: RenderServiceUnitOptions): string {
  const binary = opts.binaryPath ?? defaultBinaryPath(opts.pkg, opts.infraBase);
  const exec = [binary, ...(opts.args ?? [])].join(' ');
  const envLines = Object.entries(opts.env)
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join('\n');
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

export function renderServiceUnit(
  host: ServiceHost,
  opts: RenderServiceUnitOptions,
): string {
  return host === 'darwin' ? renderLaunchdPlist(opts) : renderSystemdUnit(opts);
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
    host === 'darwin'
      ? join(dir, `${infraServiceLabel(opts.pkg)}.plist`)
      : join(dir, `llamactl-infra-${opts.pkg}.service`);
  const body = renderServiceUnit(host, opts);
  writeFileSync(unitPath, body, 'utf8');
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
  host: ServiceHost = currentServiceHost() ?? 'darwin',
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
  host: ServiceHost = currentServiceHost() ?? 'darwin',
  env: NodeJS.ProcessEnv = process.env,
): { path: string; body: string } | null {
  const path = infraServiceUnitPath(pkg, host, env);
  if (!existsSync(path)) return null;
  return { path, body: readFileSync(path, 'utf8') };
}

export function unitBaseName(path: string): string {
  const base = basename(path);
  if (base.endsWith('.plist')) return base.replace(/\.plist$/, '');
  return base.replace(/\.service$/, '');
}

// ---- Lifecycle subprocess wiring --------------------------------
//
// Shell out to launchctl / systemctl to drive the services. Kept in
// this file so callers have one place to look for "everything about
// a service unit", but marked async + taking an injectable runner
// so tests can stub the subprocess.

export type ServiceLifecycleAction = 'start' | 'stop' | 'reload' | 'status';

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
  const proc = Bun.spawn({ cmd, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function launchctlArgs(action: ServiceLifecycleAction, label: string, plistPath: string): string[] {
  switch (action) {
    case 'start': return ['launchctl', 'load', plistPath];
    case 'stop': return ['launchctl', 'unload', plistPath];
    case 'reload': return ['launchctl', 'kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${label}`];
    case 'status': return ['launchctl', 'list', label];
  }
}

function systemctlArgs(action: ServiceLifecycleAction, unitName: string): string[] {
  switch (action) {
    case 'start': return ['systemctl', '--user', 'start', unitName];
    case 'stop': return ['systemctl', '--user', 'stop', unitName];
    case 'reload': return ['systemctl', '--user', 'restart', unitName];
    case 'status': return ['systemctl', '--user', 'is-active', unitName];
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
  if ((opts.action === 'start' || opts.action === 'reload') && !existsSync(unitPath)) {
    throw new Error(
      `runServiceLifecycle: no unit file at ${unitPath} — is this pkg marked service:true in its spec?`,
    );
  }

  const cmd = host === 'darwin'
    ? launchctlArgs(opts.action, label, unitPath)
    : systemctlArgs(opts.action, `llamactl-infra-${opts.pkg}.service`);
  const { code, stdout, stderr } = await runner(cmd);
  return { host, label, cmd, code, stdout, stderr };
}

// Re-export dirname for the tRPC handler that wants to ensure the
// parent dir before writing, without having to add a node:path import
// to router.ts just for that.
export { dirname };
