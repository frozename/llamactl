import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from 'node:child_process';
import {
  assemblePlistOptions,
  currentBunTarget,
  parseInstallLaunchdFlags,
  pollLaunchctlHealthy,
  resolveBinary,
  runAgentInstallLaunchd,
  type FsLike,
  type InstallLaunchdDeps,
  type SpawnSyncLike,
} from '../src/commands/agent-install/index.js';

// ------------------------------------------------------------------
// Shared fs-shim helpers. Typed once and reused so each test doesn't
// have to annotate every inline pass-through lambda. The shims wrap
// the real node:fs functions so production code paths reach disk in
// tests where that matters (binary copy + plist write), and no-op
// otherwise.
// ------------------------------------------------------------------

const accessFromDisk: FsLike['accessSync'] = (path, mode) => {
  if (typeof path !== 'string' && !(path instanceof URL)) {
    throw new Error('access shim requires string or URL path');
  }
  const p = typeof path === 'string' ? path : path.pathname;
  if (!existsSync(p)) throw new Error('ENOENT');
  void mode;
};

const writeFileFromDisk: FsLike['writeFileSync'] = (file, data): void => {
  writeFileSync(file as string, data as string | NodeJS.ArrayBufferView);
};

const copyFileThrough: FsLike['copyFileSync'] = (src, dest): void => {
  mkdirSync(join(dest as string, '..'), { recursive: true });
  writeFileSync(dest as string, readFileSync(src as string));
};

/**
 * Tests for Phase 3 of the agent-binary-install-flow plan.
 *
 * Strategy: the handler accepts an InstallLaunchdDeps partial override
 * so every external boundary (child_process, fs, release fetch, local
 * build, stdout/stderr, clock, platform, uid) can be stubbed without
 * touching bun:test's module mocker. Test fixtures live under a fresh
 * mkdtemp so they clean up on teardown.
 */

// -----------------------------------------------------------------------------
// Dependency stubs
// -----------------------------------------------------------------------------

interface SpawnCall {
  command: string;
  args: string[];
}

interface SpawnStubConfig {
  /** Ordered queue of responses; consumed per command+args prefix match. */
  responses?: Array<{
    match: (command: string, args: string[]) => boolean;
    response: SpawnSyncReturns<string>;
  }>;
  /** Fallback response returned when no matcher fires. */
  fallback?: SpawnSyncReturns<string>;
}

function makeSpawnStub(config: SpawnStubConfig): {
  spawn: SpawnSyncLike;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const queued = (config.responses ?? []).slice();
  const fallback: SpawnSyncReturns<string> =
    config.fallback ?? {
      pid: 0,
      output: ['', '', ''],
      stdout: '',
      stderr: '',
      status: 0,
      signal: null,
    };
  const spawn: SpawnSyncLike = (
    command: string,
    args: string[],
    _opts?: SpawnSyncOptionsWithStringEncoding,
  ): SpawnSyncReturns<string> => {
    calls.push({ command, args });
    for (let i = 0; i < queued.length; i++) {
      const entry = queued[i]!;
      if (entry.match(command, args)) {
        queued.splice(i, 1);
        return entry.response;
      }
    }
    return fallback;
  };
  return { spawn, calls };
}

function defaultFs(): FsLike {
  // Pass-through to real fs; individual tests swap pieces via Object.assign.
  return {
    existsSync,
    mkdirSync,
    writeFileSync: (..._args: Parameters<typeof writeFileSync>): void => {
      /* noop in tests that touch the default fs — override when needed */
    },
    readFileSync,
    chmodSync: (..._args: Parameters<typeof chmodSync>): void => {
      /* noop */
    },
    copyFileSync: (..._args: Parameters<FsLike['copyFileSync']>): void => {
      /* noop */
    },
    unlinkSync: (..._args: Parameters<FsLike['unlinkSync']>): void => {
      /* noop */
    },
    statSync,
    accessSync: (..._args: Parameters<FsLike['accessSync']>): void => {
      /* noop — existence + exec treated as satisfied */
    },
  } as unknown as FsLike;

  function statSync(..._args: Parameters<FsLike['statSync']>): ReturnType<FsLike['statSync']> {
    return {
      isFile: () => true,
      isDirectory: () => false,
    } as unknown as ReturnType<FsLike['statSync']>;
  }
}

