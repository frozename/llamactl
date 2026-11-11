// Test-only reaper for fake engine fixtures (#627). Failing or timed-out
// tests can leave fake llama-server / rpc-server / osmos-api processes
// (and their same-group children, e.g. a backgrounded `sleep`) alive past
// the tmpdir teardown. This helper finds them by scratch-path match, by
// pidfile or by explicit pid list, SIGTERMs them, escalates to SIGKILL,
// waits for them to exit and returns whatever is still alive.
//
// Identity guards, so a recycled pid now held by a production llama-server
// is never signalled:
// - a pidfile pid must pass the production identity check (verifyPidFile:
//   its holder started no later than the pidfile mtime + slack) and must
//   still look like a fake (scratch needle in argv, or engine argv0);
// - an explicit pid must look like a fake and must have started after this
//   module loaded. ps etime has one-second resolution and rounds the start
//   toward later, so a holder that started up to a second before load can
//   pass the start check; it still has to look like a fake;
// - a process group is signalled only when a verified target leads it
//   (pgid === pid), and never the runner's own group. Every other target
//   is signalled on its own.
import { processStartMs, verifyPidFile } from "../src/pidIdentity.js";
import { existsSync, readFileSync } from "../src/safe-fs.js";

const MODULE_LOADED_AT_MS = Date.now();

export interface ReapFakeOptions {
  /** Paths whose appearance in argv marks a fake. Unset or empty matches nothing. */
  scratch?: string | readonly string[] | undefined;
  pidFiles?: readonly string[];
  pids?: readonly number[];
  graceMs?: number;
  timeoutMs?: number;
}

interface PsRow {
  pid: number;
  pgid: number;
  stat: string;
  command: string;
}

const DEFAULT_GRACE_MS = 1000;
const DEFAULT_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 50;
const PS_FORMAT = "pid=,pgid=,stat=,command=";
const ROW_PATTERN = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*/;
const ENGINE_ARGV0 = new Set(["llama-server", "rpc-server", "osmos-api"]);

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parsePsRow(line: string): PsRow | null {
  const match = ROW_PATTERN.exec(line);
  if (match === null) {
    return null;
  }
  const stat = match[3] ?? "";
  if (stat.startsWith("Z")) {
    return null;
  }
  return {
    pid: Number(match[1]),
    pgid: Number(match[2]),
    stat,
    command: line.slice(match[0].length),
  };
}

function snapshotProcesses(): PsRow[] {
  const res = Bun.spawnSync(["ps", "-A", "-ww", "-o", PS_FORMAT]);
  const stdout = new TextDecoder().decode(res.stdout);
  // A failed ps scan must never read as "nothing to reap".
  if (res.exitCode !== 0 || stdout.trim() === "") {
    const stderr = new TextDecoder().decode(res.stderr).trim();
    throw new Error(`ps snapshot failed: exitCode=${String(res.exitCode)} stderr=${stderr}`);
  }
  const rows: PsRow[] = [];
  for (const line of stdout.split("\n")) {
    const row = parsePsRow(line);
    if (row !== null) {
      rows.push(row);
    }
  }
  return rows;
}

function ownProcessGroup(rows: readonly PsRow[]): number {
  const own = rows.find((row) => row.pid === process.pid);
  if (own === undefined) {
    throw new Error(`ps snapshot does not contain self pid ${String(process.pid)}`);
  }
  return own.pgid;
}

