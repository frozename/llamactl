// Injected effects for `llamactl update`. Every process spawn, HTTP probe,
// file read and clock read goes through here so the procedure can be tested
// without git, systemctl, launchctl or a network. Nothing here imports from the
// checkout lazily: after the update switches HEAD the running process must keep
// using what it loaded at startup.
import { resolveEnv } from "@llamactl/core/env";
import { listLocalRoutes } from "@llamactl/core/workloadRuntime";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "../../safe-fs.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  /** Kill the command (its whole process group with `processGroup`) after this long. */
  timeoutMs?: number;
  /**
   * Run the command in its own process group and kill the group on timeout or
   * abort, so nothing it spawned outlives it.
   */
  processGroup?: boolean;
  /** Kill the command when this aborts. */
  signal?: AbortSignal;
}

/** Exit codes the default exec reports for a command it had to kill. */
export const EXIT_TIMED_OUT = 124;
export const EXIT_ABORTED = 130;

/** A held lock; `release` is idempotent. */
export interface LockHandle {
  release: () => void;
}

export type ExecFn = (argv: readonly string[], opts?: ExecOptions) => Promise<ExecResult>;

export interface HttpResponse {
  status: number;
  body: string;
}

export interface HttpOptions {
  timeoutMs: number;
  /** Skip TLS verification (loopback agent with a self-signed cert only). */
  insecureTls?: boolean;
}

/** GET a URL; null when nothing answered (refused, timeout, TLS failure). */
export type HttpGetFn = (url: string, opts: HttpOptions) => Promise<HttpResponse | null>;

/** A model process llamactl manages on this host (survives controller restarts). */
export interface ManagedHost {
  name: string;
  kind: "ModelHost" | "ModelRun";
  pid: number;
  host: string;
  port: number;
}

export interface UpdateDeps {
  exec: ExecFn;
  httpGet: HttpGetFn;
  which: (bin: string) => string | null;
  readFile: (path: string) => string | null;
  /** Bytes of `path` from `offset` on, or null when unreadable. */
  readFileFrom: (path: string, offset: number) => string | null;
  fileSize: (path: string) => number | null;
  appendFile: (path: string, data: string) => void;
  listManagedHosts: (env: NodeJS.ProcessEnv) => ManagedHost[];
  pid: number;
  platform: NodeJS.Platform;
  uid: number;
  env: NodeJS.ProcessEnv;
  execPath: string;
  /** Directory of this module, used to find the checkout the CLI runs from. */
  moduleDir: string;
  now: () => number;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Take an exclusive flock(1) on `path`, waiting up to `waitSec`. Null when it
   * was not acquired in time or `signal` aborted the wait.
   */
  acquireLock: (path: string, waitSec: number, signal?: AbortSignal) => Promise<LockHandle | null>;
  /** Entry names in a directory, or null when it cannot be read. */
  listDir: (path: string) => string[] | null;
  /** Call `handler` on SIGINT/SIGTERM until the returned function unsubscribes. */
  onSignal: (handler: (signal: NodeJS.Signals) => void) => () => void;
  /** Progress lines (stderr under --json so stdout stays machine-readable). */
  log: (line: string) => void;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

function killTree(pid: number, group: boolean, sig: NodeJS.Signals): void {
  try {
    process.kill(group ? -pid : pid, sig);
  } catch {
    // Already gone.
  }
}

async function defaultExec(argv: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    proc = Bun.spawn({
      cmd: [...argv],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: opts.processGroup === true,
    });
  } catch (err) {
    return { code: 127, stdout: "", stderr: (err as Error).message };
  }
  const group = opts.processGroup === true;
  // Set from the timer and abort callbacks; an object so it reads as mutable.
  const killed: { why: "aborted" | "timed out" | null } = { why: null };
  const kill = (why: "aborted" | "timed out"): void => {
    killed.why = why;
    killTree(proc.pid, group, "SIGTERM");
    setTimeout(() => {
      killTree(proc.pid, group, "SIGKILL");
    }, 5000).unref();
  };
  const timer =
    opts.timeoutMs === undefined
      ? null
      : setTimeout(() => {
          kill("timed out");
        }, opts.timeoutMs);
  const onAbort = (): void => {
    kill("aborted");
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted === true) onAbort();
  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (killed.why === null) return { code, stdout, stderr };
    const exit = killed.why === "timed out" ? EXIT_TIMED_OUT : EXIT_ABORTED;
    return {
      code: exit,
      stdout,
      stderr: `${stderr}\n${argv[0] ?? "command"} ${killed.why}; killed`,
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    // Nothing the command started may outlive it (e.g. a bun install child).
    if (group) killTree(proc.pid, true, "SIGKILL");
  }
}

