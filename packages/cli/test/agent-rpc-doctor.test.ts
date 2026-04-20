import { describe, expect, test } from 'bun:test';
import type { rpcServer as rpcServerMod } from '@llamactl/core';
import {
  parseRpcDoctorFlags,
  runRpcDoctor,
  type RpcDoctorDeps,
  type RpcDoctorRemoteClient,
} from '../src/commands/agent-rpc-doctor.js';

/**
 * `llamactl agent rpc-doctor` — local + remote paths, JSON output,
 * flag parsing. Uses the handler's DI surface so no actual fs / tRPC
 * traffic is exercised here; the core doctor helper has its own unit
 * tests covering the underlying fs probe.
 */

interface CapturedOutput {
  stdout: string;
  stderr: string;
}

function baseDeps(
  overrides: Partial<RpcDoctorDeps> & { capture?: CapturedOutput } = {},
): { deps: Partial<RpcDoctorDeps>; captured: CapturedOutput } {
  const captured: CapturedOutput = overrides.capture ?? { stdout: '', stderr: '' };
  const deps: Partial<RpcDoctorDeps> = {
    stdout: (chunk) => {
      captured.stdout += chunk;
    },
    stderr: (chunk) => {
      captured.stderr += chunk;
    },
    // Sensible-but-unreachable defaults so any accidental remote
    // invocation blows up loudly rather than silently hitting disk.
    loadConfig: () => {
      throw new Error('loadConfig not stubbed for this test');
    },
    defaultConfigPath: () => '/unused/kubeconfig',
    createNodeClient: () => {
      throw new Error('createNodeClient not stubbed for this test');
    },
    env: {},
    ...overrides,
  };
  return { deps, captured };
}

describe('parseRpcDoctorFlags', () => {
  test('no args → defaults', () => {
    const r = parseRpcDoctorFlags([]);
    expect(r).toEqual({ json: false });
  });

  test('--json sets json true', () => {
    const r = parseRpcDoctorFlags(['--json']);
    expect(r).toEqual({ json: true });
  });

  test('--node=<name>', () => {
    const r = parseRpcDoctorFlags(['--node=gpu1']);
    expect(r).toEqual({ json: false, node: 'gpu1' });
  });

  test('--node=<name> + --json', () => {
    const r = parseRpcDoctorFlags(['--node=gpu1', '--json']);
    expect(r).toEqual({ json: true, node: 'gpu1' });
  });

  test('unknown flag → error', () => {
    const r = parseRpcDoctorFlags(['--bogus=1']);
    expect('error' in r).toBe(true);
  });

  test('--node with empty value → error', () => {
    const r = parseRpcDoctorFlags(['--node=']);
    expect('error' in r).toBe(true);
  });

  test('bare non-flag arg → error', () => {
    const r = parseRpcDoctorFlags(['positional']);
    expect('error' in r).toBe(true);
  });

  test('--help surfaces the sentinel', () => {
    const r = parseRpcDoctorFlags(['--help']);
    expect(r).toEqual({ error: '__help' });
  });
});

