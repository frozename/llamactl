import type { ModelHostReadiness } from "./types.js";

import { isProcessAlive, psColumn, type SignalIdentity, verifyPidFile } from "../pidIdentity.js";

const POLL_MS = 100;
// A SIGKILLed process can take seconds to release model memory and its port, and must be reaped before kill(pid, 0) fails.
const KILL_WAIT_MS = 5_000;
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * The process-group id of `pid` (via `ps`), or null if it can't be read. Used
 * to decide whether a group-wide signal is safe: only when `pid` IS its own
 * group leader (pgid === pid).
 */
function processGroupId(pid: number): number | null {
  const parsed = Number.parseInt(psColumn(pid, "pgid") ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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

// Resolving a teardown while the pid is still alive would report a shutdown
// that never confirmed exit: a survivor past the wait is a failed shutdown,
// not a stopped process.
async function awaitProcessExit(pid: number, deadlineMs: number): Promise<void> {
  while (Date.now() < deadlineMs && isProcessAlive(pid)) {
    await sleep(POLL_MS);
  }
  if (isProcessAlive(pid)) {
    throw new Error(`process ${String(pid)} still alive after SIGKILL`);
  }
}

export async function gracefulShutdown(
  pid: number,
  graceMs = 10_000,
  identity?: SignalIdentity,
): Promise<void> {
  // When a tracking record is given, the pid must still be the process it was
  // recorded for before any signal goes out — recycled or unverifiable pids
  // are left running.
  if (identity?.recordPath !== undefined) {
    const verdict = verifyPidFile(identity.recordPath, pid, {
      ...identity.deps,
      ...(identity.expectCommand !== undefined ? { expectCommand: identity.expectCommand } : {}),
    });
    if (verdict !== "alive") return;
  }
  // Decide group-vs-direct ONCE, while the leader is alive: after it dies its
  // pgid is unreadable, but the group id (== the original pid) stays valid for
  // the SIGKILL sweep of any worker that ignored SIGTERM.
  const target = shutdownSignalTarget(pid);
  try {
    process.kill(target, "SIGTERM");
  } catch {
    // Best-effort cleanup; failures are not actionable here.
  }

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
  } catch {
    // Best-effort cleanup; failures are not actionable here.
  }

  await awaitProcessExit(pid, Date.now() + KILL_WAIT_MS);
}

async function fetchModelIds(
  endpoint: { host: string; port: number },
  timeoutMs: number,
): Promise<string[]> {
  const response = await fetch(
    `http://${formatHostForUrl(endpoint.host)}:${String(endpoint.port)}/v1/models`,
    {
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok) {
    return [];
  }
  const body = (await response.json()) as { data?: { id?: string }[] };
  return (body.data ?? []).map((model) => model.id ?? "").filter(Boolean);
}

/**
 * Single-shot serving-readiness probe (#220): GET <path> must answer
 * expectStatus (default exactly 200) and, when expectJson is set, a JSON
 * object body whose top-level keys strictly equal every expected value.
 * Fails closed — any fetch, parse, or deadline failure resolves false.
 */
export async function checkServingReadiness(
  endpoint: { host: string; port: number },
  readiness: ModelHostReadiness,
  opts: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  try {
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    const timeoutMs = opts.timeoutMs ?? 1_000;
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(
      `http://${formatHostForUrl(endpoint.host)}:${String(endpoint.port)}${readiness.path}`,
      { signal },
    );
    if (response.status !== (readiness.expectStatus ?? 200)) {
      return false;
    }
    if (readiness.expectJson === undefined) {
      return true;
    }
    const aborted = new Promise<null>((resolve) => {
      if (signal.aborted) resolve(null);
      else
        signal.addEventListener(
          "abort",
          () => {
            resolve(null);
          },
          { once: true },
        );
    });
    const body: unknown = await Promise.race([response.json(), aborted]);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return false;
    }
    const record = body as Record<string, unknown>;
    return Object.entries(readiness.expectJson).every(([key, value]) => record[key] === value);
  } catch {
    return false;
  }
}

async function fetchReadinessOk(
  endpoint: { host: string; port: number },
  readiness: ModelHostReadiness,
  timeoutMs: number,
): Promise<boolean> {
  return await checkServingReadiness(endpoint, readiness, { timeoutMs });
}

export async function pollUntilModelIds(
  endpoint: { host: string; port: number },
  timeoutMs: number,
  readiness?: ModelHostReadiness,
): Promise<{ ready: boolean; modelIds: string[] }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const remaining = deadline - Date.now();
      const modelIds = await fetchModelIds(endpoint, Math.min(1000, Math.max(1, remaining)));
      if (modelIds.length > 0) {
        const readinessRemaining = deadline - Date.now();
        const readinessOk =
          readiness === undefined ||
          (await fetchReadinessOk(
            endpoint,
            readiness,
            Math.min(1000, Math.max(1, readinessRemaining)),
          ));
        if (readinessOk) {
          return { ready: true, modelIds };
        }
      }
    } catch {
      // Best-effort cleanup; failures are not actionable here.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await sleep(Math.min(250, remaining));
  }
  return { ready: false, modelIds: [] };
}
