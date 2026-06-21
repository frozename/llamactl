import { omitUndefined } from "@llamactl/core/object";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "../safe-fs.js";
import { unauthorizedResponse, verifyBearer } from "./auth.js";

/**
 * In-place agent self-update. Operator on the control plane POSTs
 * the new binary as a raw octet stream; agent verifies the SHA256,
 * stages it next to the running binary, atomic-renames over its own
 * `process.execPath`, keeps the previous binary as `<execPath>.previous`
 * for rollback, then schedules `process.exit(0)` so launchd respawns
 * into the new binary.
 *
 * A detached watchdog subprocess is spawned (when `opts.watchdog` is set)
 * before the exit. It polls the agent's listen endpoint; if launchd fails
 * to respawn within the deadline it restores `.previous` and relaunches
 * the agent directly so the node self-heals without operator intervention.
 *
 * Bearer-auth'd with the same token as every other agent endpoint —
 * only callers with the agent's existing kubeconfig credentials can
 * push an update.
 *
 * Same-platform, signed-by-an-identity-the-target-trusts is the
 * operator's contract. The agent does not validate the signature
 * itself; macOS TCC + Gatekeeper enforce that out of band when the
 * process re-spawns. If the new binary fails to start, launchd's
 * KeepAlive flips it back into a respawn loop and the operator can
 * `agent rollback` (separate command) to restore `.previous`.
 */

// ---------------------------------------------------------------------------
// Watchdog types + logic
// ---------------------------------------------------------------------------

export interface WatchdogConfig {
  selfPath: string;
  previousPath: string;
  host: string;
  port: number;
  /** Milliseconds to wait before first probe (default 8000). */
  gracePeriodMs?: number;
  /** Milliseconds between probes (default 5000). */
  pollIntervalMs?: number;
  /** Maximum probe attempts before triggering recovery (default 8). */
  maxPollAttempts?: number;
}

export interface WatchdogDeps {
  /** Returns true when the agent endpoint is accepting connections. */
  probe: (host: string, port: number) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  /** Copy src → dst (overwrite). */
  copyFile: (src: string, dst: string) => void;
  /** Spawn the agent binary detached to restart it. */
  spawn: (execPath: string) => void;
  /** Last-resort error reporting that must not throw. */
  stderr: (msg: string) => void;
}

/**
 * Watchdog logic with fully injectable side-effects for unit testing.
 * Waits up to `gracePeriodMs + maxPollAttempts * pollIntervalMs` for
 * the agent to come back. On timeout, copies `.previous` over `selfPath`
 * and spawns the agent so the node recovers without operator action.
 *
 * Every operation is wrapped in try/catch so a partial failure cannot
 * propagate and strand the watchdog process.
 */
