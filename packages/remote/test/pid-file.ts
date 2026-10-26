import { readFileSync } from "../src/safe-fs.js";

/**
 * Pid-file helpers for tests that spawn `/bin/sh -c 'echo $$ > <file>; exec ...'`.
 *
 * The shell's `>` creates and truncates the file before `echo` writes the pid, so a
 * reader that only waits for the file to exist can read "" and get Number("") === 0.
 * process.kill(0, 0) probes the caller's own process group and always succeeds, so a
 * later wait for pid 0 to die never ends (#297).
 */

/** The exact line `echo $$ > file` writes: digits, then one newline. */
const PID_LINE = /^\d+\n$/;

export interface ReadPidOptions {
  /** Reads the file. A throw (for example ENOENT before the shell creates it) means "not written yet". */
  read?: (path: string) => string;
  /** Waits between reads. */
  sleep?: (ms: number) => Promise<void>;
  /** Poll interval in ms (default 10). */
  intervalMs?: number;
  /** Total budget in ms (default 2000), spent as ceil(timeoutMs / intervalMs) reads. */
  timeoutMs?: number;
}

/** Parses a complete pid line. Throws on anything else, including "" and "0\n". */
export function parsePidLine(text: string): number {
  const pid = PID_LINE.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`pid file does not hold a complete positive pid line: ${JSON.stringify(text)}`);
  }
  return pid;
}

/** Probes a pid with signal 0. Throws on pid <= 0 or a non-integer instead of probing. */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`pidAlive: refusing to probe pid ${String(pid)}; expected a positive integer`);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultRead(path: string): string {
  return readFileSync(path, "utf8");
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function tryRead(read: (path: string) => string, path: string): string | undefined {
  try {
    return read(path);
  } catch {
    return undefined;
  }
}

/**
 * Waits until pidFile holds a complete pid line and returns the pid. A read that throws
 * or returns a partial line is retried; a complete line that is not a positive pid
 * ("0\n") throws at once. Gives up after ceil(timeoutMs / intervalMs) reads.
 */
export async function readPid(pidFile: string, opts: ReadPidOptions = {}): Promise<number> {
  const read = opts.read ?? defaultRead;
  const sleep = opts.sleep ?? defaultSleep;
  const intervalMs = opts.intervalMs ?? 10;
  const attempts = Math.max(1, Math.ceil((opts.timeoutMs ?? 2_000) / intervalMs));
  let last: string | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      await sleep(intervalMs);
    }
    last = tryRead(read, pidFile);
    if (last !== undefined && PID_LINE.test(last)) {
      return parsePidLine(last);
    }
  }
  const seen = last === undefined ? "no readable file" : JSON.stringify(last);
  throw new Error(
    `readPid: ${pidFile} has no complete pid line after ${String(attempts)} reads (last: ${seen})`,
  );
}
