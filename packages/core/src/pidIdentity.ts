// Identity contract for a pid read back from a tracking file: the process now
// holding the pid must have started no later than the record's mtime +
// PID_START_SLACK_MS. Tracking files are only written while their process is
// alive, so a process that started after the record cannot be the one we
// launched — the pid was recycled. "unknown" is fail-closed: never signalled,
// but the tracking files are kept because the record may still be ours.
import { execFileSync } from "node:child_process";

import { existsSync, statSync } from "./safe-fs.js";

export type PidVerdict = "alive" | "dead" | "reused" | "unknown";

export const PID_START_SLACK_MS = 30_000;

export interface PidIdentityDeps {
  probe?: (pid: number) => void;
  processStartMs?: (pid: number) => number | null;
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
 * The current holder's start time in epoch-ms, or null when it cannot be
 * resolved (ps missing, wedged, or the pid exited between probe and lookup).
 * `etime` is used instead of `lstart` because it is numeric and locale-free.
 */
export function processStartMs(pid: number): number | null {
  try {
    const out = execFileSync(resolvePsPath(), ["-o", "etime=", "-p", String(pid)], {
      encoding: "utf8",
      env: { LC_ALL: "C" },
      timeout: 2000,
    });
    const etimeSeconds = parseEtimeSeconds(out);
    return etimeSeconds === null ? null : Date.now() - etimeSeconds * 1000;
  } catch {
    return null;
  }
}

function defaultProbe(pid: number): void {
  process.kill(pid, 0);
}

/**
 * Verify a recorded pid still names the process it was recorded for.
 * `recordedAtMs` is the tracking record's write time (callers use the record
 * file's mtime). A live pid whose start is later than that + slack belongs to
 * a different process — the pid was recycled and is reported "reused".
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
  } catch {
    return "dead";
  }
  if (recordedAtMs === null) return "unknown";
  const startedAtMs = startOf(pid);
  if (startedAtMs === null) return "unknown";
  return startedAtMs > recordedAtMs + PID_START_SLACK_MS ? "reused" : "alive";
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
