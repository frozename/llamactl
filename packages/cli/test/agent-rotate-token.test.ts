import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgent } from '../src/commands/agent.js';

let tmp = '';
const originalEnv = { ...process.env };

let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;
let stdoutBuf = '';

function captureStdout(): void {
  stdoutBuf = '';
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((_chunk: string | Uint8Array) => true) as typeof process.stderr.write;
}

function restore(): void {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'rotate-token-'));
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

describe('agent rotate-token', () => {
  test('rotates tokenHash, preserves cert/key/fingerprint, emits a fresh bootstrap blob', async () => {
    captureStdout();
    let initRecord: { fingerprint: string; blob: string };
    let rotatedRecord: { fingerprint: string; blob: string };
    try {
      // 1. seed an agent via runInit so we have real cert + agent.yaml
      const code1 = await runAgent(['init', `--dir=${tmp}`, '--host=127.0.0.1', '--port=7843', '--json']);
      expect(code1).toBe(0);
      initRecord = JSON.parse(stdoutBuf.trim().split('\n').pop()!) as {
        fingerprint: string;
        blob: string;
      };
      stdoutBuf = '';

      // capture pre-rotation state
      const yamlBefore = readFileSync(join(tmp, 'agent.yaml'), 'utf8');
      const certStatBefore = statSync(join(tmp, 'agent.crt'));
      const keyStatBefore = statSync(join(tmp, 'agent.key'));

      // 2. rotate
      const code2 = await runAgent(['rotate-token', `--dir=${tmp}`, '--host=127.0.0.1', '--json']);
      expect(code2).toBe(0);
      rotatedRecord = JSON.parse(stdoutBuf.trim().split('\n').pop()!) as {
        fingerprint: string;
        blob: string;
      };

      // 3. agent.yaml's tokenHash changed, but everything else stayed
      const yamlAfter = readFileSync(join(tmp, 'agent.yaml'), 'utf8');
      expect(yamlAfter).not.toBe(yamlBefore);
      const beforeHash = /tokenHash:\s*(\S+)/.exec(yamlBefore)?.[1];
      const afterHash = /tokenHash:\s*(\S+)/.exec(yamlAfter)?.[1];
      expect(beforeHash).toBeTruthy();
      expect(afterHash).toBeTruthy();
      expect(afterHash).not.toBe(beforeHash);

      // fingerprint preserved between init and rotate
      expect(rotatedRecord.fingerprint).toBe(initRecord.fingerprint);

      // cert + key files unchanged (mtime + content hash)
      const certStatAfter = statSync(join(tmp, 'agent.crt'));
      const keyStatAfter = statSync(join(tmp, 'agent.key'));
      expect(certStatAfter.mtimeMs).toBe(certStatBefore.mtimeMs);
      expect(keyStatAfter.mtimeMs).toBe(keyStatBefore.mtimeMs);

      // 4. blob decodes to a different token but the same fingerprint + cert
      const decode = (b: string): { token: string; fingerprint: string; certificate: string } =>
        JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
      const initBlob = decode(initRecord.blob);
      const rotatedBlob = decode(rotatedRecord.blob);
      expect(rotatedBlob.token).not.toBe(initBlob.token);
      expect(rotatedBlob.fingerprint).toBe(initBlob.fingerprint);
      expect(rotatedBlob.certificate).toBe(initBlob.certificate);
    } finally {
      restore();
    }
  });

  test('errors with exit code 1 when agent.yaml is missing', async () => {
    captureStdout();
    try {
      const empty = mkdtempSync(join(tmpdir(), 'rotate-token-empty-'));
      try {
        const code = await runAgent(['rotate-token', `--dir=${empty}`]);
        expect(code).toBe(1);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      restore();
    }
  });

  test('rejects unknown flags', async () => {
    captureStdout();
    try {
      const code = await runAgent(['rotate-token', '--unknown=1']);
      expect(code).toBe(1);
    } finally {
      restore();
    }
  });
});