/**
 * Hold an flock(1) on `path` in a child that keeps the lock until its stdin
 * closes: on release, or when this process exits for any reason.
 */
async function defaultAcquireLock(
  path: string,
  waitSec: number,
  signal?: AbortSignal,
): Promise<LockHandle | null> {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // flock reports an unusable path itself.
  }
  const proc = Bun.spawn({
    cmd: ["flock", "-w", String(waitSec), path, "sh", "-c", "echo locked; exec cat >/dev/null"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  });
  const release = (): void => {
    try {
      void proc.stdin.end();
    } catch {
      // Already closed.
    }
    killTree(proc.pid, true, "SIGTERM");
  };
  const onAbort = (): void => {
    release();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const reader = proc.stdout.getReader();
  let out = "";
  try {
    while (!out.includes("locked")) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
  } finally {
    reader.releaseLock();
    signal?.removeEventListener("abort", onAbort);
  }
  if (!out.includes("locked") || signal?.aborted === true) {
    release();
    return null;
  }
  return { release };
}

async function defaultHttpGet(url: string, opts: HttpOptions): Promise<HttpResponse | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(opts.timeoutMs),
      ...(opts.insecureTls === true ? { tls: { rejectUnauthorized: false } } : {}),
    });
    return { status: res.status, body: await res.text() };
  } catch {
    return null;
  }
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function defaultListDir(path: string): string[] | null {
  try {
    return readdirSync(path);
  } catch {
    return null;
  }
}

function defaultOnSignal(handler: (signal: NodeJS.Signals) => void): () => void {
  let count = 0;
  const listener = (sig: NodeJS.Signals): void => {
    count += 1;
    // A third signal is the operator insisting: exit without the cleanup.
    if (count >= 3) process.exit(130);
    handler(sig);
  };
  process.on("SIGINT", listener);
  process.on("SIGTERM", listener);
  return () => {
    process.off("SIGINT", listener);
    process.off("SIGTERM", listener);
  };
}

function defaultReadFileFrom(path: string, offset: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    const start = Math.min(Math.max(0, offset), size);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function defaultFileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function defaultAppendFile(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, data);
}

/** Running local ModelHosts and ModelRuns, one entry per workload. */
function defaultListManagedHosts(env: NodeJS.ProcessEnv): ManagedHost[] {
  const byName = new Map<string, ManagedHost>();
  for (const route of listLocalRoutes(resolveEnv(env))) {
    if (byName.has(route.workload)) continue;
    byName.set(route.workload, {
      name: route.workload,
      kind: route.kind,
      pid: route.pid,
      host: route.host,
      port: route.port,
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function defaultUpdateDeps(): UpdateDeps {
  return {
    exec: defaultExec,
    httpGet: defaultHttpGet,
    which: (bin) => Bun.which(bin),
    readFile: defaultReadFile,
    readFileFrom: defaultReadFileFrom,
    fileSize: defaultFileSize,
    appendFile: defaultAppendFile,
    listManagedHosts: defaultListManagedHosts,
    pid: process.pid,
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    env: process.env,
    execPath: process.execPath,
    moduleDir: dirname(fileURLToPath(import.meta.url)),
    now: () => Date.now(),
    sleep: async (ms, signal): Promise<void> => {
      if (signal?.aborted === true) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done(): void {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
      });
    },
    acquireLock: defaultAcquireLock,
    listDir: defaultListDir,
    onSignal: defaultOnSignal,
    log: (line): void => {
      process.stdout.write(`${line}\n`);
    },
    stdout: (chunk): void => {
      process.stdout.write(chunk);
    },
    stderr: (chunk): void => {
      process.stderr.write(chunk);
    },
  };
}
