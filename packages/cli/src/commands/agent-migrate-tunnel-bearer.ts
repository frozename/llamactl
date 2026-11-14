// #289: move LLAMACTL_TUNNEL_BEARER / LLAMACTL_TUNNEL_CENTRAL_BEARER out of
// a launchd plist or systemd unit into 0600 files inside the agent dir the
// unit itself names. Dry-run by default; --write applies. Prints a reload
// hint but never restarts the service and never echoes a token.
import { basename, isAbsolute, join, resolve } from "node:path";

import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "../safe-fs.js";

const USAGE = `Usage: llamactl agent migrate-tunnel-bearer <unit-path> [--write] [--dir=<abs path>]

Move LLAMACTL_TUNNEL_BEARER / LLAMACTL_TUNNEL_CENTRAL_BEARER out of a
launchd plist or systemd unit into <dir>/tunnel-bearer /
<dir>/tunnel-central-bearer (0600). <dir> is the agent dir the unit
itself names: its last --dir= argument, else LLAMACTL_AGENT_DIR,
DEV_STORAGE or HOME from the unit's environment. Dry run unless
--write is passed; the token is never printed and the service is never
restarted — only the reload hint is shown.
`;

const MIGRATE_ORDER = ["LLAMACTL_TUNNEL_BEARER", "LLAMACTL_TUNNEL_CENTRAL_BEARER"] as const;
type MigrationKey = (typeof MIGRATE_ORDER)[number];

const MIGRATE_FILES: Record<MigrationKey, string> = {
  LLAMACTL_TUNNEL_BEARER: "tunnel-bearer",
  LLAMACTL_TUNNEL_CENTRAL_BEARER: "tunnel-central-bearer",
};

// Same secret-looking suffixes install-launchd/install-systemd reject.
const SECRET_ENV_KEY_RE = /_(?:BEARER|TOKEN|SECRET|KEY)$/i;

interface ParsedArgs {
  unitPath: string;
  write: boolean;
  dir: string | undefined;
}

/**
 * One systemd Environment= line. Shared by every entry the line defines so
 * a rewrite can drop only the migrated assignments and keep the rest.
 */
interface SystemdEnvLine {
  /** Absolute [start, end) span of the line, excluding any trailing \r. */
  span: [number, number];
  /** Absolute offset just past `Environment=`, where the words start. */
  valueStart: number;
  /** Absolute [start, end) raw source span of every word on the line. */
  words: [number, number][];
}

/**
 * How to take an entry out of the unit: a launchd dict entry is removed as
 * a whole span; a systemd assignment is one word of a possibly shared line.
 */
type Removal =
  | { kind: "span"; span: [number, number] }
  | { kind: "word"; line: SystemdEnvLine; word: [number, number] };

interface EnvEntry {
  name: string;
  value: string;
  removal: Removal;
}

interface ParsedUnitBase {
  args: string[];
  env: EnvEntry[];
  envMap: Map<string, string>;
}

interface LaunchdUnit extends ParsedUnitBase {
  format: "launchd";
  label: string | undefined;
  hasUserName: boolean;
}

interface SystemdUnit extends ParsedUnitBase {
  format: "systemd";
  multiUser: boolean;
}

type ParsedUnit = LaunchdUnit | SystemdUnit;

interface MigrationTarget {
  envKey: MigrationKey;
  fileName: string;
  filePath: string;
  value: string;
  removals: Removal[];
}

type PlanResult =
  | { kind: "nothing" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      path: string;
      content: string;
      targets: MigrationTarget[];
      otherSecretKeys: string[];
      unit: ParsedUnit;
    };

type ReadyPlan = Extract<PlanResult, { kind: "ready" }>;

