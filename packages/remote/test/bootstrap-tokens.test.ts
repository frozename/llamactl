import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  consumeBootstrapToken,
  findBootstrapTokenByPlaintext,
  generateBootstrapToken,
  listBootstrapTokens,
  loadBootstrapToken,
  pruneBootstrapTokens,
} from '../src/config/bootstrap-tokens.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llamactl-bootstrap-tokens-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('generateBootstrapToken', () => {
  test('produces a random token + a stored record keyed by hash', () => {
    const { token, record, path } = generateBootstrapToken({
      nodeName: 'gpu1',
      centralUrl: 'https://control.lan:7843',
      dir,
    });
    // The plaintext is reasonably long + base64url-shaped.
    expect(token.length).toBeGreaterThan(40);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // Record carries the hash, not the plaintext.
    expect(record.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.tokenHash).not.toContain(token);
    expect(record.used).toBe(false);
    expect(record.nodeName).toBe('gpu1');
    // File lives where listBootstrapTokens will find it.
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, 'utf8');
    expect(body).toContain('kind: BootstrapToken');
    expect(body).not.toContain(token);
  });

  test('two generations produce independent tokens + files', () => {
    const a = generateBootstrapToken({
      nodeName: 'a',
      centralUrl: 'https://c.lan',
      dir,
    });
    const b = generateBootstrapToken({
      nodeName: 'b',
      centralUrl: 'https://c.lan',
      dir,
    });
    expect(a.token).not.toBe(b.token);
    expect(a.path).not.toBe(b.path);
    expect(listBootstrapTokens(dir)).toHaveLength(2);
  });

  test('strips trailing slash from centralUrl', () => {
    const { record } = generateBootstrapToken({
      nodeName: 'n',
      centralUrl: 'https://c.lan:7843/',
      dir,
    });
    expect(record.centralUrl).toBe('https://c.lan:7843');
  });

  test('ttlMs honored in expiresAt', () => {
    const fixedNow = new Date('2026-04-18T12:00:00Z');
    const { record } = generateBootstrapToken({
      nodeName: 'n',
      centralUrl: 'https://c.lan',
      ttlMs: 60_000,
      dir,
      now: () => fixedNow,
    });
    expect(record.createdAt).toBe('2026-04-18T12:00:00.000Z');
    expect(record.expiresAt).toBe('2026-04-18T12:01:00.000Z');
  });

  test('token file is mode 0600 (operator-only readable)', () => {
    const { path } = generateBootstrapToken({
      nodeName: 'n',
      centralUrl: 'https://c.lan',
      dir,
    });
    const mode = statSync(path).mode & 0o777;
    // chmod is best-effort; on POSIX test runners it should land 0600.
    expect(mode).toBe(0o600);
  });
});

describe('findBootstrapTokenByPlaintext', () => {
  test('matches by plaintext, returns the record', () => {
    const { token, record } = generateBootstrapToken({
      nodeName: 'gpu1',
      centralUrl: 'https://c.lan',
      dir,
    });
    const found = findBootstrapTokenByPlaintext(token, dir);
    expect(found).not.toBeNull();
    expect(found!.record.nodeName).toBe('gpu1');
    expect(found!.record.tokenHash).toBe(record.tokenHash);
  });

  test('returns null for unknown tokens', () => {
    generateBootstrapToken({ nodeName: 'n', centralUrl: 'https://c.lan', dir });
    expect(findBootstrapTokenByPlaintext('bogus-token-value', dir)).toBeNull();
  });
});

describe('consumeBootstrapToken', () => {
  test('happy path: not-used + not-expired → marks used + returns record', () => {
    const { token, record } = generateBootstrapToken({
      nodeName: 'gpu1',
      centralUrl: 'https://c.lan',
      dir,
    });
    const result = consumeBootstrapToken(token, { dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.used).toBe(true);
      expect(result.record.usedAt).toBeTruthy();
      expect(result.record.nodeName).toBe('gpu1');
      // Persisted: reload from disk and verify used=true survived.
      const reloaded = loadBootstrapToken(result.path);
      expect(reloaded.used).toBe(true);
      // Hash didn't change.
      expect(reloaded.tokenHash).toBe(record.tokenHash);
    }
  });

  test('second consume rejects with already-used', () => {
    const { token } = generateBootstrapToken({
      nodeName: 'n',
      centralUrl: 'https://c.lan',
      dir,
    });
    const first = consumeBootstrapToken(token, { dir });
    expect(first.ok).toBe(true);
    const second = consumeBootstrapToken(token, { dir });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('already-used');
    }
  });

  test('expired tokens reject with expired', () => {
    // TTL 1 ms + a "now" that's in the future.
    const fixedNow = new Date('2026-04-18T12:00:00Z');
    const { token } = generateBootstrapToken({
      nodeName: 'n',
      centralUrl: 'https://c.lan',
      ttlMs: 1,
      dir,
      now: () => fixedNow,
    });
    const later = new Date('2026-04-18T12:05:00Z');
    const result = consumeBootstrapToken(token, { dir, now: () => later });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('expired');
    }
  });

  test('unknown token rejects with not-found', () => {
    generateBootstrapToken({ nodeName: 'n', centralUrl: 'https://c.lan', dir });
    const result = consumeBootstrapToken('nope', { dir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not-found');
    }
  });
});

describe('pruneBootstrapTokens', () => {
  test('removes used + expired tokens; keeps fresh ones', () => {
    const fixedNow = new Date('2026-04-18T12:00:00Z');
    const fresh = generateBootstrapToken({
      nodeName: 'fresh',
      centralUrl: 'https://c.lan',
      ttlMs: 60 * 60_000,
      dir,
      now: () => fixedNow,
    });
    const expired = generateBootstrapToken({
      nodeName: 'expired',
      centralUrl: 'https://c.lan',
      ttlMs: 1,
      dir,
      now: () => fixedNow,
    });
    const used = generateBootstrapToken({
      nodeName: 'used',
      centralUrl: 'https://c.lan',
      ttlMs: 60 * 60_000,
      dir,
      now: () => fixedNow,
    });
    // Consume one.
    consumeBootstrapToken(used.token, { dir, now: () => fixedNow });

    const later = new Date('2026-04-18T12:10:00Z');
    const removed = pruneBootstrapTokens({ dir, now: () => later });
    expect(removed).toBe(2);
    expect(existsSync(fresh.path)).toBe(true);
    expect(existsSync(expired.path)).toBe(false);
    expect(existsSync(used.path)).toBe(false);
  });

  test('empty dir returns 0', () => {
    expect(pruneBootstrapTokens({ dir })).toBe(0);
  });
});
