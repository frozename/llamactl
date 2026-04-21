import { describe, expect, test } from 'bun:test';
import { runDoctor } from '../src/commands/doctor.js';

/**
 * `llamactl doctor` smoke tests. The probes hit real-ish surfaces
 * (docker socket / kubeconfig / filesystem) which we can't cleanly
 * fake without a DI refactor. What we assert:
 *
 *   - `--help` short-circuits at exit 0 without running probes.
 *   - The command returns a stable 0/1 exit without throwing, even
 *     when every subsystem is absent.
 *   - Output is written to stdout (captured here via a stream
 *     monkeypatch) rather than printed into stderr / silently
 *     swallowed.
 */

function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (s: string | Uint8Array): boolean => {
    chunks.push(typeof s === 'string' ? s : String(s));
    return true;
  };
  return fn()
    .then((result) => ({ result, out: chunks.join('') }))
    .finally(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = original;
    });
}

describe('doctor --help', () => {
  test('prints USAGE and returns 0', async () => {
    const { result, out } = await captureStdout(() => runDoctor(['--help']));
    expect(result).toBe(0);
    expect(out).toContain('llamactl doctor');
    expect(out).toContain('[docker]');
    expect(out).toContain('[kubernetes]');
  });

  test('-h short form works too', async () => {
    const { result } = await captureStdout(() => runDoctor(['-h']));
    expect(result).toBe(0);
  });
});

describe('doctor --timeout', () => {
  test('parses --timeout=<seconds> without throwing', async () => {
    // Tiny timeout so we don't hang waiting for a real cluster.
    // The probes will time out internally + surface as fail/warn.
    const { result } = await captureStdout(() =>
      runDoctor(['--timeout=1']),
    );
    // Exit code is 0 or 1 depending on whether the host has docker
    // running. We only care that we got a number back, not a throw.
    expect(typeof result).toBe('number');
    expect(result === 0 || result === 1).toBe(true);
  });
});

describe('doctor output format', () => {
  test('always prints a summary line at the end', async () => {
    const { out } = await captureStdout(() => runDoctor(['--timeout=2']));
    // Summary line lives past every probe's output.
    expect(out).toMatch(/check(s)? —/);
  });

  test('probes are namespaced with [system] prefix', async () => {
    const { out } = await captureStdout(() => runDoctor(['--timeout=2']));
    expect(out).toContain('[agent]');
    expect(out).toContain('[secrets]');
  });
});
