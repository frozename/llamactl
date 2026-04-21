import { describe, expect, test } from 'bun:test';
import {
  runDoctor,
  type CheckResult,
  type DoctorDeps,
} from '../src/commands/doctor.js';

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

describe('doctor --skip=<system> suppresses the named probe', () => {
  test('--skip=kubernetes omits the [kubernetes] line entirely', async () => {
    const { out } = await captureStdout(() =>
      runDoctor(['--skip=kubernetes', '--timeout=2']),
    );
    expect(out).not.toContain('[kubernetes]');
    // Other systems still run.
    expect(out).toContain('[agent]');
    expect(out).toContain('[docker]');
  });

  test('--skip=k8s alias works the same', async () => {
    const { out } = await captureStdout(() =>
      runDoctor(['--skip=k8s', '--timeout=2']),
    );
    expect(out).not.toContain('[kubernetes]');
  });

  test('multiple --skip flags stack', async () => {
    const { out } = await captureStdout(() =>
      runDoctor([
        '--skip=kubernetes',
        '--skip=docker',
        '--skip=secrets',
        '--timeout=2',
      ]),
    );
    expect(out).not.toContain('[kubernetes]');
    expect(out).not.toContain('[docker]');
    expect(out).not.toContain('[secrets]');
    expect(out).toContain('[agent]');
  });
});

describe('doctor probes (via injected deps)', () => {
  function stubDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
    return {
      checkAgent: async () => [
        { system: 'agent', status: 'ok', message: 'stub agent ok' },
      ],
      checkDocker: async () => [
        { system: 'docker', status: 'ok', message: 'stub docker ok' },
      ],
      checkKubernetes: async () => [
        { system: 'kubernetes', status: 'ok', message: 'stub k8s ok' },
      ],
      checkSecrets: () => [
        { system: 'secrets', status: 'ok', message: 'stub secrets ok' },
      ],
      ...overrides,
    };
  }

  test('all ok → exit 0 + summary reads "all clear"', async () => {
    const { result, out } = await captureStdout(() =>
      runDoctor([], stubDeps()),
    );
    expect(result).toBe(0);
    expect(out).toContain('all clear');
    expect(out).toContain('stub agent ok');
    expect(out).toContain('stub docker ok');
    expect(out).toContain('stub k8s ok');
    expect(out).toContain('stub secrets ok');
  });

  test('one warn flips exit to 1 + surfaces the fix hint', async () => {
    const { result, out } = await captureStdout(() =>
      runDoctor(
        [],
        stubDeps({
          checkDocker: async () => [
            {
              system: 'docker',
              status: 'warn',
              message: 'daemon not reachable',
              fix: 'start Docker Desktop',
            },
          ],
        }),
      ),
    );
    expect(result).toBe(1);
    expect(out).toContain('⚠ daemon not reachable');
    expect(out).toContain('↳ start Docker Desktop');
    expect(out).toContain('1 warn');
  });

  test('fail + warn tally reported in the summary', async () => {
    const { result, out } = await captureStdout(() =>
      runDoctor(
        [],
        stubDeps({
          checkAgent: async () => [
            { system: 'agent', status: 'fail', message: 'probe blew up' },
          ],
          checkKubernetes: async () => [
            {
              system: 'kubernetes',
              status: 'warn',
              message: 'RBAC probe failed',
            },
          ],
        }),
      ),
    );
    expect(result).toBe(1);
    expect(out).toContain('1 fail, 1 warn');
    expect(out).toContain('✗ probe blew up');
    expect(out).toContain('⚠ RBAC probe failed');
  });

  test('probe that throws surfaces as fail with the error message', async () => {
    const { result, out } = await captureStdout(() =>
      runDoctor(
        [],
        stubDeps({
          checkDocker: async () => {
            throw new Error('unexpected crash');
          },
        }),
      ),
    );
    expect(result).toBe(1);
    expect(out).toContain('[docker]');
    expect(out).toContain('unexpected crash');
  });

  test('info status does NOT flip exit to 1', async () => {
    const { result } = await captureStdout(() =>
      runDoctor(
        [],
        stubDeps({
          checkSecrets: () => [
            {
              system: 'secrets',
              status: 'info',
              message: 'not on darwin',
            },
          ],
        }),
      ),
    );
    expect(result).toBe(0);
  });

  test('--verbose surfaces fix hints even under ✓ rows', async () => {
    const { out } = await captureStdout(() =>
      runDoctor(
        ['--verbose'],
        stubDeps({
          checkAgent: async () => [
            {
              system: 'agent',
              status: 'ok',
              message: 'ok',
              fix: 'nothing to do',
            },
          ],
        }),
      ),
    );
    expect(out).toContain('↳ nothing to do');
  });

  test('probe returning multiple results all land in the output', async () => {
    const multi: CheckResult[] = [
      { system: 'kubernetes', status: 'ok', message: 'cluster reachable' },
      { system: 'kubernetes', status: 'ok', message: 'RBAC probe passed' },
      { system: 'kubernetes', status: 'info', message: '2 labelled nodes' },
    ];
    const { result, out } = await captureStdout(() =>
      runDoctor(
        [],
        stubDeps({
          checkKubernetes: async () => multi,
        }),
      ),
    );
    expect(result).toBe(0);
    for (const r of multi) {
      expect(out).toContain(r.message);
    }
  });
});
