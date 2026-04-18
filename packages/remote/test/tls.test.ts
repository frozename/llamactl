import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeFingerprint,
  fingerprintsEqual,
  generateSelfSignedCert,
  loadCert,
} from '../src/server/tls.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llamactl-tls-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('tls', () => {
  test('generateSelfSignedCert writes cert+key and returns fingerprint', async () => {
    const result = await generateSelfSignedCert({ dir, commonName: 'llamactl-agent' });
    expect(result.certPath.endsWith('agent.crt')).toBe(true);
    expect(result.keyPath.endsWith('agent.key')).toBe(true);
    const certOnDisk = readFileSync(result.certPath, 'utf8');
    expect(certOnDisk.includes('BEGIN CERTIFICATE')).toBe(true);
    const keyOnDisk = readFileSync(result.keyPath, 'utf8');
    expect(keyOnDisk.includes('PRIVATE KEY')).toBe(true);
    expect(result.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.fingerprint).toBe(computeFingerprint(certOnDisk));
  });

  test('loadCert reads what generateSelfSignedCert wrote', async () => {
    const { certPath, keyPath, fingerprint } = await generateSelfSignedCert({
      dir, commonName: 'x',
    });
    const loaded = loadCert({ certPath, keyPath });
    expect(loaded.fingerprint).toBe(fingerprint);
    expect(loaded.certPem.includes('BEGIN CERTIFICATE')).toBe(true);
    expect(loaded.keyPem.includes('PRIVATE KEY')).toBe(true);
  });

  test('two freshly generated certs have distinct fingerprints', async () => {
    const a = await generateSelfSignedCert({ dir: join(dir, 'a'), commonName: 'a' });
    const b = await generateSelfSignedCert({ dir: join(dir, 'b'), commonName: 'b' });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  test('fingerprintsEqual constant-time compares', async () => {
    const { fingerprint } = await generateSelfSignedCert({ dir, commonName: 'x' });
    expect(fingerprintsEqual(fingerprint, fingerprint)).toBe(true);
    const mutated = fingerprint.slice(0, -1) + (fingerprint.endsWith('0') ? '1' : '0');
    expect(fingerprintsEqual(fingerprint, mutated)).toBe(false);
  });

  test('computeFingerprint rejects non-PEM input', () => {
    expect(() => computeFingerprint('hello')).toThrow(/not a valid cert PEM/);
  });

  test('loadCert throws when files missing', () => {
    expect(() => loadCert({ certPath: join(dir, 'nope.crt'), keyPath: join(dir, 'nope.key') }))
      .toThrow(/cert not found/);
  });
});