export async function runWatchdog(config: WatchdogConfig, deps: WatchdogDeps): Promise<void> {
  const grace = config.gracePeriodMs ?? 8000;
  const interval = config.pollIntervalMs ?? 5000;
  const maxAttempts = config.maxPollAttempts ?? 8;
  const { host, port, selfPath, previousPath } = config;

  await deps.sleep(grace);

  for (let i = 0; i < maxAttempts; i++) {
    try {
      if (await deps.probe(host, port)) return;
    } catch {
      // probe error is non-fatal — keep polling
    }
    if (i < maxAttempts - 1) await deps.sleep(interval);
  }

  // Agent did not come back — self-heal by restoring the known-good binary.
  try {
    deps.copyFile(previousPath, selfPath);
  } catch (err) {
    deps.stderr(`watchdog: restore .previous failed: ${String(err)}`);
  }

  // Always attempt relaunch even when the restore above threw.
  try {
    deps.spawn(selfPath);
  } catch (err) {
    deps.stderr(`watchdog: relaunch failed: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Production watchdog spawn (bun --eval with inline script)
// ---------------------------------------------------------------------------

function buildWatchdogEval(config: WatchdogConfig): string {
  const grace = config.gracePeriodMs ?? 8000;
  const interval = config.pollIntervalMs ?? 5000;
  const maxAttempts = config.maxPollAttempts ?? 8;
  const { host, port, selfPath, previousPath } = config;
  const portS = port.toString();
  const graceS = grace.toString();
  const intervalS = interval.toString();
  const maxS = maxAttempts.toString();
  const maxM1S = (maxAttempts - 1).toString();
  return (
    `const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));` +
    `async function probe(){try{` +
    `const s=await Bun.connect({hostname:${JSON.stringify(host)},port:${portS},` +
    `socket:{open(){},data(){},close(){},error(){}}});` +
    `s.end();return true;}catch{return false;}}` +
    `const{copyFileSync}=await import("node:fs");` +
    `const{spawn}=await import("node:child_process");` +
    `await sleep(${graceS});` +
    `for(let i=0;i<${maxS};i++){` +
    `try{if(await probe())process.exit(0);}catch{}` +
    `if(i<${maxM1S})await sleep(${intervalS});}` +
    `try{copyFileSync(${JSON.stringify(previousPath)},${JSON.stringify(selfPath)});}` +
    `catch(e){process.stderr.write(String(e));}` +
    `try{spawn(${JSON.stringify(selfPath)},[],{detached:true,stdio:"ignore"}).unref();}` +
    `catch(e){process.stderr.write(String(e));}`
  );
}

function spawnDetachedWatchdog(config: WatchdogConfig): void {
  try {
    const proc = Bun.spawn(["bun", "--eval", buildWatchdogEval(config)], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
  } catch {
    // Non-fatal: launchd KeepAlive may still respawn the agent.
    process.stderr.write("agent-update: watchdog spawn failed\n");
  }
}

// ---------------------------------------------------------------------------
// handleAgentUpdate
// ---------------------------------------------------------------------------

export interface AgentUpdateOptions {
  /** SHA-256 hex of the expected bearer token. */
  tokenHash: string;
  /**
   * Optional override for the binary path the agent treats as its own.
   * Defaults to `process.execPath` — when running as a bun-compiled
   * binary that's the path the operator wants to update. Tests pass
   * a temp file here so they don't need to overwrite the test runner.
   */
  selfPath?: string;
  /**
   * Test-only override: skip the `process.exit(0)` at the end. The
   * default behaviour (exit so launchd respawns) is what we want in
   * production but breaks unit tests by killing the test runner.
   */
  exitAfter?: boolean;
  /**
   * When set, a detached watchdog subprocess is spawned before the agent
   * exits. The watchdog polls `host:port`; if the agent doesn't come back
   * within the deadline it restores `.previous` and relaunches directly.
   */
  watchdog?: {
    host: string;
    port: number;
    gracePeriodMs?: number;
    pollIntervalMs?: number;
    maxPollAttempts?: number;
  };
  /**
   * Test-only: replaces the real `spawnDetachedWatchdog` call so tests
   * can assert the config without launching a real subprocess. Only called
   * when `watchdog` is also set.
   */
  _spawnWatchdog?: (config: WatchdogConfig) => void;
}

export interface AgentUpdateResult {
  ok: boolean;
  oldSha256: string;
  newSha256: string;
  oldSize: number;
  newSize: number;
  /** Path the new binary was written to. */
  installedAt: string;
  /** Path of the prior binary (kept for rollback). */
  previousAt: string;
  message?: string;
}

function sha256OfFile(path: string): string {
  // Sync read is fine — agent binaries are ~70 MB on the high end.
  // Streaming would matter for >1 GB; not our case.
  const bytes = readFileSync(path);
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function handleAgentUpdate(req: Request, opts: AgentUpdateOptions): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  if (!verifyBearer(req, opts.tokenHash)) {
    return unauthorizedResponse();
  }
  const expectedSha = req.headers.get("x-sha256")?.trim().toLowerCase();
  if (!expectedSha || !/^[0-9a-f]{64}$/.test(expectedSha)) {
    return jsonError(400, "missing-or-invalid-x-sha256-header");
  }

  const buffer = new Uint8Array(await req.arrayBuffer());
  if (buffer.length === 0) {
    return jsonError(400, "empty-body");
  }
  const actualSha = sha256OfBytes(buffer);
  if (actualSha !== expectedSha) {
    return jsonError(400, `sha256-mismatch (expected ${expectedSha}, got ${actualSha})`);
  }

  const selfPath = opts.selfPath ?? process.execPath;
  if (!existsSync(selfPath)) {
    return jsonError(500, `selfPath does not exist: ${selfPath}`);
  }
  const oldSha = sha256OfFile(selfPath);
  const oldSize = statSync(selfPath).size;
  const newSize = buffer.length;
  const installDir = dirname(selfPath);
  const stagingPath = join(installDir, ".llamactl-agent.staging");
  const previousPath = `${selfPath}.previous`;

  try {
    writeFileSync(stagingPath, buffer);
    chmodSync(stagingPath, 0o755);
    // Snapshot the current binary as `.previous` for rollback BEFORE
    // we overwrite. copyFileSync is COW on APFS — cheap.
    copyFileSync(selfPath, previousPath);
    // Atomic rename within the same filesystem.
    renameSync(stagingPath, selfPath);
  } catch (err) {
    return jsonError(500, `swap-failed: ${(err as Error).message}`);
  }

  const result: AgentUpdateResult = {
    ok: true,
    oldSha256: oldSha,
    newSha256: actualSha,
    oldSize,
    newSize,
    installedAt: selfPath,
    previousAt: previousPath,
  };
  const body = JSON.stringify(result);

  // Spawn watchdog BEFORE scheduling exit so it's running before teardown.
  if (opts.watchdog) {
    const wdConfig: WatchdogConfig = {
      selfPath,
      previousPath,
      host: opts.watchdog.host,
      port: opts.watchdog.port,
      ...omitUndefined({
        gracePeriodMs: opts.watchdog.gracePeriodMs,
        pollIntervalMs: opts.watchdog.pollIntervalMs,
        maxPollAttempts: opts.watchdog.maxPollAttempts,
      }),
    };
    (opts._spawnWatchdog ?? spawnDetachedWatchdog)(wdConfig);
  }

  // Fire-and-forget exit so launchd's KeepAlive respawns into the
  // new binary. 200ms is enough to flush the response back to the
  // operator before tearing down. Tests bypass this by passing
  // `exitAfter: false`.
  if (opts.exitAfter !== false) {
    setTimeout(() => process.exit(0), 200);
  }

  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// handleAgentRollback
// ---------------------------------------------------------------------------

export interface AgentRollbackOptions {
  tokenHash: string;
  selfPath?: string;
  exitAfter?: boolean;
}

export interface AgentRollbackResult {
  ok: boolean;
  /** Path that was restored. */
  restoredAt: string;
  /** Hash of the binary now at `installedAt` (the restored .previous). */
  newSha256: string;
  /** Hash of the binary that was rolled out (was at `installedAt`,
   *  now overwritten — we don't keep a `.previous.previous`). */
  rolledOutSha256: string;
  message?: string;
}

/**
 * Companion to `handleAgentUpdate` — restores `<execPath>.previous`
 * over the running binary + exits 0 so launchd respawns the prior
 * version. Same auth + bookkeeping; returns the hashes so the
 * operator confirms which build is now in place.
 *
 * Bidirectional: calling rollback again flips back to the OTHER
 * version, since the in-place rename swaps. That's fine — the
 * symmetry makes "I pushed a bad build, fix it" a single repeated
 * command if the network blips.
 */
export function handleAgentRollback(req: Request, opts: AgentRollbackOptions): Response {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  if (!verifyBearer(req, opts.tokenHash)) {
    return unauthorizedResponse();
  }

  const selfPath = opts.selfPath ?? process.execPath;
  const previousPath = `${selfPath}.previous`;
  if (!existsSync(selfPath)) {
    return jsonError(500, `selfPath does not exist: ${selfPath}`);
  }
  if (!existsSync(previousPath)) {
    return jsonError(409, `no previous binary at ${previousPath} — nothing to roll back to`);
  }

  const rolledOutSha = sha256OfFile(selfPath);
  const restoredSha = sha256OfFile(previousPath);
  const swapStaging = `${selfPath}.swap`;

  try {
    // Three-way swap: current → swap, previous → current, swap → previous.
    // Symmetric so a second rollback flips back without losing either binary.
    renameSync(selfPath, swapStaging);
    renameSync(previousPath, selfPath);
    renameSync(swapStaging, previousPath);
    chmodSync(selfPath, 0o755);
  } catch (err) {
    return jsonError(500, `rollback-failed: ${(err as Error).message}`);
  }

  const result: AgentRollbackResult = {
    ok: true,
    restoredAt: selfPath,
    newSha256: restoredSha,
    rolledOutSha256: rolledOutSha,
  };
  const body = JSON.stringify(result);

  if (opts.exitAfter !== false) {
    setTimeout(() => process.exit(0), 200);
  }

  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
