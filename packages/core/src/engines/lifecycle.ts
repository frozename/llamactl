import { spawnSync } from "node:child_process";

const POLL_MS = 100;
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatHostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * The process-group id of `pid` (via `ps`), or null if it can't be read. Used
 * to decide whether a group-wide signal is safe: only when `pid` IS its own
 * group leader (pgid === pid).
 */
function processGroupId(pid: number): number | null {
  try {
    const out = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
    if (out.status !== 0) return null;
    const parsed = Number.parseInt(out.stdout.trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the signal target for `pid`: the whole process group (`-pid`) when
 * `pid` is its own group leader — true for our `detached: true` spawns and any
 * setsid'd server, so forked workers (e.g. oMLX Python workers) are reaped too
 * — otherwise just `pid`. The fallback means an adopted process that merely
 * shares another group (e.g. a hand-started `nohup` server) can never take its
 * unrelated group down with it: worst case equals a plain direct kill.
 */
function shutdownSignalTarget(pid: number): number {
  return pid > 1 && processGroupId(pid) === pid ? -pid : pid;
}

export async function gracefulShutdown(pid: number, graceMs = 10_000): Promise<void> {
  // Decide group-vs-direct ONCE, while the leader is alive: after it dies its
  // pgid is unreadable, but the group id (== the original pid) stays valid for
  // the SIGKILL sweep of any worker that ignored SIGTERM.
  const target = shutdownSignalTarget(pid);
  try {
    process.kill(target, "SIGTERM");
  } catch {}

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    const remaining = deadline - Date.now();
    await sleep(Math.min(POLL_MS, Math.max(0, remaining)));
  }

  try {
    process.kill(target, "SIGKILL");
  } catch {}
}

async function fetchModelIds(
  endpoint: { host: string; port: number },
  timeoutMs: number,
): Promise<string[]> {
  const response = await fetch(
    `http://${formatHostForUrl(endpoint.host)}:${endpoint.port}/v1/models`,
    {
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok) {
    return [];
  }
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((model) => model.id ?? "").filter(Boolean);
}

export async function pollUntilModelIds(
  endpoint: { host: string; port: number },
  timeoutMs: number,
): Promise<{ ready: boolean; modelIds: string[] }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const remaining = deadline - Date.now();
      const modelIds = await fetchModelIds(endpoint, Math.min(1000, Math.max(1, remaining)));
      if (modelIds.length > 0) {
        return { ready: true, modelIds };
      }
    } catch {}
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await sleep(Math.min(250, remaining));
  }
  return { ready: false, modelIds: [] };
}