function fail(message: string): number {
  process.stderr.write(`agent migrate-tunnel-bearer: ${message}\n`);
  return 1;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMigrationKey(name: string): name is MigrationKey {
  return name === "LLAMACTL_TUNNEL_BEARER" || name === "LLAMACTL_TUNNEL_CENTRAL_BEARER";
}

// -----------------------------------------------------------------------------
// Argument parsing
// -----------------------------------------------------------------------------

interface ArgState {
  unitPath: string | undefined;
  write: boolean;
  dir: string | undefined;
}

function applyLongFlag(arg: string, out: ArgState): { error: string } | "ok" {
  const eq = arg.indexOf("=");
  const k = eq < 0 ? arg : arg.slice(0, eq);
  if (k !== "--dir") return { error: `unknown flag ${k}` };
  const v = eq < 0 ? undefined : arg.slice(eq + 1);
  if (v === undefined || !isAbsolute(v)) {
    return { error: "--dir must be an absolute path" };
  }
  out.dir = v;
  return "ok";
}

function applyArg(arg: string, out: ArgState): { error: string } | { help: true } | "ok" {
  if (arg === "--help" || arg === "-h") return { help: true };
  if (arg === "--write") {
    out.write = true;
    return "ok";
  }
  if (arg.startsWith("-")) return applyLongFlag(arg, out);
  if (out.unitPath !== undefined) return { error: "unexpected argument" };
  out.unitPath = arg;
  return "ok";
}

function parseArgs(args: string[]): { error: string } | { help: true } | ParsedArgs {
  const out: ArgState = { unitPath: undefined, write: false, dir: undefined };
  for (const arg of args) {
    const res = applyArg(arg, out);
    if (res !== "ok") return res;
  }
  if (out.unitPath === undefined) return { error: "missing <unit-path>" };
  return { unitPath: out.unitPath, write: out.write, dir: out.dir };
}

// -----------------------------------------------------------------------------
// Unit detection + parsing (pure functions over the unit text)
// -----------------------------------------------------------------------------

function detectFormat(content: string, path: string): "launchd" | "systemd" | { error: string } {
  if (content.startsWith("bplist")) {
    return { error: `${path} is a binary plist; convert it with plutil -convert xml1 first` };
  }
  if (content.includes("<plist")) return "launchd";
  if (/^\[Service\]/m.test(content)) return "systemd";
  return { error: `unrecognised unit format: ${path}` };
}

// XML entities decode in reverse order of xmlEscape: &amp; last, or an
// escaped "&amp;lt;" would double-decode into "<".
function xmlUnescape(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function plistLabel(content: string): string | undefined {
  const m = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(content);
  const v = m?.[1];
  return v === undefined ? undefined : xmlUnescape(v);
}

function programArguments(content: string): string[] {
  const open = /<key>ProgramArguments<\/key>\s*<array>/.exec(content);
  if (open === null) return [];
  const start = open.index + open[0].length;
  const close = content.indexOf("</array>", start);
  const body = content.slice(start, close < 0 ? content.length : close);
  const args: string[] = [];
  for (const m of body.matchAll(/<string>([^<]*)<\/string>|<string\/>/g)) {
    const [, raw] = m;
    args.push(raw === undefined ? "" : xmlUnescape(raw));
  }
  return args;
}

function environmentVariables(content: string): EnvEntry[] {
  const open = /<key>EnvironmentVariables<\/key>\s*<dict>/.exec(content);
  if (open === null) return [];
  const start = open.index + open[0].length;
  const close = content.indexOf("</dict>", start);
  const body = content.slice(start, close < 0 ? content.length : close);
  const entries: EnvEntry[] = [];
  const pairRe = /<key>([^<]*)<\/key>\s*(?:<string>([^<]*)<\/string>|<string\/>)/g;
  for (const m of body.matchAll(pairRe)) {
    const [, rawKey, rawValue] = m;
    entries.push({
      name: xmlUnescape(rawKey ?? ""),
      value: rawValue === undefined ? "" : xmlUnescape(rawValue),
      removal: { kind: "span", span: [start + m.index, start + m.index + m[0].length] },
    });
  }
  return entries;
}

function envMapOf(entries: EnvEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) map.set(e.name, e.value);
  return map;
}

function parseLaunchd(content: string): LaunchdUnit {
  const env = environmentVariables(content);
  return {
    format: "launchd",
    args: programArguments(content),
    env,
    envMap: envMapOf(env),
    label: plistLabel(content),
    hasUserName: content.includes("<key>UserName</key>"),
  };
}

// systemd.syntax word splitting: whitespace separates words, double quotes
// group, and inside quotes `\\` and `\"` unescape. Specifier escapes
// (%%/$$) are applied by the callers, not here.
// The unescaped char when position i is a quoted `\\` or `\"` escape.
// Indices are UTF-16 offsets so word spans line up with the unit text;
// surrogate halves are never whitespace, quotes or backslashes.
function quotedEscape(value: string, i: number, quoted: boolean): string | null {
  if (!quoted || value[i] !== "\\") return null;
  const next = value[i + 1];
  return next === '"' || next === "\\" ? next : null;
}

interface SystemdWord {
  word: string;
  /** [start, end) offsets of the word's raw source text within `value`. */
  start: number;
  end: number;
}

interface TokenizerState {
  words: SystemdWord[];
  cur: string;
  /** Raw start of the word being built, or -1 between words. */
  start: number;
  quoted: boolean;
}

// Consume the character at i and return the next index.
function tokenizeStep(value: string, i: number, st: TokenizerState): number {
  const esc = quotedEscape(value, i, st.quoted);
  if (esc !== null) {
    st.cur += esc;
    return i + 2;
  }
  const c = value[i] ?? "";
  if (c === '"' || st.quoted || !/\s/.test(c)) {
    if (st.start < 0) st.start = i;
    if (c === '"') st.quoted = !st.quoted;
    else st.cur += c;
    return i + 1;
  }
  if (st.start >= 0) {
    st.words.push({ word: st.cur, start: st.start, end: i });
    st.cur = "";
    st.start = -1;
  }
  return i + 1;
}

function tokenizeSystemdWordSpans(value: string): SystemdWord[] {
  const st: TokenizerState = { words: [], cur: "", start: -1, quoted: false };
  let i = 0;
  while (i < value.length) i = tokenizeStep(value, i, st);
  if (st.start >= 0) st.words.push({ word: st.cur, start: st.start, end: value.length });
  return st.words;
}

function tokenizeSystemdWords(value: string): string[] {
  return tokenizeSystemdWordSpans(value).map((w) => w.word);
}

function execStartWords(value: string): string[] {
  const words = tokenizeSystemdWords(value);
  const [first, ...rest] = words;
  if (first === undefined) return [];
  return [first.replace(/^[-@:+!]+/, ""), ...rest].map((w) =>
    w.replaceAll("%%", "%").replaceAll("$$", "$"),
  );
}

function collectSystemdLine(
  rawLine: string,
  span: [number, number],
  env: EnvEntry[],
  args: string[],
): void {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  const exec = /^[ \t]*ExecStart[ \t]*=(.*)$/.exec(line);
  if (exec !== null) {
    args.push(...execStartWords(exec[1] ?? ""));
    return;
  }
  const envM = /^([ \t]*Environment[ \t]*=)(.*)$/.exec(line);
  if (envM === null) return;
  const valueStart = span[0] + (envM[1] ?? "").length;
  const words = tokenizeSystemdWordSpans(envM[2] ?? "");
  const envLine: SystemdEnvLine = {
    span: [span[0], span[0] + line.length],
    valueStart,
    words: words.map((w) => [valueStart + w.start, valueStart + w.end]),
  };
  for (const w of words) {
    const unescaped = w.word.replaceAll("%%", "%");
    const eq = unescaped.indexOf("=");
    if (eq <= 0) continue;
    env.push({
      name: unescaped.slice(0, eq),
      value: unescaped.slice(eq + 1),
      removal: {
        kind: "word",
        line: envLine,
        word: [valueStart + w.start, valueStart + w.end],
      },
    });
  }
}

// The [Service] or [Install] section body plus its absolute offset in the
// unit text. A section runs from its header line to the next "[" header.
function extractSection(content: string, name: string): { body: string; offset: number } | null {
  const header = `[${name}]`;
  let offset = 0;
  let start = -1;
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (t.startsWith("[")) {
      if (start >= 0) return { body: content.slice(start, offset), offset: start };
      if (t.startsWith(header)) start = offset + line.length + 1;
    }
    offset += line.length + 1;
  }
  if (start < 0) return null;
  return { body: content.slice(start), offset: start };
}

