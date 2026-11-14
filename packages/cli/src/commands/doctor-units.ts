/**
 * `llamactl doctor [units]` — read-only probe for Linux systemd user
 * units OOMScoreAdjust. It inspects `<unitDir>/<unit>` and
 * `<unitDir>/<unit>.d/*.conf` (where `<unitDir>` comes from
 * XDG_CONFIG_HOME or ~/.config/systemd/user) and merges
 * OOMScoreAdjust assignments the way systemd does (last wins, empty
 * resets, the key must match exactly, and an integer outside
 * -1000..1000 is ignored so the previous value stays). It does NOT
 * read /etc/systemd/user, ~/.config/systemd/user.control or /run
 * drop-ins. Backslash line continuations are not joined, since
 * llamactl units never use them.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import type { CheckResult } from "./doctor.js";

import { existsSync, readdirSync, readFileSync } from "../safe-fs.js";
import { DEFAULT_UNITS } from "./update/services.js";

export interface UnitOomProbeOptions {
  platform: NodeJS.Platform;
  unitDir: string;
}

export function defaultUnitDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "systemd", "user");
}

function listUnitSources(unitDir: string, unit: string): string[] {
  const sources: string[] = [];
  const unitPath = join(unitDir, unit);
  if (existsSync(unitPath)) {
    sources.push(unit);
  }
  const dropInDir = join(unitDir, `${unit}.d`);
  if (!existsSync(dropInDir)) return sources;
  for (const f of readdirSync(dropInDir).sort()) {
    if (f.endsWith(".conf")) {
      sources.push(`${unit}.d/${f}`);
    }
  }
  return sources;
}

function parseOomAssignments(text: string): (string | null)[] {
  const assignments: (string | null)[] = [];
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("#") || line.startsWith(";")) continue;
    const headerMatch = /^\[(.+)\]$/.exec(line);
    if (headerMatch) {
      section = headerMatch[1] ?? "";
      continue;
    }
    if (section !== "Service") continue;
    extractOomValue(line, assignments);
  }
  return assignments;
}

function extractOomValue(line: string, out: (string | null)[]): void {
  // systemd splits at the first '=' and matches the trimmed key exactly;
  // an unknown key such as OOMScoreAdjustX= is ignored.
  const eqPos = line.indexOf("=");
  if (eqPos < 0) return;
  if (line.slice(0, eqPos).trim() !== "OOMScoreAdjust") return;
  const value = line.slice(eqPos + 1).trim();
  out.push(value === "" ? null : value);
}

/** Parses the way systemd's safe_atoi does (a leading '+' is accepted). */
function parseOomInteger(raw: string): number | undefined {
  const digits = raw.startsWith("+") ? raw.slice(1) : raw;
  const n = Number.parseInt(digits, 10);
  if (!Number.isFinite(n) || digits !== String(n)) return undefined;
  return n;
}

interface OomAssignment {
  raw: string;
  source: string;
}

interface EffectiveOom {
  eff: OomAssignment | undefined;
  ignored: OomAssignment[];
}

function effectiveOom(unitDir: string, sources: string[]): EffectiveOom {
  // Track the file that made each assignment: the effective value's
  // source is the file that last set it, not the last file read (a later
  // drop-in may set only Environment= and leave OOMScoreAdjust alone).
  let eff: OomAssignment | undefined;
  const ignored: OomAssignment[] = [];
  for (const source of sources) {
    const text = readFileSync(join(unitDir, source), "utf8");
    for (const a of parseOomAssignments(text)) {
      if (a === null) {
        eff = undefined;
        continue;
      }
      // systemd rejects an integer outside -1000..1000 with "ignoring"
      // and keeps the previous value (and its source).
      const n = parseOomInteger(a);
      if (n !== undefined && (n < -1000 || n > 1000)) {
        ignored.push({ raw: a, source });
        continue;
      }
      eff = { raw: a, source };
    }
  }
  return { eff, ignored };
}

function withIgnored(result: CheckResult, ignored: OomAssignment[], fix: string): CheckResult {
  if (ignored.length === 0) return result;
  const notes = ignored
    .map((i) => `OOMScoreAdjust=${i.raw} (${i.source}) is outside -1000..1000 and ignored`)
    .join("; ");
  return { ...result, status: "warn", message: `${result.message}; ${notes}`, fix };
}

function toCheckResult(unit: string, { eff, ignored }: EffectiveOom, unitDir: string): CheckResult {
  const fix = `add ${join(unitDir, unit + ".d", "oom.conf")} with [Service] OOMScoreAdjust=100, then systemctl --user daemon-reload and restart ${unit} (units installed before #330 are not rewritten; only ${unitDir} is inspected — drop-ins under /etc/systemd/user and user.control are not read)`;
  return withIgnored(baseCheckResult(unit, eff, fix), ignored, fix);
}

function baseCheckResult(unit: string, eff: OomAssignment | undefined, fix: string): CheckResult {
  if (eff === undefined) {
    return {
      system: "units",
      status: "warn",
      message: `${unit} sets no OOMScoreAdjust: it inherits the user manager default (200), so the kernel OOM killer picks it before dev jobs (#196)`,
      fix,
    };
  }
  const n = parseOomInteger(eff.raw);
  if (n === undefined) {
    return {
      system: "units",
      status: "warn",
      message: `${unit} OOMScoreAdjust=${eff.raw} (${eff.source}) is not an integer`,
      fix,
    };
  }
  if (n > 100) {
    return {
      system: "units",
      status: "warn",
      message: `${unit} OOMScoreAdjust=${String(n)} (${eff.source}) is above 100: the kernel OOM killer picks it before dev jobs (#196)`,
      fix,
    };
  }
  if (n === 100) {
    return {
      system: "units",
      status: "ok",
      message: `${unit} OOMScoreAdjust=${String(n)} (${eff.source})`,
    };
  }
  return {
    system: "units",
    status: "ok",
    message: `${unit} OOMScoreAdjust=${String(n)} (${eff.source}): values below 100 apply only under a root-run manager; an unprivileged user manager keeps its own floor (normally 100)`,
  };
}

export function checkUnitOomScores(opts: UnitOomProbeOptions): CheckResult[] {
  if (opts.platform !== "linux") return [];
  const results: CheckResult[] = [];
  const unitDir = opts.unitDir;
  for (const unit of [DEFAULT_UNITS.systemd.controller, DEFAULT_UNITS.systemd.agent]) {
    const sources = listUnitSources(unitDir, unit);
    if (sources.length === 0) continue;
    const eff = effectiveOom(unitDir, sources);
    results.push(toCheckResult(unit, eff, unitDir));
  }
  return results;
}
