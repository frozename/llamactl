// Service-manager abstraction for `llamactl update`: systemd --user units on
// Linux, launchd agents on macOS. The updater only ever stops, starts or
// restarts a unit it has positively matched to this checkout (or one the
// operator named explicitly); it never looks processes up by name.
import { basename, resolve } from "node:path";

import type { ExecFn, ExecResult } from "./deps.js";

export type ServiceRole = "agent" | "controller";
export type ServiceManagerKind = "launchd" | "systemd";

export interface ServiceInfo {
  role: ServiceRole;
  /** systemd unit or launchd label. */
  name: string;
  /** The name came from a flag or env var rather than the default. */
  explicit: boolean;
  loaded: boolean;
  active: boolean;
  pid: number | null;
  argv: string[];
  /** systemd: the unit's control group path. */
  cgroup: string | null;
  /** systemd: KillMode (process keeps model hosts alive across a stop). */
  killMode: string | null;
  /** Environment the service runs with (Environment= and EnvironmentFile=, or launchd's). */
  env: Record<string, string>;
  /** File the service writes stdout to, when it is a file. */
  stdoutPath: string | null;
  /** systemd: stdout goes to the journal. */
  journal: boolean;
  /** launchd: the plist to bootstrap the job from again after a bootout. */
  plistPath: string | null;
}

export interface ServiceManager {
  kind: ServiceManagerKind;
  describe: (role: ServiceRole, name: string, explicit: boolean) => Promise<ServiceInfo>;
  stop: (info: ServiceInfo) => Promise<ExecResult>;
  start: (info: ServiceInfo) => Promise<ExecResult>;
  restart: (info: ServiceInfo) => Promise<ExecResult>;
  isActive: (info: ServiceInfo) => Promise<boolean>;
  /** Service stdout written since `sinceMs`, for services logging to the journal. */
  journalSince: (info: ServiceInfo, sinceMs: number) => Promise<string | null>;
}

export const DEFAULT_UNITS: Record<ServiceManagerKind, Record<ServiceRole, string>> = {
  systemd: { controller: "llamactl-controller.service", agent: "llamactl-agent.service" },
  launchd: { controller: "com.llamactl.controller", agent: "com.llamactl.agent" },
};

export function pickServiceManagerKind(
  requested: string | null | undefined,
  platform: NodeJS.Platform,
): ServiceManagerKind | null {
  if (requested === "systemd" || requested === "launchd") return requested;
  if (platform === "linux") return "systemd";
  if (platform === "darwin") return "launchd";
  return null;
}

function emptyInfo(role: ServiceRole, name: string, explicit: boolean): ServiceInfo {
  return {
    role,
    name,
    explicit,
    loaded: false,
    active: false,
    pid: null,
    argv: [],
    cgroup: null,
    killMode: null,
    env: {},
    stdoutPath: null,
    journal: false,
    plistPath: null,
  };
}

// ---- systemd ---------------------------------------------------------------

/** `systemctl show` output as a key → value map (first `=` splits). */
export function parseSystemctlShow(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** argv from a `systemctl show -p ExecStart` value: `{ path=… ; argv[]=a b c ; … }`. */
export function parseExecStartArgv(value: string): string[] {
  const start = value.indexOf("argv[]=");
  if (start < 0) return [];
  const rest = value.slice(start + "argv[]=".length);
  const end = rest.indexOf(" ; ");
  return (end < 0 ? rest : rest.slice(0, end)).split(/\s+/).filter((s) => s !== "");
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v.startsWith('"') || v.startsWith("'")) && v.endsWith(v.charAt(0))) {
    return v.slice(1, -1);
  }
  return v;
}

