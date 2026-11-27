/**
 * `llamactl doctor [secrets]` unit-file scan (#289). Installed launchd
 * plists and systemd units are plain files any same-user process can
 * read (and launchd lists plist env in `launchctl print`), so an inlined
 * tunnel bearer or another secret-looking env value is a disclosure risk.
 *
 * darwin: `com.llamactl.*.plist` in the user LaunchAgents and system
 * LaunchDaemons dirs. linux: `llamactl*.service` units and their
 * `<unit>.d/*.conf` drop-ins in the user and system unit dirs.
 *
 * Only env key NAMES are reported; values are never read into a result.
 * Every directory read degrades to a skipped/unknown row on error, so the
 * scan never throws out of doctor.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import type { CheckResult } from "./doctor.js";

import { existsSync, readdirSync, readFileSync, statSync } from "../safe-fs.js";

export interface UnitSecretProbeOptions {
  platform: NodeJS.Platform;
  /** darwin: dirs holding `com.llamactl.*.plist` files. */
  launchdDirs: string[];
  /** linux: dirs holding `llamactl*.service` units and `.d` drop-ins. */
  systemdDirs: string[];
}

/** Same secret-looking suffixes install-launchd / install-systemd reject. */
const SECRET_ENV_KEY_RE = /_(?:BEARER|TOKEN|SECRET|KEY)$/i;
const TUNNEL_BEARER_KEYS = new Set(["LLAMACTL_TUNNEL_BEARER", "LLAMACTL_TUNNEL_CENTRAL_BEARER"]);
const SYSTEM_UNIT_PREFIXES = [
  "/etc/systemd/",
  "/lib/systemd/",
  "/usr/lib/systemd/",
  "/run/systemd/",
];

export function defaultUnitSecretOptions(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): UnitSecretProbeOptions {
  const configHome = env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return {
    platform,
    launchdDirs: [join(homedir(), "Library", "LaunchAgents"), "/Library/LaunchDaemons"],
    systemdDirs: [join(configHome, "systemd", "user"), "/etc/systemd/system"],
  };
}

interface UnitFile {
  path: string;
  format: "launchd" | "systemd";
  /** systemd drop-in: the unit the `.d` dir belongs to. */
  parentUnit?: string;
}

function skippedDir(dir: string, err: unknown): CheckResult {
  const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
  return {
    system: "secrets",
    status: "info",
    message: `unit-file scan skipped ${dir} (${code}): secret-looking env not checked there`,
  };
}

/** Lists a directory, or returns a skipped row instead of throwing. */
function listDir(dir: string): string[] | CheckResult {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).sort();
  } catch (err) {
    // EACCES, or the dir vanished between existsSync and the read.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    return skippedDir(dir, err);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function collectLaunchd(dir: string, files: UnitFile[], skipped: CheckResult[]): void {
  const names = listDir(dir);
  if (!Array.isArray(names)) {
    skipped.push(names);
    return;
  }
  for (const name of names) {
    if (name.startsWith("com.llamactl.") && name.endsWith(".plist")) {
      files.push({ path: join(dir, name), format: "launchd" });
    }
  }
}

function collectSystemd(dir: string, files: UnitFile[], skipped: CheckResult[]): void {
  const names = listDir(dir);
  if (!Array.isArray(names)) {
    skipped.push(names);
    return;
  }
  for (const name of names) {
    if (!name.startsWith("llamactl")) continue;
    if (name.endsWith(".service")) {
      files.push({ path: join(dir, name), format: "systemd" });
    } else if (name.endsWith(".service.d") && isDirectory(join(dir, name))) {
      collectDropIns(join(dir, name), name.slice(0, -".d".length), files, skipped);
    }
  }
}

function collectDropIns(
  dropInDir: string,
  parentUnit: string,
  files: UnitFile[],
  skipped: CheckResult[],
): void {
  const names = listDir(dropInDir);
  if (!Array.isArray(names)) {
    skipped.push(names);
    return;
  }
  for (const name of names) {
    if (name.endsWith(".conf")) {
      files.push({ path: join(dropInDir, name), format: "systemd", parentUnit });
    }
  }
}

/** Key names inside the plist's top-level `EnvironmentVariables` dict. */
export function plistEnvKeys(xml: string): string[] {
  const marker = xml.indexOf("<key>EnvironmentVariables</key>");
  if (marker < 0) return [];
  const open = xml.indexOf("<dict>", marker);
  if (open < 0) return [];
  const close = xml.indexOf("</dict>", open);
  const body = xml.slice(open + "<dict>".length, close < 0 ? undefined : close);
  const keys: string[] = [];
  for (const m of body.matchAll(/<key>([^<]*)<\/key>/g)) {
    keys.push((m[1] ?? "").trim());
  }
  return keys;
}

interface WordState {
  words: string[];
  current: string;
  quote: string | null;
  inWord: boolean;
}

function endWord(st: WordState): void {
  if (st.inWord) st.words.push(st.current);
  st.current = "";
  st.inWord = false;
}