function installWantsMultiUser(body: string): boolean {
  for (const rawLine of body.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const m = /^[ \t]*WantedBy[ \t]*=(.*)$/.exec(line);
    const words = (m?.[1] ?? "").split(/\s+/);
    if (words.some((w) => w.replaceAll('"', "") === "multi-user.target")) return true;
  }
  return false;
}

function parseSystemd(content: string): SystemdUnit {
  const service = extractSection(content, "Service");
  const install = extractSection(content, "Install");
  const env: EnvEntry[] = [];
  const args: string[] = [];
  if (service !== null) {
    let off = service.offset;
    for (const line of service.body.split("\n")) {
      const span: [number, number] = [off, off + line.length];
      collectSystemdLine(line, span, env, args);
      off = span[1] + 1;
    }
  }
  return {
    format: "systemd",
    args,
    env,
    envMap: envMapOf(env),
    multiUser: install !== null && installWantsMultiUser(install.body),
  };
}

// -----------------------------------------------------------------------------
// Agent-dir resolution — the unit's own args/env only, never the operator's
// -----------------------------------------------------------------------------

function lastDirArg(args: string[]): string | undefined {
  let found: string | undefined;
  for (const a of args) {
    if (a.startsWith("--dir=")) found = a.slice("--dir=".length);
  }
  return found;
}

