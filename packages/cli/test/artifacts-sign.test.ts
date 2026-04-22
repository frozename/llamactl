import { describe, expect, test } from 'bun:test';
import { mkdtempSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { codesignBinary } from '../src/commands/artifacts.js';

/**
 * Smoke-test the codesign helper used by `artifacts build-agent
 * --sign=<identity>` (and, downstream, the `agent update` push flow).
 *
 * Works on macOS by signing a real binary with the always-present
 * `-` (ad-hoc) identity. The binary itself is just /bin/ls copied
 * into a temp dir — codesign accepts any Mach-O. Skipped cleanly on
 * non-darwin so CI on Linux runners doesn't fail on a missing
 * `codesign` binary.
 */

const isDarwin = platform() === 'darwin';

describe.skipIf(!isDarwin)('codesignBinary (macOS)', () => {
  test('ad-hoc signs a real Mach-O binary, exit 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llamactl-sign-'));
    const target = join(dir, 'fake-binary');
    try {
      copyFileSync('/bin/ls', target);
      expect(existsSync(target)).toBe(true);
      const code = await codesignBinary(target, '-');
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns a non-zero exit when the identity does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llamactl-sign-'));
    const target = join(dir, 'fake-binary');
    try {
      copyFileSync('/bin/ls', target);
      const code = await codesignBinary(
        target,
        'Definitely-Not-A-Real-Signing-Identity-12345',
      );
      // codesign exits non-zero with a clear "no identity found" error;
      // we don't pin the exact code, just that it failed.
      expect(code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
