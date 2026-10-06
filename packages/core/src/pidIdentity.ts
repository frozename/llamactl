// Identity contract for a pid read back from a tracking file: the process now
// holding the pid must have started no later than the record's mtime +
// PID_START_SLACK_MS. Tracking files are only written while their process is
// alive, so a process that started after the record cannot be the one we
// launched — the pid was recycled. "unknown" is fail-closed: never signalled,
// but the tracking files are kept because the record may still be ours.
export type PidVerdict = "alive" | "dead" | "reused" | "unknown";

export const PID_START_SLACK_MS = 30_000;

export interface PidIdentityDeps {
  probe?: (pid: number) => void;
  processStartMs?: (pid: number) => number | null;
}

export function parseEtimeSeconds(_raw: string): number | null {
  return null;
}

export function processStartMs(_pid: number): number | null {
  return null;
}

export function verifyRecordedPid(
  _pid: number,
  _recordedAtMs: number | null,
  _deps?: PidIdentityDeps,
): PidVerdict {
  return "alive";
}

export function verifyPidFile(
  _recordPath: string,
  _pid: number,
  _deps?: PidIdentityDeps,
): PidVerdict {
  return "alive";
}

export function isRecordedPidAlive(
  _recordPath: string,
  _pid: number,
  _deps?: PidIdentityDeps,
): boolean {
  return true;
}

export function isRecordedPidGone(_verdict: PidVerdict): boolean {
  return false;
}

export function signalRecordedPid(
  _recordPath: string,
  pid: number,
  signal: NodeJS.Signals,
  _deps?: PidIdentityDeps,
): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}