function matchOperatorDir(
  resolved: string,
  optDir: string | undefined,
): { dir: string } | { error: string } {
  if (optDir !== undefined && resolve(optDir) !== resolve(resolved)) {
    return {
      error: `--dir=${optDir} does not match the agent dir the service uses (${resolved})`,
    };
  }
  return { dir: resolved };
}

function resolveAgentDir(
  unit: ParsedUnit,
  optDir: string | undefined,
): { dir: string } | { error: string } {
  const argDir = lastDirArg(unit.args)?.trim();
  if (argDir !== undefined && argDir !== "") {
    if (!isAbsolute(argDir)) {
      return { error: `the unit's --dir=${argDir} is not absolute; pass --dir=<abs path>` };
    }
    return matchOperatorDir(argDir, optDir);
  }
  for (const key of ["LLAMACTL_AGENT_DIR", "DEV_STORAGE"] as const) {
    const v = unit.envMap.get(key)?.trim() ?? "";
    if (v !== "") return matchOperatorDir(v, optDir);
  }
  const home = unit.envMap.get("HOME")?.trim() ?? "";
  if (home !== "") return matchOperatorDir(join(home, ".llamactl"), optDir);
  if (optDir !== undefined) return { dir: optDir };
  return {
    error:
      "cannot determine the agent dir the service uses (no --dir= in its arguments " +
      "and no LLAMACTL_AGENT_DIR, DEV_STORAGE or HOME in its environment); pass --dir=<abs path>",
  };
}

// -----------------------------------------------------------------------------
// Plan + apply
// -----------------------------------------------------------------------------

