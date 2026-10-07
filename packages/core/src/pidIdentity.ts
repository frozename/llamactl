// Identity contract for a pid read back from a tracking file: the process now
// holding the pid must have started no later than the record's mtime +
// PID_START_SLACK_MS, and — when the caller supplies an expectation — its
// command line must still look like the binary and args that were launched.
// Tracking files are only written while their process is alive, so a process
// that started after the record cannot be the one we launched — the pid was
// recycled. "unknown" is fail-closed: never signalled, but the tracking files
// are kept because the record may still be ours. A command mismatch is
// unverifiable identity ("unknown"), not evidence that the pid was recycled.
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

import { existsSync, statSync } from "./safe-fs.js";

export type PidVerdict = "alive" | "dead" | "reused" | "unknown";

export const PID_START_SLACK_MS = 30_000;

// ps must answer quickly: a wedged /usr/bin/ps can no longer stall a status
// or teardown path beyond this bound, and its failure lands on "unknown".
const PS_TIMEOUT_MS = 500;

/**
 * What the process holding a recorded pid is expected to look like. `binary`
 * compares against argv0's basename (an absolute shebang path and a bare
 * `exec -a` name both reduce to the same basename). `path` also accepts the
 * full argv0 at a whitespace or end boundary, including paths with spaces.
 * Each entry of `args` must appear as a whole token or as the tail of a path
 * token, so "a.gguf" never
 * matches "/models/xa.gguf".
 */
export interface CommandExpectation {
  binary?: string;
  path?: string;
  args?: readonly string[];
}

export interface PidIdentityDeps {
  probe?: (pid: number) => void;
  processStartMs?: (pid: number) => number | null;
  /** Batch counterpart for processStartMs: one lookup for many pids. */
  processStartMsMany?: (pids: readonly number[]) => ReadonlyMap<number, number | null>;
  processCommand?: (pid: number) => string | null;
  expectCommand?: CommandExpectation;
}

/** Identity evidence a signal path may require before signalling a pid. */
export interface SignalIdentity {
  recordPath?: string;
  expectCommand?: CommandExpectation;
  deps?: PidIdentityDeps;
}

/** Parse ps etime `[[dd-]hh:]mm:ss` into seconds; null on anything else. */
export function parseEtimeSeconds(raw: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const [, dd, hh, mm, ss] = match;
  const minutes = Number.parseInt(mm ?? "", 10);
  const seconds = Number.parseInt(ss ?? "", 10);
  if (minutes >= 60 || seconds >= 60) return null;
  const days = Number.parseInt(dd ?? "0", 10);
  const hours = Number.parseInt(hh ?? "0", 10);
  return days * 86_400 + hours * 3600 + minutes * 60 + seconds;
}

