import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { unauthorizedResponse, verifyBearer } from './auth.js';

/**
 * In-place agent self-update. Operator on the control plane POSTs
 * the new binary as a raw octet stream; agent verifies the SHA256,
 * stages it next to the running binary, atomic-renames over its own
 * `process.execPath`, keeps the previous binary as `<execPath>.previous`
 * for rollback, then schedules `process.exit(0)` so launchd respawns
 * into the new binary.
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
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256OfBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function handleAgentUpdate(
  req: Request,
  opts: AgentUpdateOptions,
): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }
  if (!verifyBearer(req, opts.tokenHash)) {
    return unauthorizedResponse();
  }
  const expectedSha = req.headers.get('x-sha256')?.trim().toLowerCase();
  if (!expectedSha || !/^[0-9a-f]{64}$/.test(expectedSha)) {
    return jsonError(400, 'missing-or-invalid-x-sha256-header');
  }

  const buffer = new Uint8Array(await req.arrayBuffer());
  if (buffer.length === 0) {
    return jsonError(400, 'empty-body');
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
  const stagingPath = join(installDir, '.llamactl-agent.staging');
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

  // Fire-and-forget exit so launchd's KeepAlive respawns into the
  // new binary. 200ms is enough to flush the response back to the
  // operator before tearing down. Tests bypass this by passing
  // `exitAfter: false`.
  if (opts.exitAfter !== false) {
    setTimeout(() => process.exit(0), 200);
  }

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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
export async function handleAgentRollback(
  req: Request,
  opts: AgentRollbackOptions,
): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
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
    headers: { 'content-type': 'application/json' },
  });
}