function needlesFor(scratch: ReapFakeOptions["scratch"]): string[] {
  if (scratch === undefined) {
    return [];
  }
  const list: readonly unknown[] = typeof scratch === "string" ? [scratch] : scratch;
  return list.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

function argv0Basename(command: string): string {
  const trimmed = command.trimStart();
  const end = trimmed.search(/\s/);
  const argv0 = end === -1 ? trimmed : trimmed.slice(0, end);
  return argv0.slice(argv0.lastIndexOf("/") + 1);
}

function pidFromPidFile(file: string): number | null {
  if (!existsSync(file)) {
    return null;
  }
  const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function matchesNeedle(row: PsRow, needles: readonly string[]): boolean {
  return needles.some((needle) => row.command.includes(needle));
}

function matchesFakeEngine(row: PsRow, needles: readonly string[]): boolean {
  return matchesNeedle(row, needles) || ENGINE_ARGV0.has(argv0Basename(row.command));
}

function rowTargets(rows: readonly PsRow[], needles: readonly string[]): Set<number> {
  const targets = new Set<number>();
  for (const row of rows) {
    if (row.pid !== process.pid && matchesNeedle(row, needles)) {
      targets.add(row.pid);
    }
  }
  return targets;
}

function pidFileTargets(
  byPid: ReadonlyMap<number, PsRow>,
  needles: readonly string[],
  pidFiles: readonly string[],
): Set<number> {
  const targets = new Set<number>();
  for (const file of pidFiles) {
    const pid = pidFromPidFile(file);
    if (pid === null || pid === process.pid) {
      continue;
    }
    const row = byPid.get(pid);
    if (row === undefined || !matchesFakeEngine(row, needles)) {
      continue;
    }
    // Pid-reuse guard: a holder that started after the pidfile was written
    // is not the process the pidfile recorded. Only "alive" is signalled.
    if (verifyPidFile(file, pid) === "alive") {
      targets.add(pid);
    }
  }
  return targets;
}

function startedAfterModuleLoad(pid: number): boolean {
  const startedAtMs = processStartMs(pid);
  return startedAtMs !== null && startedAtMs > MODULE_LOADED_AT_MS;
}

function extraPidTargets(
  byPid: ReadonlyMap<number, PsRow>,
  needles: readonly string[],
  extraPids: readonly number[],
): Set<number> {
  const targets = new Set<number>();
  for (const pid of extraPids) {
    if (pid === process.pid) {
      continue;
    }
    // A pid that already exited is a no-op. A live one must look like a
    // fake and must have started after this module loaded.
    const row = byPid.get(pid);
    if (row !== undefined && matchesFakeEngine(row, needles) && startedAfterModuleLoad(pid)) {
      targets.add(pid);
    }
  }
  return targets;
}

function collectTargets(
  rows: readonly PsRow[],
  needles: readonly string[],
  pidFiles: readonly string[],
  extraPids: readonly number[],
): Set<number> {
  const byPid = new Map(rows.map((row) => [row.pid, row] as const));
  const targets = rowTargets(rows, needles);
  for (const pid of pidFileTargets(byPid, needles, pidFiles)) {
    targets.add(pid);
  }
  for (const pid of extraPidTargets(byPid, needles, extraPids)) {
    targets.add(pid);
  }
  return targets;
}

function collectGroups(
  rows: readonly PsRow[],
  targets: ReadonlySet<number>,
  ownPgid: number,
): Set<number> {
  const groups = new Set<number>();
  for (const row of rows) {
    // Only a verified target that leads its own group takes the group down.
    const leadsGroup = row.pgid === row.pid;
    if (targets.has(row.pid) && leadsGroup && row.pgid > 1 && row.pgid !== ownPgid) {
      groups.add(row.pgid);
    }
  }
  return groups;
}

function isIgnorableSignalError(err: unknown): boolean {
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  return code === "ESRCH" || code === "EPERM";
}

function signalEvery(targets: Iterable<number>, asGroup: boolean, signal: NodeJS.Signals): void {
  for (const value of targets) {
    try {
      process.kill(asGroup ? -value : value, signal);
    } catch (err) {
      if (!isIgnorableSignalError(err)) {
        throw err;
      }
    }
  }
}

function survivorPids(
  rows: readonly PsRow[],
  targets: ReadonlySet<number>,
  groups: ReadonlySet<number>,
): number[] {
  const survivors: number[] = [];
  for (const row of rows) {
    if (row.pid !== process.pid && (targets.has(row.pid) || groups.has(row.pgid))) {
      survivors.push(row.pid);
    }
  }
  return survivors;
}

async function waitUntilQuiet(
  targets: ReadonlySet<number>,
  groups: ReadonlySet<number>,
  budgetMs: number,
): Promise<number[]> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const survivors = survivorPids(snapshotProcesses(), targets, groups);
    if (survivors.length === 0 || Date.now() >= deadline) {
      return survivors;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export async function reapFakeProcesses(opts: ReapFakeOptions): Promise<number[]> {
  const rows = snapshotProcesses();
  const ownPgid = ownProcessGroup(rows);
  const needles = needlesFor(opts.scratch);
  const targets = collectTargets(rows, needles, opts.pidFiles ?? [], opts.pids ?? []);
  if (targets.size === 0) {
    return [];
  }
  const groups = collectGroups(rows, targets, ownPgid);
  signalEvery(groups, true, "SIGTERM");
  signalEvery(targets, false, "SIGTERM");
  const afterGrace = await waitUntilQuiet(targets, groups, opts.graceMs ?? DEFAULT_GRACE_MS);
  if (afterGrace.length === 0) {
    return [];
  }
  signalEvery(groups, true, "SIGKILL");
  signalEvery(targets, false, "SIGKILL");
  return await waitUntilQuiet(targets, groups, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}