function collectTargets(
  env: EnvEntry[],
  path: string,
): { targets: Map<MigrationKey, { value: string; removals: Removal[] }> } | { error: string } {
  const targets = new Map<MigrationKey, { value: string; removals: Removal[] }>();
  for (const e of env) {
    if (!isMigrationKey(e.name)) continue;
    const t = targets.get(e.name) ?? { value: e.value, removals: [] };
    t.value = e.value;
    t.removals.push(e.removal);
    targets.set(e.name, t);
  }
  for (const [key, t] of targets) {
    if (t.value.trim() === "") {
      return { error: `${key} in ${path} is empty; remove it by hand` };
    }
  }
  return { targets };
}

function otherSecretKeys(env: EnvEntry[]): string[] {
  const names = new Set<string>();
  for (const e of env) {
    if (SECRET_ENV_KEY_RE.test(e.name) && !isMigrationKey(e.name)) names.add(e.name);
  }
  return [...names].sort();
}

function plan(
  unit: ParsedUnit,
  path: string,
  content: string,
  optDir: string | undefined,
): PlanResult {
  const found = collectTargets(unit.env, path);
  if ("error" in found) return { kind: "error", message: found.error };
  if (found.targets.size === 0) return { kind: "nothing" };
  const resolved = resolveAgentDir(unit, optDir);
  if ("error" in resolved) return { kind: "error", message: resolved.error };
  const dir = resolved.dir;
  if (!existsSync(dir)) {
    return { kind: "error", message: `agent dir ${dir} does not exist` };
  }
  const targets: MigrationTarget[] = [];
  for (const key of MIGRATE_ORDER) {
    const t = found.targets.get(key);
    if (t === undefined) continue;
    const fileName = MIGRATE_FILES[key];
    const filePath = join(dir, fileName);
    if (existsSync(filePath)) {
      return {
        kind: "error",
        message:
          `${filePath} already exists; not overwriting it ` +
          `(remove ${key} from ${path} by hand once it holds the same token)`,
      };
    }
    targets.push({ envKey: key, fileName, filePath, value: t.value, removals: t.removals });
  }
  return {
    kind: "ready",
    path,
    content,
    targets,
    otherSecretKeys: otherSecretKeys(unit.env),
    unit,
  };
}