function makeTestDeps(over: Partial<InstallLaunchdDeps> = {}): {
  deps: InstallLaunchdDeps;
  stdoutChunks: string[];
  stderrChunks: string[];
} {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const defaults: InstallLaunchdDeps = {
    spawnSync: ((_c, _a, _o): SpawnSyncReturns<string> => ({
      pid: 0,
      output: ['', '', ''],
      stdout: '',
      stderr: '',
      status: 0,
      signal: null,
    })) as SpawnSyncLike,
    fs: defaultFs(),
    fetchAgentRelease: async () => ({
      ok: true,
      version: 'v1.2.3',
      target: 'darwin-arm64',
      path: '/tmp/fake-release-binary',
      sha256: 'deadbeef',
      bytes: 0,
      signature: { verified: null, reason: 'skipped' },
    }),
    buildAgentBinary: async () => ({ ok: true, outPath: '/tmp/fake-built-binary', code: 0 }),
    stdout: (c) => {
      stdoutChunks.push(c);
    },
    stderr: (c) => {
      stderrChunks.push(c);
    },
    now: Date.now,
    sleep: async () => {
      /* no-op for speed */
    },
    getuid: () => 501,
    platform: 'darwin',
    env: { HOME: '/Users/tester', USER: 'tester' },
    ...over,
  };
  return {
    deps: { ...defaults, ...over, env: { ...(defaults.env ?? {}), ...(over.env ?? {}) } },
    stdoutChunks,
    stderrChunks,
  };
}

// -----------------------------------------------------------------------------
// Flag parsing
// -----------------------------------------------------------------------------