describe('runRpcDoctor (local mode)', () => {
  test('ok → exit 0, stdout has path + LLAMA_CPP_BIN, stderr empty', async () => {
    const { deps, captured } = baseDeps();
    deps.checkLocal = () => ({
      ok: true,
      path: '/opt/llama.cpp/build/bin/rpc-server',
      llamaCppBin: '/opt/llama.cpp/build/bin',
    });
    const code = await runRpcDoctor([], deps);
    expect(code).toBe(0);
    expect(captured.stdout).toContain('ok');
    expect(captured.stdout).toContain('/opt/llama.cpp/build/bin/rpc-server');
    expect(captured.stdout).toContain('LLAMA_CPP_BIN');
    expect(captured.stderr).toBe('');
  });

  test('fail → exit 1, stderr has reason + hint, stdout empty', async () => {
    const { deps, captured } = baseDeps();
    deps.checkLocal = () => ({
      ok: false,
      path: null,
      llamaCppBin: '/opt/llama.cpp/build/bin',
      reason: 'rpc-server-missing',
      hint:
        'rpc-server is built only when llama.cpp is configured with ' +
        '-DGGML_RPC=ON. From your llama.cpp source tree: ' +
        'cmake -B build -DGGML_RPC=ON && cmake --build build --target rpc-server',
    });
    const code = await runRpcDoctor([], deps);
    expect(code).toBe(1);
    expect(captured.stdout).toBe('');
    expect(captured.stderr).toContain('rpc-server not available');
    expect(captured.stderr).toContain('rpc-server-missing');
    expect(captured.stderr).toContain('-DGGML_RPC=ON');
  });

  test('--json on ok → stdout is valid JSON matching shape', async () => {
    const { deps, captured } = baseDeps();
    deps.checkLocal = () => ({
      ok: true,
      path: '/usr/local/bin/rpc-server',
      llamaCppBin: '/usr/local/bin',
    });
    const code = await runRpcDoctor(['--json'], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(captured.stdout.trim()) as rpcServerMod.RpcServerDoctorResult;
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe('/usr/local/bin/rpc-server');
    expect(parsed.llamaCppBin).toBe('/usr/local/bin');
    expect(captured.stderr).toBe('');
  });

  test('--json on fail → exit 1, stdout is the JSON blob', async () => {
    const { deps, captured } = baseDeps();
    deps.checkLocal = () => ({
      ok: false,
      path: null,
      llamaCppBin: null,
      reason: 'LLAMA_CPP_BIN-unset',
      hint: 'set $LLAMA_CPP_BIN to the llama.cpp build/bin directory',
    });
    const code = await runRpcDoctor(['--json'], deps);
    expect(code).toBe(1);
    const parsed = JSON.parse(captured.stdout.trim()) as rpcServerMod.RpcServerDoctorResult;
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('LLAMA_CPP_BIN-unset');
  });

  test('--help → exit 0, usage on stdout, no dispatch fires', async () => {
    const { deps, captured } = baseDeps();
    let localCalls = 0;
    deps.checkLocal = () => {
      localCalls++;
      return { ok: true, path: '/x', llamaCppBin: '/y' };
    };
    const code = await runRpcDoctor(['--help'], deps);
    expect(code).toBe(0);
    expect(localCalls).toBe(0);
    expect(captured.stdout).toContain('rpc-doctor');
  });

  test('unknown flag → exit 1, stderr has the parse error', async () => {
    const { deps, captured } = baseDeps();
    const code = await runRpcDoctor(['--bogus=1'], deps);
    expect(code).toBe(1);
    expect(captured.stderr).toContain('unknown flag');
  });
});

describe('runRpcDoctor (--node remote mode)', () => {
  test('--node=<name> dispatches through createNodeClient, not checkLocal', async () => {
    const { deps, captured } = baseDeps();
    const calls: string[] = [];
    deps.checkLocal = () => {
      throw new Error('checkLocal must not run when --node is set');
    };
    deps.loadConfig = () =>
      ({ apiVersion: 'llamactl/v1' } as unknown as ReturnType<NonNullable<RpcDoctorDeps['loadConfig']>>);
    deps.createNodeClient = (_cfg, opts): RpcDoctorRemoteClient => {
      calls.push(opts.nodeName);
      return {
        rpcServerDoctor: {
          async query() {
            return {
              ok: true,
              path: '/opt/bin/rpc-server',
              llamaCppBin: '/opt/bin',
            };
          },
        },
      };
    };
    const code = await runRpcDoctor(['--node=gpu1'], deps);
    expect(code).toBe(0);
    expect(calls).toEqual(['gpu1']);
    expect(captured.stdout).toContain('/opt/bin/rpc-server');
  });

  test('--node failure on the remote → exit 1, stderr has the node + reason', async () => {
    const { deps, captured } = baseDeps();
    deps.loadConfig = () =>
      ({ apiVersion: 'llamactl/v1' } as unknown as ReturnType<NonNullable<RpcDoctorDeps['loadConfig']>>);
    deps.createNodeClient = (): RpcDoctorRemoteClient => ({
      rpcServerDoctor: {
        async query() {
          return {
            ok: false,
            path: null,
            llamaCppBin: '/data/llama.cpp/build/bin',
            reason: 'rpc-server-missing',
            hint:
              'rpc-server is built only when llama.cpp is configured with ' +
              '-DGGML_RPC=ON. From your llama.cpp source tree: ' +
              'cmake -B build -DGGML_RPC=ON && cmake --build build --target rpc-server',
          };
        },
      },
    });
    const code = await runRpcDoctor(['--node=gpu1'], deps);
    expect(code).toBe(1);
    expect(captured.stderr).toContain('rpc-server-missing');
    expect(captured.stderr).toContain('-DGGML_RPC=ON');
  });

  test('--node when dispatcher throws → exit 1, stderr names the node + error', async () => {
    const { deps, captured } = baseDeps();
    deps.loadConfig = () =>
      ({ apiVersion: 'llamactl/v1' } as unknown as ReturnType<NonNullable<RpcDoctorDeps['loadConfig']>>);
    deps.createNodeClient = (): RpcDoctorRemoteClient => ({
      rpcServerDoctor: {
        async query() {
          throw new Error('connection refused');
        },
      },
    });
    const code = await runRpcDoctor(['--node=gpu1'], deps);
    expect(code).toBe(1);
    expect(captured.stderr).toContain('gpu1');
    expect(captured.stderr).toContain('connection refused');
  });

  test('--node + --json → JSON blob on stdout', async () => {
    const { deps, captured } = baseDeps();
    deps.loadConfig = () =>
      ({ apiVersion: 'llamactl/v1' } as unknown as ReturnType<NonNullable<RpcDoctorDeps['loadConfig']>>);
    deps.createNodeClient = (): RpcDoctorRemoteClient => ({
      rpcServerDoctor: {
        async query() {
          return {
            ok: true,
            path: '/opt/bin/rpc-server',
            llamaCppBin: '/opt/bin',
          };
        },
      },
    });
    const code = await runRpcDoctor(['--node=gpu1', '--json'], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(captured.stdout.trim()) as rpcServerMod.RpcServerDoctorResult;
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe('/opt/bin/rpc-server');
  });
});