// Removal range for a recorded span: back over same-line indentation and
// forward over same-line trailing blanks plus the line's newline.
function expandSpan(content: string, span: [number, number]): [number, number] {
  const [s, e] = span;
  let start = s;
  while (start > 0) {
    const c = content.charAt(start - 1);
    if (c !== " " && c !== "\t") break;
    start -= 1;
  }
  let p = e;
  while (p < content.length) {
    const c = content.charAt(p);
    if (c !== " " && c !== "\t") break;
    p += 1;
  }
  let end = e;
  if (content.charAt(p) === "\r" && content.charAt(p + 1) === "\n") end = p + 2;
  else if (content.charAt(p) === "\n") end = p + 1;
  return [start, end];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

// A systemd Environment= line can define several variables. Drop only the
// migrated words and keep the others' raw source text (so their quoting
// and escapes stay exactly as systemd parsed them); delete the whole line
// only when no word is left on it.
function systemdLineEdit(content: string, line: SystemdEnvLine, removed: Set<number>): Edit {
  const kept = line.words.filter(([s]) => !removed.has(s));
  if (kept.length === 0) {
    const [start, end] = expandSpan(content, line.span);
    return { start, end, text: "" };
  }
  const text = kept.map(([s, e]) => content.slice(s, e)).join(" ");
  return { start: line.valueStart, end: line.span[1], text };
}

function rewriteUnit(content: string, removals: Removal[]): string {
  const edits: Edit[] = [];
  const byLine = new Map<SystemdEnvLine, Set<number>>();
  for (const r of removals) {
    if (r.kind === "span") {
      const [start, end] = expandSpan(content, r.span);
      edits.push({ start, end, text: "" });
      continue;
    }
    const removed = byLine.get(r.line) ?? new Set<number>();
    removed.add(r.word[0]);
    byLine.set(r.line, removed);
  }
  for (const [line, removed] of byLine) edits.push(systemdLineEdit(content, line, removed));
  edits.sort((a, b) => b.start - a.start);
  let out = content;
  for (const { start, end, text } of edits) {
    out = out.slice(0, start) + text + out.slice(end);
  }
  return out;
}

function applyWrite(plan: ReadyPlan): number {
  const written: string[] = [];
  try {
    for (const t of plan.targets) {
      writeFileSync(t.filePath, `${t.value}\n`, { flag: "wx", mode: 0o600 });
      try {
        chmodSync(t.filePath, 0o600);
      } catch {
        // best-effort
      }
      written.push(t.filePath);
    }
  } catch (err) {
    return fail(errMessage(err));
  }
  const removals = plan.targets.flatMap((t) => t.removals);
  const tmp = `${plan.path}.migrate-tmp-${String(process.pid)}`;
  try {
    writeFileSync(tmp, rewriteUnit(plan.content, removals), {
      mode: statSync(plan.path).mode & 0o777,
    });
    renameSync(tmp, plan.path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort
    }
    return fail(
      `wrote ${written.join(" ")} but could not rewrite ${plan.path}: ${errMessage(err)}`,
    );
  }
  for (const t of plan.targets) {
    process.stdout.write(`wrote ${t.filePath} (0600)\n`);
    process.stdout.write(`removed ${t.envKey} from ${plan.path}\n`);
  }
  process.stdout.write(`reload the service: ${reloadHint(plan.unit, plan.path)}\n`);
  return 0;
}

function apply(plan: ReadyPlan, write: boolean): number {
  if (plan.otherSecretKeys.length > 0) {
    process.stderr.write(
      `note: other secret-looking keys left in place: ${plan.otherSecretKeys.join(", ")}\n`,
    );
  }
  if (!write) {
    for (const t of plan.targets) {
      process.stdout.write(`would write ${t.filePath} (0600) from ${t.envKey}\n`);
      process.stdout.write(`would remove ${t.envKey} from ${plan.path}\n`);
    }
    process.stdout.write("dry run: nothing changed; re-run with --write to apply\n");
    return 0;
  }
  return applyWrite(plan);
}

// Hint text only — this command never spawns launchctl/systemctl itself.
function reloadHint(unit: ParsedUnit, path: string): string {
  if (unit.format === "launchd") {
    const label = unit.label ?? "<label>";
    const system = unit.hasUserName || path.startsWith("/Library/LaunchDaemons/");
    return system
      ? `launchctl kickstart -k system/${label}`
      : `launchctl kickstart -k gui/$(id -u)/${label}`;
  }
  const name = basename(path);
  return unit.multiUser || path.startsWith("/etc/systemd/")
    ? `sudo systemctl restart ${name}`
    : `systemctl --user restart ${name}`;
}

// -----------------------------------------------------------------------------
// Top-level handler
// -----------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
export async function runAgentMigrateTunnelBearer(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ("error" in parsed) return fail(parsed.error);
  if ("help" in parsed) {
    process.stdout.write(USAGE);
    return 0;
  }
  let content: string;
  try {
    content = readFileSync(parsed.unitPath, "utf8");
  } catch (err) {
    return fail(`cannot read ${parsed.unitPath}: ${errMessage(err)}`);
  }
  const format = detectFormat(content, parsed.unitPath);
  if (typeof format !== "string") return fail(format.error);
  const unit = format === "launchd" ? parseLaunchd(content) : parseSystemd(content);
  const planned = plan(unit, parsed.unitPath, content, parsed.dir);
  if (planned.kind === "nothing") {
    process.stdout.write(
      `nothing to migrate: ${parsed.unitPath} has no LLAMACTL_TUNNEL_BEARER or LLAMACTL_TUNNEL_CENTRAL_BEARER\n`,
    );
    return 0;
  }
  if (planned.kind === "error") return fail(planned.message);
  return apply(planned, parsed.write);
}