function stepWord(st: WordState, ch: string): void {
  if (st.quote !== null) {
    if (ch === st.quote) st.quote = null;
    else st.current += ch;
  } else if (ch === '"' || ch === "'") {
    st.quote = ch;
    st.inWord = true;
  } else if (ch === " " || ch === "\t") {
    endWord(st);
  } else {
    st.current += ch;
    st.inWord = true;
  }
}

/** Splits an Environment= value into words, honouring systemd quoting. */
function splitEnvWords(value: string): string[] {
  const st: WordState = { words: [], current: "", quote: null, inWord: false };
  for (const ch of value) stepWord(st, ch);
  endWord(st);
  return st.words;
}

/** Key names set by `Environment=` lines in the unit's [Service] section. */
export function systemdEnvKeys(text: string): string[] {
  const keys: string[] = [];
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1] ?? "";
      continue;
    }
    const eq = line.indexOf("=");
    if (section !== "Service" || eq < 0 || line.slice(0, eq).trim() !== "Environment") continue;
    for (const word of splitEnvWords(line.slice(eq + 1).trim())) {
      const wordEq = word.indexOf("=");
      if (wordEq > 0) keys.push(word.slice(0, wordEq));
    }
  }
  return keys;
}

function reloadHint(file: UnitFile): string {
  if (file.format === "launchd") {
    return "then reload the job (launchctl bootout + bootstrap, or launchctl kickstart -k)";
  }
  const system = SYSTEM_UNIT_PREFIXES.some((p) => file.path.startsWith(p));
  const ctl = system ? "systemctl" : "systemctl --user";
  const unit = file.parentUnit ?? file.path.slice(file.path.lastIndexOf("/") + 1);
  return `then ${ctl} daemon-reload and ${ctl} restart ${unit}`;
}

function tunnelFix(file: UnitFile, keys: string[]): string {
  const base = `run \`llamactl agent migrate-tunnel-bearer ${file.path} --write\` to move ${keys.join(", ")} into 0600 files in the agent dir`;
  if (file.parentUnit !== undefined) {
    return `${base}; this is a drop-in of ${file.parentUnit}, so --dir=<abs path> (the agent dir ${file.parentUnit} uses) is required; ${reloadHint(file)}`;
  }
  const dirNote =
    file.format === "systemd"
      ? "; pass --dir=<abs path> when the unit names no agent dir (e.g. it uses EnvironmentFile=)"
      : "";
  return `${base}${dirNote}; ${reloadHint(file)}`;
}

function otherFix(file: UnitFile, keys: string[]): string {
  return `move ${keys.join(", ")} into a 0600 file (or a keychain:/file: secret ref) and remove it from the unit; ${reloadHint(file)}`;
}

function scanResults(file: UnitFile, keys: string[]): CheckResult[] {
  const secretKeys = [...new Set(keys.filter((k) => SECRET_ENV_KEY_RE.test(k)))];
  if (secretKeys.length === 0) {
    return [{ system: "secrets", status: "ok", message: `${file.path}: no secret-looking env` }];
  }
  const results: CheckResult[] = [];
  const tunnel = secretKeys.filter((k) => TUNNEL_BEARER_KEYS.has(k));
  const other = secretKeys.filter((k) => !TUNNEL_BEARER_KEYS.has(k));
  if (tunnel.length > 0) {
    results.push({
      system: "secrets",
      status: "warn",
      message: `${file.path} inlines the tunnel bearer (${tunnel.join(", ")}) in plain text`,
      fix: tunnelFix(file, tunnel),
    });
  }
  if (other.length > 0) {
    results.push({
      system: "secrets",
      status: "warn",
      message: `${file.path} inlines secret-looking env (${other.join(", ")}) in plain text`,
      fix: otherFix(file, other),
    });
  }
  return results;
}

function scanFile(file: UnitFile): CheckResult[] {
  let text: string;
  try {
    text = readFileSync(file.path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    return [
      {
        system: "secrets",
        status: "info",
        message: `${file.path}: unreadable (${code}), secret-looking env not checked`,
      },
    ];
  }
  if (file.format === "launchd" && text.startsWith("bplist")) {
    return [
      {
        system: "secrets",
        status: "info",
        message: `${file.path} is a binary plist, secret-looking env not checked`,
        fix: `convert it with \`plutil -convert xml1 ${file.path}\` and rerun doctor`,
      },
    ];
  }
  const keys = file.format === "launchd" ? plistEnvKeys(text) : systemdEnvKeys(text);
  return scanResults(file, keys);
}

export function checkUnitSecrets(opts: UnitSecretProbeOptions): CheckResult[] {
  const files: UnitFile[] = [];
  const skipped: CheckResult[] = [];
  if (opts.platform === "darwin") {
    for (const dir of opts.launchdDirs) collectLaunchd(dir, files, skipped);
  } else if (opts.platform === "linux") {
    for (const dir of opts.systemdDirs) collectSystemd(dir, files, skipped);
  } else {
    return [];
  }
  return [...skipped, ...files.flatMap(scanFile)];
}
