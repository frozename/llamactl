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
  timeoutMs?: number;
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
  sleep: (ms: number) => Promise<void>;
  /** Progress lines (stderr under --json so stdout stays machine-readable). */
  log: (line: string) => void;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

async function defaultExec(argv: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
  try {
    const proc = Bun.spawn({
      cmd: [...argv],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } catch (err) {
    return { code: 127, stdout: "", stderr: (err as Error).message };
  }
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
    sleep: async (ms): Promise<void> => {
      await Bun.sleep(ms);
    },
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