/** `KEY=value` lines of an EnvironmentFile (comments and blanks skipped, quotes stripped). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq).trim()] = unquote(line.slice(eq + 1));
  }
  return out;
}

/** One `Environment=` value: space-separated assignments, each optionally quoted. */
export function parseEnvironmentAssignments(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of value.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    const eq = token.indexOf("=");
    if (eq > 0) out[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return out;
}

export interface UnitFileSettings {
  environment: Record<string, string>;
  environmentFiles: { path: string; optional: boolean }[];
  standardOutput: string | null;
}

/**
 * The settings `llamactl update` needs from `systemctl cat` (unit file plus
 * drop-ins, in override order): later assignments win, an empty assignment
 * resets a list.
 */
export function parseUnitFile(text: string): UnitFileSettings {
  const settings: UnitFileSettings = {
    environment: {},
    environmentFiles: [],
    standardOutput: null,
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (line.startsWith("#") || eq <= 0) continue;
    applyUnitSetting(settings, line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return settings;
}

function addEnvironmentFile(settings: UnitFileSettings, value: string): void {
  if (value === "") {
    settings.environmentFiles = [];
    return;
  }
  const optional = value.startsWith("-");
  settings.environmentFiles.push({ path: optional ? value.slice(1) : value, optional });
}

function applyUnitSetting(settings: UnitFileSettings, key: string, value: string): void {
  switch (key) {
    case "StandardOutput":
      settings.standardOutput = value === "" ? null : value;
      return;
    case "Environment":
      settings.environment =
        value === "" ? {} : { ...settings.environment, ...parseEnvironmentAssignments(value) };
      return;
    case "EnvironmentFile":
      addEnvironmentFile(settings, value);
      return;
  }
}

/** Where a systemd StandardOutput= setting sends stdout. Unset means the journal. */
export function stdoutTarget(standardOutput: string | null): {
  path: string | null;
  journal: boolean;
} {
  if (
    standardOutput === null ||
    standardOutput === "inherit" ||
    standardOutput.startsWith("journal")
  ) {
    return { path: null, journal: true };
  }
  for (const prefix of ["append:", "file:", "truncate:"]) {
    if (standardOutput.startsWith(prefix)) {
      return { path: standardOutput.slice(prefix.length), journal: false };
    }
  }
  return { path: null, journal: false };
}

const SHOW_PROPS = [
  "Id",
  "LoadState",
  "ActiveState",
  "MainPID",
  "ExecStart",
  "ControlGroup",
  "KillMode",
];

function nonEmptyOrNull(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

export function systemdManager(
  exec: ExecFn,
  readFile: (path: string) => string | null,
): ServiceManager {
  const ctl = async (...args: string[]): Promise<ExecResult> =>
    await exec(["systemctl", "--user", ...args]);
  return {
    kind: "systemd",
    describe: async (role, name, explicit): Promise<ServiceInfo> => {
      const info = emptyInfo(role, name, explicit);
      const show = await ctl("show", name, ...SHOW_PROPS.flatMap((p) => ["-p", p]));
      const props = parseSystemctlShow(show.stdout);
      if (show.code !== 0 || props["LoadState"] !== "loaded") return info;
      const pid = Number.parseInt(props["MainPID"] ?? "", 10);
      const unit = parseUnitFile((await ctl("cat", name)).stdout);
      const env: Record<string, string> = {};
      for (const file of unit.environmentFiles)
        Object.assign(env, parseEnvFile(readFile(file.path) ?? ""));
      const out = stdoutTarget(unit.standardOutput);
      return {
        ...info,
        loaded: true,
        active: props["ActiveState"] === "active",
        pid: Number.isFinite(pid) && pid > 0 ? pid : null,
        argv: parseExecStartArgv(props["ExecStart"] ?? ""),
        cgroup: nonEmptyOrNull(props["ControlGroup"]),
        killMode: nonEmptyOrNull(props["KillMode"]),
        env: { ...env, ...unit.environment },
        stdoutPath: out.path,
        journal: out.journal,
      };
    },
    stop: async (info) => await ctl("stop", info.name),
    start: async (info) => await ctl("start", info.name),
    restart: async (info) => await ctl("restart", info.name),
    isActive: async (info) => (await ctl("is-active", "--quiet", info.name)).code === 0,
    journalSince: async (info, sinceMs): Promise<string | null> => {
      const r = await exec([
        "journalctl",
        "--user",
        "--unit",
        info.name,
        "--since",
        `@${String(Math.floor(sinceMs / 1000))}`,
        "--output",
        "cat",
        "--no-pager",
      ]);
      return r.code === 0 ? r.stdout : null;
    },
  };
}

// ---- launchd ---------------------------------------------------------------

export interface LaunchctlPrint {
  state: string | null;
  pid: number | null;
  argv: string[];
  stdoutPath: string | null;
  plistPath: string | null;
  env: Record<string, string>;
}

interface PrintCursor {
  depth: number;
  /** Name of the depth-2 block being read (`arguments`, `environment`, …). */
  block: string | null;
}

function advancePrintCursor(cursor: PrintCursor, line: string): boolean {
  if (line.endsWith("{")) {
    cursor.depth += 1;
    if (cursor.depth === 2) cursor.block = line.slice(0, -1).replace(/=\s*$/, "").trim();
    return true;
  }
  if (line === "}") {
    cursor.depth -= 1;
    if (cursor.depth < 2) cursor.block = null;
    return true;
  }
  return false;
}

/** The fields `llamactl update` needs from `launchctl print gui/<uid>/<label>`. */
export function parseLaunchctlPrint(stdout: string): LaunchctlPrint {
  const out: LaunchctlPrint = {
    state: null,
    pid: null,
    argv: [],
    stdoutPath: null,
    plistPath: null,
    env: {},
  };
  const cursor: PrintCursor = { depth: 0, block: null };
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (advancePrintCursor(cursor, line)) continue;
    if (cursor.depth === 1) applyPrintField(out, line);
    else if (cursor.depth === 2 && cursor.block !== null) {
      applyPrintBlockLine(out, cursor.block, line);
    }
  }
  return out;
}

function applyPrintField(out: LaunchctlPrint, line: string): void {
  const eq = line.indexOf(" = ");
  if (eq < 0) return;
  const key = line.slice(0, eq);
  const value = line.slice(eq + 3).trim();
  if (key === "state") out.state = value;
  else if (key === "pid") {
    const n = Number.parseInt(value, 10);
    out.pid = Number.isFinite(n) && n > 0 ? n : null;
  } else if (key === "stdout path") out.stdoutPath = value;
  else if (key === "path") out.plistPath = value;
}

function applyPrintBlockLine(out: LaunchctlPrint, block: string, line: string): void {
  if (line === "") return;
  if (block === "arguments") out.argv.push(line);
  else if (block === "environment") {
    const arrow = line.indexOf(" => ");
    if (arrow > 0) out.env[line.slice(0, arrow)] = line.slice(arrow + 4);
  }
}

export function launchdManager(exec: ExecFn, uid: number): ServiceManager {
  const domain = `gui/${String(uid)}`;
  const target = (info: ServiceInfo): string => `${domain}/${info.name}`;
  const print = async (name: string): Promise<LaunchctlPrint | null> => {
    const r = await exec(["launchctl", "print", `${domain}/${name}`]);
    return r.code === 0 ? parseLaunchctlPrint(r.stdout) : null;
  };
  return {
    kind: "launchd",
    describe: async (role, name, explicit): Promise<ServiceInfo> => {
      const info = emptyInfo(role, name, explicit);
      const p = await print(name);
      if (p === null) return info;
      return {
        ...info,
        loaded: true,
        active: p.state === "running",
        pid: p.pid,
        argv: p.argv,
        env: p.env,
        stdoutPath: p.stdoutPath,
        plistPath: p.plistPath,
      };
    },
    stop: async (info) => await exec(["launchctl", "bootout", target(info)]),
    start: async (info): Promise<ExecResult> => {
      if (info.plistPath === null) {
        return {
          code: 1,
          stdout: "",
          stderr: `no plist recorded for ${info.name}; cannot bootstrap it`,
        };
      }
      return await exec(["launchctl", "bootstrap", domain, info.plistPath]);
    },
    restart: async (info) => await exec(["launchctl", "kickstart", "-k", target(info)]),
    isActive: async (info) => (await print(info.name))?.state === "running",
    journalSince: () => Promise.resolve(null),
  };
}

export function makeServiceManager(
  kind: ServiceManagerKind,
  exec: ExecFn,
  readFile: (path: string) => string | null,
  uid: number,
): ServiceManager {
  return kind === "systemd" ? systemdManager(exec, readFile) : launchdManager(exec, uid);
}

// ---- matching and safety ---------------------------------------------------

export function cliEntry(repo: string): string {
  return resolve(repo, "packages/cli/src/bin.ts");
}

function runsVerb(argv: readonly string[], role: ServiceRole): boolean {
  const i = argv.indexOf(role);
  return i >= 0 && argv[i + 1] === "serve";
}

/**
 * Does this unit run `<role> serve` from this checkout? A default-named unit
 * must prove it; an explicitly named one is trusted with a warning when its
 * command line does not show the checkout (e.g. a wrapper script).
 */
export function checkServiceMatch(
  info: ServiceInfo,
  repo: string,
): { problems: string[]; warnings: string[] } {
  if (!info.loaded) return { problems: [`${info.name} is not loaded`], warnings: [] };
  const entry = cliEntry(repo);
  const fromCheckout = info.argv.some((a) => a.startsWith("/") && resolve(a) === entry);
  const verb = runsVerb(info.argv, info.role);
  if (fromCheckout && verb) return { problems: [], warnings: [] };
  const what = `${info.name} does not run '${info.role} serve' from ${entry} (command: ${info.argv.join(" ") || "unknown"})`;
  return info.explicit
    ? { problems: [], warnings: [`${what}; trusting it because it was named explicitly`] }
    : { problems: [what], warnings: [] };
}

/** The bun binary a unit runs bin.ts with, or null (wrapper script, compiled binary). */
export function serviceBun(info: ServiceInfo, repo: string): string | null {
  const [exe, script] = info.argv;
  if (exe === undefined || script === undefined) return null;
  if (!basename(exe).startsWith("bun") || resolve(script) !== cliEntry(repo)) return null;
  return exe;
}

/** The cgroup v2 path in a /proc/<pid>/cgroup file (systemd's v1 hierarchy as a fallback). */
export function parseCgroupPath(text: string): string | null {
  let v1: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("0::")) return line.slice(3).trim();
    if (line.includes(":name=systemd:")) {
      v1 = line.slice(line.indexOf(":name=systemd:") + 14).trim();
    }
  }
  return v1;
}

export function cgroupWithin(path: string, unitCgroup: string): boolean {
  return path === unitCgroup || path.startsWith(`${unitCgroup}/`);
}

/** The service whose cgroup contains `selfCgroup`, if any. */
export function enclosingService(
  selfCgroup: string | null,
  services: readonly ServiceInfo[],
): ServiceInfo | null {
  if (selfCgroup === null) return null;
  return services.find((s) => s.cgroup !== null && cgroupWithin(selfCgroup, s.cgroup)) ?? null;
}

/** Parent pids of `pid`, nearest first, via `ps` (macOS has no cgroups). */
export async function ancestorPids(exec: ExecFn, pid: number, max = 64): Promise<number[]> {
  const out: number[] = [];
  let current = pid;
  for (let i = 0; i < max; i += 1) {
    const r = await exec(["ps", "-o", "ppid=", "-p", String(current)]);
    const ppid = Number.parseInt(r.stdout.trim(), 10);
    if (r.code !== 0 || !Number.isFinite(ppid) || ppid <= 1) break;
    out.push(ppid);
    current = ppid;
  }
  return out;
}

/** A systemd KillMode under which stopping the unit also kills processes it spawned. */
export function killsChildren(info: ServiceInfo): boolean {
  return info.killMode !== null && info.killMode !== "process" && info.killMode !== "none";
}