describe('parseInstallLaunchdFlags', () => {
  test('defaults: scope=user, source=from-source, default install path', () => {
    const parsed = parseInstallLaunchdFlags([]);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.scope).toBe('user');
    expect(parsed.source).toEqual({ kind: 'source' });
    expect(parsed.installPath).toBe('/usr/local/bin/llamactl-agent');
    expect(parsed.dryRun).toBe(false);
    expect(parsed.force).toBe(false);
    expect(parsed.repo).toBe('frozename/llamactl');
  });

  test('--binary=<path> sets source=binary', () => {
    const parsed = parseInstallLaunchdFlags(['--binary=/opt/bin/agent']);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.source).toEqual({ kind: 'binary', path: '/opt/bin/agent' });
  });

  test('--from-release=v0.4.0 sets source=release', () => {
    const parsed = parseInstallLaunchdFlags(['--from-release=v0.4.0']);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.source).toEqual({ kind: 'release', tag: 'v0.4.0' });
  });

  test('mutually exclusive sources rejected', () => {
    const parsed = parseInstallLaunchdFlags([
      '--binary=/tmp/agent',
      '--from-source',
    ]);
    expect('error' in parsed).toBe(true);
    if ('error' in parsed) {
      expect(parsed.error).toContain('mutually exclusive');
    }
  });

  test('--from-release with empty tag rejected', () => {
    const parsed = parseInstallLaunchdFlags(['--from-release=']);
    expect('error' in parsed).toBe(true);
    if ('error' in parsed) {
      expect(parsed.error).toContain('requires a tag');
    }
  });

  test('--env=KEY=VAL parsed into envOverrides; repeatable accumulates', () => {
    const parsed = parseInstallLaunchdFlags([
      '--env=HF_HOME=/foo',
      '--env=DEV_STORAGE=/bar',
    ]);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.envOverrides).toEqual({
      HF_HOME: '/foo',
      DEV_STORAGE: '/bar',
    });
  });

  test('--env without = inside value rejected', () => {
    const parsed = parseInstallLaunchdFlags(['--env=KEY_WITHOUT_VALUE']);
    expect('error' in parsed).toBe(true);
    if ('error' in parsed) {
      expect(parsed.error).toContain('--env must be KEY=VAL');
    }
  });

  test('--dry-run + --force bare flags set booleans', () => {
    const parsed = parseInstallLaunchdFlags(['--dry-run', '--force']);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.force).toBe(true);
  });

  test('--scope must be user|system', () => {
    const parsed = parseInstallLaunchdFlags(['--scope=weird']);
    expect('error' in parsed).toBe(true);
  });

  test('unknown flag rejected', () => {
    const parsed = parseInstallLaunchdFlags(['--weird=foo']);
    expect('error' in parsed).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Platform detection
// -----------------------------------------------------------------------------

describe('currentBunTarget', () => {
  test('darwin/arm64 → darwin-arm64', () => {
    expect(currentBunTarget('darwin', 'arm64')).toBe('darwin-arm64');
  });
  test('linux/x64 → linux-x64', () => {
    expect(currentBunTarget('linux', 'x64')).toBe('linux-x64');
  });
  test('linux/arm64 → linux-arm64', () => {
    expect(currentBunTarget('linux', 'arm64')).toBe('linux-arm64');
  });
  test('win32/x64 → null', () => {
    expect(currentBunTarget('win32', 'x64')).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Binary resolution
// -----------------------------------------------------------------------------

describe('resolveBinary --binary', () => {
  test('existing executable file is copied to installPath', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'install-launchd-'));
    try {
      const src = join(tmpDir, 'source-binary');
      const dest = join(tmpDir, 'dest', 'llamactl-agent');
      writeFileSync(src, '#!/bin/sh\necho ok\n', { mode: 0o755 });
      chmodSync(src, 0o755);

      const { deps } = makeTestDeps({
        // Use real fs but capture copy call
        fs: {
          ...defaultFs(),
          existsSync,
          mkdirSync,
          chmodSync,
          accessSync: accessFromDisk,
          copyFileSync: copyFileThrough,
        } as unknown as FsLike,
      });

      const resolved = await resolveBinary({
        source: { kind: 'binary', path: src },
        installPath: dest,
        scope: 'user',
        repo: 'frozename/llamactl',
        dryRun: false,
        deps,
      });
      expect(resolved).toBe(dest);
      expect(existsSync(dest)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('missing path throws "does not exist"', async () => {
    const { deps } = makeTestDeps({
      fs: {
        ...defaultFs(),
        existsSync: () => false,
      } as unknown as FsLike,
    });
    await expect(
      resolveBinary({
        source: { kind: 'binary', path: '/no/such/binary' },
        installPath: '/tmp/out',
        scope: 'user',
        repo: 'frozename/llamactl',
        dryRun: false,
        deps,
      }),
    ).rejects.toThrow('does not exist');
  });

  test('non-executable file throws "not executable"', async () => {
    const { deps } = makeTestDeps({
      fs: {
        ...defaultFs(),
        existsSync: () => true,
        accessSync: () => {
          throw new Error('EACCES');
        },
      } as unknown as FsLike,
    });
    await expect(
      resolveBinary({
        source: { kind: 'binary', path: '/tmp/not-exec' },
        installPath: '/tmp/out',
        scope: 'user',
        repo: 'frozename/llamactl',
        dryRun: false,
        deps,
      }),
    ).rejects.toThrow('not executable');
  });

  test('--from-release calls fetchAgentRelease with correct target/repo/tag', async () => {
    let capturedArgs:
      | {
          repo: string;
          version: string;
          target: string;
          verifySig: string | undefined;
        }
      | undefined;

    const { deps } = makeTestDeps({
      fs: {
        ...defaultFs(),
        existsSync: () => true,
      } as unknown as FsLike,
      fetchAgentRelease: async (opts) => {
        capturedArgs = {
          repo: opts.repo,
          version: opts.version,
          target: opts.target,
          verifySig: opts.verifySig,
        };
        return {
          ok: true,
          version: opts.version,
          target: opts.target,
          path: '/tmp/fetched-binary',
          sha256: 'abc',
          bytes: 0,
          signature: { verified: null, reason: 'skipped' },
        };
      },
      platform: 'darwin',
    });

    const resolved = await resolveBinary({
      source: { kind: 'release', tag: 'v0.4.0' },
      installPath: '/tmp/install/agent',
      scope: 'user',
      repo: 'frozename/llamactl',
      dryRun: false,
      deps,
    });
    expect(resolved).toBe('/tmp/install/agent');
    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.repo).toBe('frozename/llamactl');
    expect(capturedArgs!.version).toBe('v0.4.0');
    expect(capturedArgs!.verifySig).toBe('best-effort');
  });

  test('--from-source calls buildAgentBinary with detected target', async () => {
    let capturedTarget: string | undefined;
    const { deps } = makeTestDeps({
      fs: {
        ...defaultFs(),
        existsSync: () => true,
      } as unknown as FsLike,
      buildAgentBinary: async (opts) => {
        capturedTarget = opts.target;
        return { ok: true, outPath: '/tmp/built-binary', code: 0 };
      },
      platform: 'darwin',
    });
    const resolved = await resolveBinary({
      source: { kind: 'source' },
      installPath: '/tmp/install/agent',
      scope: 'user',
      repo: 'frozename/llamactl',
      dryRun: false,
      deps,
    });
    expect(resolved).toBe('/tmp/install/agent');
    // currentBunTarget on darwin picks arm64 on apple silicon CI, x64 on intel.
    expect(capturedTarget).toBeDefined();
    expect(['darwin-arm64', 'darwin-x64']).toContain(capturedTarget!);
  });

  test('system scope with privileged path and non-root uid fails fast', async () => {
    const { deps } = makeTestDeps({ getuid: () => 501, platform: 'darwin' });
    await expect(
      resolveBinary({
        source: { kind: 'source' },
        installPath: '/usr/local/bin/llamactl-agent',
        scope: 'system',
        repo: 'frozename/llamactl',
        dryRun: false,
        deps,
      }),
    ).rejects.toThrow(/requires root/);
  });
});

// -----------------------------------------------------------------------------
// Plist assembly
// -----------------------------------------------------------------------------

describe('assemblePlistOptions', () => {
  test('user scope omits user/group/workingDir', () => {
    const opts = assemblePlistOptions({
      label: 'com.llamactl.agent',
      installPath: '/usr/local/bin/llamactl-agent',
      dirArg: '/Users/tester/agent',
      logDir: '/Users/tester/logs',
      env: { PATH: '/bin' },
      scope: 'user',
    });
    expect(opts.user).toBeUndefined();
    expect(opts.group).toBeUndefined();
    expect(opts.workingDir).toBeUndefined();
    expect(opts.args).toEqual(['agent', 'serve', '--dir=/Users/tester/agent']);
  });

  test('system scope populates user/group/workingDir=dirArg', () => {
    const opts = assemblePlistOptions({
      label: 'com.llamactl.agent.daemon',
      installPath: '/usr/local/bin/llamactl-agent',
      dirArg: '/var/lib/llamactl-agent',
      logDir: '/var/log/llamactl',
      env: { PATH: '/bin' },
      scope: 'system',
      user: 'root',
      group: 'wheel',
    });
    expect(opts.user).toBe('root');
    expect(opts.group).toBe('wheel');
    expect(opts.workingDir).toBe('/var/lib/llamactl-agent');
  });
});

// -----------------------------------------------------------------------------
// Polling
// -----------------------------------------------------------------------------

describe('pollLaunchctlHealthy', () => {
  test('state=running + pid > 0 → ok with parsed pid', async () => {
    const stub = makeSpawnStub({
      fallback: {
        pid: 0,
        output: ['', '', ''],
        stdout: 'some = thing\nstate = running\npid = 12345\nother = stuff\n',
        stderr: '',
        status: 0,
        signal: null,
      },
    });
    const { deps } = makeTestDeps({ spawnSync: stub.spawn });
    const res = await pollLaunchctlHealthy('com.llamactl.agent', 'user', deps, 200, 10);
    expect(res.ok).toBe(true);
    expect(res.pid).toBe(12345);
  });

  test('persistent "state = spawn scheduled" times out', async () => {
    const stub = makeSpawnStub({
      fallback: {
        pid: 0,
        output: ['', '', ''],
        stdout: 'state = spawn scheduled\npid = 0\n',
        stderr: '',
        status: 0,
        signal: null,
      },
    });
    let counter = 0;
    const { deps } = makeTestDeps({
      spawnSync: stub.spawn,
      // Synthetic clock ticks 50ms per call so we deterministically blow
      // through a 200ms "timeout" in a handful of iterations.
      now: (): number => {
        counter += 50;
        return counter;
      },
    });
    const res = await pollLaunchctlHealthy('com.llamactl.agent', 'user', deps, 200, 10);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('timeout');
  });
});

// -----------------------------------------------------------------------------
// End-to-end handler (success, dry-run, overwrite, launchctl failure)
// -----------------------------------------------------------------------------

describe('runAgentInstallLaunchd', () => {
  test('--dry-run prints plist and does not touch disk or launchctl', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'install-launchd-dryrun-'));
    try {
      const binary = join(tmpDir, 'agent-bin');
      writeFileSync(binary, '#!/bin/sh\necho ok\n', { mode: 0o755 });
      chmodSync(binary, 0o755);

      let wroteCount = 0;
      const stub = makeSpawnStub({});

      const { deps, stdoutChunks } = makeTestDeps({
        spawnSync: stub.spawn,
        fs: {
          ...defaultFs(),
          existsSync,
          mkdirSync,
          chmodSync,
          accessSync: accessFromDisk,
          writeFileSync: () => {
            wroteCount++;
          },
          copyFileSync: () => {
            wroteCount++;
          },
        } as unknown as FsLike,
      });

      const code = await runAgentInstallLaunchd(
        ['--dry-run', `--binary=${binary}`, `--install-path=${join(tmpDir, 'out')}`],
        deps,
      );
      expect(code).toBe(0);
      expect(wroteCount).toBe(0);
      expect(stub.calls.length).toBe(0);
      const joinedStdout = stdoutChunks.join('');
      expect(joinedStdout).toContain('<?xml version="1.0"');
      expect(joinedStdout).toContain('com.llamactl.agent');
      expect(joinedStdout).toContain('launchctl');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('overwrite protection: existing plist without --force → exit 1', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'install-launchd-overwrite-'));
    try {
      const binary = join(tmpDir, 'agent-bin');
      writeFileSync(binary, '#!/bin/sh\necho ok\n', { mode: 0o755 });
      chmodSync(binary, 0o755);
      const home = tmpDir; // plist goes under $HOME/Library/LaunchAgents
      const laDir = join(home, 'Library', 'LaunchAgents');
      mkdirSync(laDir, { recursive: true });
      const existing = join(laDir, 'com.llamactl.agent.plist');
      writeFileSync(existing, '<!-- existing -->');

      const stub = makeSpawnStub({});
      const { deps, stderrChunks } = makeTestDeps({
        spawnSync: stub.spawn,
        env: { HOME: home, USER: 'tester' },
        fs: {
          ...defaultFs(),
          existsSync,
          mkdirSync,
          chmodSync,
          accessSync: accessFromDisk,
          writeFileSync: () => {
            throw new Error('should not be called when overwrite blocked');
          },
          copyFileSync: copyFileThrough,
        } as unknown as FsLike,
      });

      const code = await runAgentInstallLaunchd(
        [`--binary=${binary}`, `--install-path=${join(tmpDir, 'agent-installed')}`],
        deps,
      );
      expect(code).toBe(1);
      expect(stderrChunks.join('')).toContain('already exists');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('launchctl load failure surfaces stderr output', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'install-launchd-loadfail-'));
    try {
      const binary = join(tmpDir, 'agent-bin');
      writeFileSync(binary, '#!/bin/sh\necho ok\n', { mode: 0o755 });
      chmodSync(binary, 0o755);
      const home = tmpDir;

      const stub = makeSpawnStub({
        responses: [
          {
            // plutil -lint → success
            match: (c, a) => c === 'plutil' && a[0] === '-lint',
            response: {
              pid: 0,
              output: ['OK\n', '', ''],
              stdout: 'OK\n',
              stderr: '',
              status: 0,
              signal: null,
            },
          },
          {
            // launchctl unload → irrelevant
            match: (c, a) => c === 'launchctl' && a[0] === 'unload',
            response: {
              pid: 0,
              output: ['', '', ''],
              stdout: '',
              stderr: '',
              status: 0,
              signal: null,
            },
          },
          {
            // launchctl load → fail
            match: (c, a) => c === 'launchctl' && a[0] === 'load',
            response: {
              pid: 0,
              output: ['', 'Load failed: 5: Input/output error\n', ''],
              stdout: '',
              stderr: 'Load failed: 5: Input/output error\n',
              status: 1,
              signal: null,
            },
          },
        ],
      });

      const { deps, stderrChunks } = makeTestDeps({
        spawnSync: stub.spawn,
        env: { HOME: home, USER: 'tester' },
        fs: {
          ...defaultFs(),
          existsSync,
          mkdirSync,
          chmodSync,
          accessSync: accessFromDisk,
          writeFileSync: writeFileFromDisk,
          copyFileSync: copyFileThrough,
        } as unknown as FsLike,
      });

      const code = await runAgentInstallLaunchd(
        [`--binary=${binary}`, `--install-path=${join(tmpDir, 'agent-installed')}`],
        deps,
      );
      expect(code).toBe(1);
      expect(stderrChunks.join('')).toContain('launchctl load failed');
      expect(stderrChunks.join('')).toContain('Load failed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('system scope without root → exit 1 with sudo message', async () => {
    const { deps, stderrChunks } = makeTestDeps({
      getuid: () => 501,
      platform: 'darwin',
    });
    const code = await runAgentInstallLaunchd(
      ['--scope=system', '--from-source'],
      deps,
    );
    expect(code).toBe(1);
    expect(stderrChunks.join('')).toContain('--scope=system requires root');
  });

  test('success path: poll returns pid → summary printed with FDA reminder', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'install-launchd-success-'));
    try {
      const binary = join(tmpDir, 'agent-bin');
      writeFileSync(binary, '#!/bin/sh\necho ok\n', { mode: 0o755 });
      chmodSync(binary, 0o755);
      const home = tmpDir;
      const logDir = join(home, '.llamactl-launchd-logs');

      const stub = makeSpawnStub({
        responses: [
          {
            match: (c, a) => c === 'plutil' && a[0] === '-lint',
            response: {
              pid: 0,
              output: ['OK\n', '', ''],
              stdout: 'OK\n',
              stderr: '',
              status: 0,
              signal: null,
            },
          },
          {
            match: (c, a) => c === 'launchctl' && a[0] === 'unload',
            response: {
              pid: 0,
              output: ['', '', ''],
              stdout: '',
              stderr: '',
              status: 0,
              signal: null,
            },
          },
          {
            match: (c, a) => c === 'launchctl' && a[0] === 'load',
            response: {
              pid: 0,
              output: ['', '', ''],
              stdout: '',
              stderr: '',
              status: 0,
              signal: null,
            },
          },
        ],
        // Every launchctl print fallback returns a healthy service.
        fallback: {
          pid: 0,
          output: ['', '', ''],
          stdout: 'state = running\npid = 99999\n',
          stderr: '',
          status: 0,
          signal: null,
        },
      });

      const { deps, stdoutChunks } = makeTestDeps({
        spawnSync: stub.spawn,
        env: { HOME: home, USER: 'tester' },
        fs: {
          ...defaultFs(),
          existsSync,
          mkdirSync,
          chmodSync,
          accessSync: accessFromDisk,
          writeFileSync: writeFileFromDisk,
          copyFileSync: copyFileThrough,
          unlinkSync: () => {
            /* not expected on success */
          },
        } as unknown as FsLike,
      });

      const code = await runAgentInstallLaunchd(
        [`--binary=${binary}`, `--install-path=${join(tmpDir, 'agent-installed')}`, `--log-dir=${logDir}`],
        deps,
      );
      const stdout = stdoutChunks.join('');
      expect(code).toBe(0);
      expect(stdout).toContain('Installed:');
      expect(stdout).toContain('com.llamactl.agent');
      expect(stdout).toContain('pid:        99999');
      expect(stdout).toContain('Full Disk Access');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('polling failure reads stderr.log and includes contents in error', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'install-launchd-pollfail-'));
    try {
      const binary = join(tmpDir, 'agent-bin');
      writeFileSync(binary, '#!/bin/sh\necho ok\n', { mode: 0o755 });
      chmodSync(binary, 0o755);
      const home = tmpDir;
      const logDir = join(home, '.llamactl-launchd-logs');
      mkdirSync(logDir, { recursive: true });
      writeFileSync(
        join(logDir, 'stderr.log'),
        'FATAL: port 7843 already in use\nexiting\n',
      );

      const stub = makeSpawnStub({
        responses: [
          {
            match: (c, a) => c === 'plutil' && a[0] === '-lint',
            response: {
              pid: 0,
              output: ['OK\n', '', ''],
              stdout: 'OK\n',
              stderr: '',
              status: 0,
              signal: null,
            },
          },
          {
            match: (c, a) => c === 'launchctl' && a[0] === 'unload',
            response: {
              pid: 0,
              output: ['', '', ''],
              stdout: '',
              stderr: '',
              status: 0,
              signal: null,
            },
          },
          {
            match: (c, a) => c === 'launchctl' && a[0] === 'load',
            response: {
              pid: 0,
              output: ['', '', ''],
              stdout: '',
              stderr: '',
              status: 0,
              signal: null,
            },
          },
        ],
        // launchctl print always reports spawn scheduled.
        fallback: {
          pid: 0,
          output: ['', '', ''],
          stdout: 'state = spawn scheduled\npid = 0\n',
          stderr: '',
          status: 0,
          signal: null,
        },
      });

      let ticks = 0;
      const { deps, stderrChunks } = makeTestDeps({
        spawnSync: stub.spawn,
        env: { HOME: home, USER: 'tester' },
        now: () => {
          ticks += 200;
          return ticks;
        },
        fs: {
          ...defaultFs(),
          existsSync,
          mkdirSync,
          chmodSync,
          readFileSync,
          accessSync: accessFromDisk,
          writeFileSync: writeFileFromDisk,
          copyFileSync: copyFileThrough,
        } as unknown as FsLike,
      });

      const code = await runAgentInstallLaunchd(
        [`--binary=${binary}`, `--install-path=${join(tmpDir, 'agent-installed')}`, `--log-dir=${logDir}`],
        deps,
      );
      expect(code).toBe(1);
      const stderr = stderrChunks.join('');
      expect(stderr).toContain('did not become healthy');
      expect(stderr).toContain('FATAL: port 7843 already in use');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