// Resolve ps by absolute path: /usr/bin is not guaranteed on every PATH this
// code runs under (e.g. launchd), mirroring resolveLsofPath in probe.ts.
function resolvePsPath(): string {
  for (const candidate of ["/bin/ps", "/usr/bin/ps"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "ps";
}

/**
 * One bounded ps invocation: absolute binary, caller's PATH preserved,
 * LC_ALL=C so output parsing never depends on the environment's locale.
 * Any failure returns null — the caller decides which verdict that becomes.
 */
function runPs(args: readonly string[]): string | null {
  try {
    return execFileSync(resolvePsPath(), [...args], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"], LC_ALL: "C" },
      timeout: PS_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
}

/** Bounded ps read of a single column for one pid; null when unavailable. */
export function psColumn(pid: number, column: "etime" | "command" | "pgid"): string | null {
  const out = runPs(["-o", `${column}=`, "-p", String(pid)]);
  const trimmed = out?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

/**
 * The current holder's start time in epoch-ms, or null when it cannot be
 * resolved (ps missing, wedged, or the pid exited between probe and lookup).
 * `etime` is used instead of `lstart` because it is numeric and locale-free.
 */
export function processStartMs(pid: number): number | null {
  const column = psColumn(pid, "etime");
  if (column === null) return null;
  const etimeSeconds = parseEtimeSeconds(column);
  return etimeSeconds === null ? null : Date.now() - etimeSeconds * 1000;
}

function parseStartLines(raw: string, now: number): Map<number, number | null> {
  const out = new Map<number, number | null>();
  for (const line of raw.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (match === null) continue;
    const etimeSeconds = parseEtimeSeconds(match[2] ?? "");
    out.set(
      Number.parseInt(match[1] ?? "", 10),
      etimeSeconds === null ? null : now - etimeSeconds * 1000,
    );
  }
  return out;
}

/**
 * Start times for many pids in a single ps call. Pids absent from the output
 * (exited between probe and lookup) map to null.
 */
export function processStartMsMany(pids: readonly number[]): Map<number, number | null> {
  const out = new Map<number, number | null>();
  if (pids.length === 0) return out;
  const raw = runPs(["-o", "pid=", "-o", "etime=", "-p", pids.join(",")]);
  const parsed = raw === null ? new Map<number, number | null>() : parseStartLines(raw, Date.now());
  for (const pid of pids) {
    out.set(pid, parsed.get(pid) ?? null);
  }
  return out;
}

/** Full command line (`ps -o command=`) for a pid; null when unavailable. */
export function processCommand(pid: number): string | null {
  return psColumn(pid, "command");
}

function defaultProbe(pid: number): void {
  process.kill(pid, 0);
}

/**
 * kill(0)-style liveness: true while the pid is held, regardless of who owns
 * it. Free of ps cost — this is the right poll inside grace loops; it must
 * never be the only check before signalling (use the verify* family there).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Classify a failed liveness probe. ESRCH means the pid is truly gone.
 * EPERM means the pid exists but is owned by another user — it cannot be a
 * process we spawned, so the pid was recycled, which is "reused" (never
 * signalled, but safe to reap the record). Anything else is "unknown".
 */
function classifyProbeError(err: unknown): PidVerdict {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ESRCH") return "dead";
  if (code === "EPERM") return "reused";
  return "unknown";
}

function commandMatches(cmdline: string, expect: CommandExpectation): boolean {
  const tokens = cmdline.trim().split(/\s+/);
  const matchesPath =
    expect.path !== undefined && (cmdline === expect.path || cmdline.startsWith(`${expect.path} `));
  if (!matchesPath && expect.binary !== undefined && basename(tokens[0] ?? "") !== expect.binary) {
    return false;
  }
  for (const arg of expect.args ?? []) {
    if (!tokens.some((token) => token === arg || token.endsWith(`/${arg}`))) return false;
  }
  return true;
}

/**
 * Verify a recorded pid still names the process it was recorded for.
 * `recordedAtMs` is the tracking record's write time (callers use the record
 * file's mtime). A live pid whose start is later than that + slack belongs to
 * a different process — the pid was recycled and is reported "reused". When
 * `deps.expectCommand` is given, the current command line must also match.
 * A mismatch is unverifiable identity ("unknown"): never signalled, with
 * tracking files kept because the record may still be ours.
 */
export function verifyRecordedPid(
  pid: number,
  recordedAtMs: number | null,
  deps?: PidIdentityDeps,
): PidVerdict {
  const probe = deps?.probe ?? defaultProbe;
  const startOf = deps?.processStartMs ?? processStartMs;
  try {
    probe(pid);
  } catch (err) {
    return classifyProbeError(err);
  }
  if (recordedAtMs === null) return "unknown";
  const startedAtMs = startOf(pid);
  if (startedAtMs === null) return "unknown";
  if (startedAtMs > recordedAtMs + PID_START_SLACK_MS) return "reused";
  const expect = deps?.expectCommand;
  if (expect !== undefined) {
    const cmdline = (deps?.processCommand ?? processCommand)(pid);
    if (cmdline === null) return "unknown";
    if (!commandMatches(cmdline, expect)) return "unknown";
  }
  return "alive";
}

function recordMtimeMs(recordPath: string): number | null {
  try {
    return statSync(recordPath).mtimeMs;
  } catch {
    return null;
  }
}

/** Verify `pid` against the mtime of the file it was read from. */
export function verifyPidFile(recordPath: string, pid: number, deps?: PidIdentityDeps): PidVerdict {
  return verifyRecordedPid(pid, recordMtimeMs(recordPath), deps);
}

export interface PidRecordQuery {
  recordPath: string;
  pid: number;
}

function startResolver(
  deps?: PidIdentityDeps,
): (pids: readonly number[]) => ReadonlyMap<number, number | null> {
  if (deps?.processStartMsMany !== undefined) return deps.processStartMsMany;
  const single = deps?.processStartMs;
  if (single !== undefined) {
    return (pids) => new Map(pids.map((pid) => [pid, single(pid)]));
  }
  return processStartMsMany;
}

function classifyStart(startedAtMs: number | null, recordedAtMs: number): PidVerdict {
  if (startedAtMs === null) return "unknown";
  return startedAtMs > recordedAtMs + PID_START_SLACK_MS ? "reused" : "alive";
}

/**
 * Batch counterpart of verifyPidFile: every record is probed, then all
 * surviving pids share a single process-start lookup. Command expectations
 * are per-record concerns, so batch verification stays start-time based —
 * callers that corroborate command lines should use verifyPidFile per record.
 */
export function verifyPidFiles(
  records: readonly PidRecordQuery[],
  deps?: PidIdentityDeps,
): Map<string, PidVerdict> {
  const probe = deps?.probe ?? defaultProbe;
  const verdicts = new Map<string, PidVerdict>();
  const pending: { recordPath: string; pid: number; recordedAtMs: number }[] = [];
  for (const rec of records) {
    try {
      probe(rec.pid);
    } catch (err) {
      verdicts.set(rec.recordPath, classifyProbeError(err));
      continue;
    }
    const recordedAtMs = recordMtimeMs(rec.recordPath);
    if (recordedAtMs === null) {
      verdicts.set(rec.recordPath, "unknown");
      continue;
    }
    pending.push({ ...rec, recordedAtMs });
  }
  if (pending.length === 0) return verdicts;
  const starts = startResolver(deps)(pending.map((rec) => rec.pid));
  for (const rec of pending) {
    verdicts.set(rec.recordPath, classifyStart(starts.get(rec.pid) ?? null, rec.recordedAtMs));
  }
  return verdicts;
}

export function isRecordedPidAlive(
  recordPath: string,
  pid: number,
  deps?: PidIdentityDeps,
): boolean {
  return verifyPidFile(recordPath, pid, deps) === "alive";
}

/** "dead" and "reused" are the only verdicts a caller may delete files on. */
export function isRecordedPidGone(verdict: PidVerdict): boolean {
  return verdict === "dead" || verdict === "reused";
}

/**
 * Signal a recorded pid, re-verifying its identity first so a recycled or
 * unverifiable pid is never signalled. Returns whether the signal was sent.
 */
export function signalRecordedPid(
  recordPath: string,
  pid: number,
  signal: NodeJS.Signals,
  deps?: PidIdentityDeps,
): boolean {
  if (verifyPidFile(recordPath, pid, deps) !== "alive") return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signal a pid that has JUST verified as ours: SIGTERM, then wait out the
 * grace period polling kill(0) only — each ps-backed verify is a bounded but
 * real cost that must not run once per tick — and re-verify identity before
 * escalating to SIGKILL. `stopped: false` means identity became unverifiable
 * mid-flight; the caller must keep the tracking files and report not-stopped.
 */
export async function terminateVerifiedPid(
  recordPath: string,
  pid: number,
  deps: PidIdentityDeps,
  graceSeconds: number,
): Promise<{ stopped: boolean; killed: boolean }> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone between verify and signal
  }

  for (let i = 0; i < graceSeconds; i += 1) {
    if (!isProcessAlive(pid)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!isProcessAlive(pid)) return { stopped: true, killed: false };
  // Re-verify before the lethal escalation: the pid may have churned while
  // we waited out the grace period.
  const lastVerdict = verifyPidFile(recordPath, pid, deps);
  if (lastVerdict === "unknown") return { stopped: false, killed: false };
  if (lastVerdict !== "alive") return { stopped: true, killed: false };
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone between verify and signal
  }
  return { stopped: true, killed: true };
}
