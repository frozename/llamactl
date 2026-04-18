import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { defaultAgentDir } from './agent-config.js';

/**
 * Bootstrap tokens — single-use, short-lived secrets the operator
 * mints on the control plane to onboard a new node. A token issued
 * via `llamactl deploy-node <name>` is consumed by the target host
 * when it POSTs to the central's `/register` endpoint during the
 * curl-pipe-sh install flow (Sprint I-α Phase I.1).
 *
 * Storage: one YAML file per token under `~/.llamactl/bootstrap-tokens/`,
 * named by the first 8 chars of the token's SHA-256 hash. The file
 * carries the hash (not the plaintext), the requested node name,
 * issue + expiry timestamps, and a `used` flag that flips once
 * consumed. chmod 600 matches agent.yaml.
 *
 * Token secrecy model: the plaintext token only exists at three
 * moments — when `deploy-node` generates it, in the one-liner the
 * operator pastes, and in the `/register` POST body. It's never
 * written to disk in clear form. Validation is a SHA-256 compare
 * against the stored hash.
 */

export const BootstrapTokenSchema = z.object({
  apiVersion: z.literal('llamactl/v1'),
  kind: z.literal('BootstrapToken'),
  nodeName: z.string().min(1),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  centralUrl: z.string().min(1),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
  used: z.boolean().default(false),
  usedAt: z.string().min(1).optional(),
});
export type BootstrapToken = z.infer<typeof BootstrapTokenSchema>;

export function defaultBootstrapTokensDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultAgentDir(env), 'bootstrap-tokens');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function tokenFilePath(tokenHash: string, dir: string): string {
  return join(dir, `${tokenHash.slice(0, 8)}.yaml`);
}

function writeTokenRecord(record: BootstrapToken, dir: string): string {
  BootstrapTokenSchema.parse(record);
  mkdirSync(dir, { recursive: true });
  const path = tokenFilePath(record.tokenHash, dir);
  writeFileSync(path, stringifyYaml(record), 'utf8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
  return path;
}

export interface GenerateTokenOptions {
  nodeName: string;
  /** Milliseconds from now until the token expires. Defaults to 15 min. */
  ttlMs?: number;
  /** Base URL the target host reaches the central at. E.g.,
   *  `https://control.lan:7843`. No trailing slash. */
  centralUrl: string;
  dir?: string;
  now?: () => Date;
}

export interface GeneratedToken {
  /** Plaintext token — show this to the operator exactly once. */
  token: string;
  record: BootstrapToken;
  path: string;
}

export function generateBootstrapToken(opts: GenerateTokenOptions): GeneratedToken {
  const dir = opts.dir ?? defaultBootstrapTokensDir();
  const now = (opts.now ?? (() => new Date()))();
  const ttlMs = opts.ttlMs ?? 15 * 60_000;
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const record: BootstrapToken = {
    apiVersion: 'llamactl/v1',
    kind: 'BootstrapToken',
    nodeName: opts.nodeName,
    tokenHash,
    centralUrl: opts.centralUrl.replace(/\/$/, ''),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    used: false,
  };
  const path = writeTokenRecord(record, dir);
  return { token, record, path };
}

export function loadBootstrapToken(path: string): BootstrapToken {
  if (!existsSync(path)) {
    throw new Error(`bootstrap token not found at ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  return BootstrapTokenSchema.parse(parseYaml(raw));
}

export function listBootstrapTokens(dir: string = defaultBootstrapTokensDir()): Array<{
  path: string;
  record: BootstrapToken;
}> {
  if (!existsSync(dir)) return [];
  const out: Array<{ path: string; record: BootstrapToken }> = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.yaml')) continue;
    const path = join(dir, entry);
    try {
      const record = loadBootstrapToken(path);
      out.push({ path, record });
    } catch {
      // Skip malformed files — they'll surface via `llamactl deploy-node
      // --list` if operators want to see them.
    }
  }
  return out;
}

export function findBootstrapTokenByPlaintext(
  token: string,
  dir: string = defaultBootstrapTokensDir(),
): { path: string; record: BootstrapToken } | null {
  const tokenHash = hashToken(token);
  const path = tokenFilePath(tokenHash, dir);
  if (!existsSync(path)) return null;
  try {
    const record = loadBootstrapToken(path);
    if (record.tokenHash !== tokenHash) return null;
    return { path, record };
  } catch {
    return null;
  }
}

export type ConsumeResult =
  | { ok: true; record: BootstrapToken; path: string }
  | { ok: false; reason: 'not-found' | 'expired' | 'already-used' };

export interface ConsumeOptions {
  dir?: string;
  now?: () => Date;
}

/**
 * Find + validate + mark-used atomically for the happy path. Returns a
 * structured error reason on failure so callers surface a useful
 * message to the operator without parsing exception text.
 */
export function consumeBootstrapToken(token: string, opts: ConsumeOptions = {}): ConsumeResult {
  const dir = opts.dir ?? defaultBootstrapTokensDir();
  const now = (opts.now ?? (() => new Date()))();
  const found = findBootstrapTokenByPlaintext(token, dir);
  if (!found) return { ok: false, reason: 'not-found' };
  if (found.record.used) return { ok: false, reason: 'already-used' };
  if (now > new Date(found.record.expiresAt)) return { ok: false, reason: 'expired' };
  const updated: BootstrapToken = {
    ...found.record,
    used: true,
    usedAt: now.toISOString(),
  };
  writeTokenRecord(updated, dir);
  return { ok: true, record: updated, path: found.path };
}

/**
 * Delete expired + used tokens. Housekeeping for operators who
 * regenerate frequently; safe to run from a cron.
 */
export function pruneBootstrapTokens(opts: ConsumeOptions = {}): number {
  const dir = opts.dir ?? defaultBootstrapTokensDir();
  const now = (opts.now ?? (() => new Date()))();
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const { path, record } of listBootstrapTokens(dir)) {
    const expired = now > new Date(record.expiresAt);
    if (record.used || expired) {
      try {
        rmSync(path, { force: true });
        removed++;
      } catch {
        // best-effort
      }
    }
  }
  return removed;
}
