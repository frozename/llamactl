import { describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINES } from '../../../core/src/engines/index.js';
import { startModelHost, stopModelHost, statusModelHost } from '../../src/server/modelhost.js';

function makeManifest(tmp: string) {
  const workloadsDir = join(tmp, 'workloads');
  const runtimeDir = join(tmp, 'runtime');
  const fakeBinary = join(tmp, 'omlx');
  mkdirSync(workloadsDir, { recursive: true });
  writeFileSync(fakeBinary, '#!/bin/sh\nexit 0\n');
  const manifest = {
    apiVersion: 'llamactl/v1',
    kind: 'ModelHost',
    metadata: { name: 'mlx-host-server' },
    spec: {
      engine: 'omlx',
      node: 'local',
      enabled: true,
      binary: fakeBinary,
      endpoint: { host: '127.0.0.1', port: 8094 },
      hostedModels: [{ rel: 'mlx-community/Qwen3-8B-MLX-4bit' }],
      extraArgs: ['--max-concurrent-requests', '1'],
      restartPolicy: 'Always',
      timeoutSeconds: 60,
    },
  } as const;
  writeFileSync(join(workloadsDir, 'mlx-host-server.yaml'), `apiVersion: llamactl/v1\nkind: ModelHost\nmetadata:\n  name: mlx-host-server\nspec:\n  engine: omlx\n  node: local\n  enabled: true\n  binary: ${fakeBinary}\n  endpoint:\n    host: 127.0.0.1\n    port: 8094\n  hostedModels:\n    - rel: mlx-community/Qwen3-8B-MLX-4bit\n  extraArgs:\n    - --max-concurrent-requests\n    - '1'\n  restartPolicy: Always\n  timeoutSeconds: 60\n`);
  return { manifest, workloadsDir, runtimeDir };
}

describe('server/modelhost', () => {
  test('keeps the manifest binary as source of truth', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-binary-'));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const spawn = mock(() => ({ pid: 4321 } as const));
    try {
      const result = await startModelHost({
        key: { name: 'mlx-host-server' },
        workloadsDir,
        runtimeDir,
        spawn,
        probeReady: async () => ({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      const [binary] = spawn.mock.calls[0]!;
      expect(binary).toBe(join(tmp, 'omlx'));
      expect(binary).not.toBe('/tmp/evil.sh');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('keeps the manifest endpoint as source of truth', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-endpoint-'));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const spawn = mock(() => ({ pid: 4321 } as const));
    try {
      const result = await startModelHost({
        key: { name: 'mlx-host-server' },
        workloadsDir,
        runtimeDir,
        spawn,
        probeReady: async () => ({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(result.pid).toBe(4321);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('calls prepareLaunch before buildBootCommand on the start path', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-prepare-'));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const order: string[] = [];
    const engine = ENGINES.omlx;
    const originalPrepareLaunch = engine.prepareLaunch;
    const originalBuildBootCommand = engine.buildBootCommand;
    const prepareLaunch = mock(async () => {
      order.push('prepareLaunch');
    });
    const buildBootCommand = mock((spec: Parameters<typeof engine.buildBootCommand>[0], env) => {
      order.push(`buildBootCommand:${spec.binary}`);
      return originalBuildBootCommand(spec, env);
    });
    const spawn = mock(() => ({ pid: 4321 } as const));
    try {
      engine.prepareLaunch = prepareLaunch;
      engine.buildBootCommand = buildBootCommand;
      const result = await startModelHost({
        key: { name: 'mlx-host-server' },
        workloadsDir,
        runtimeDir,
        spawn,
        probeReady: async () => ({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(order[0]).toBe('prepareLaunch');
      expect(order[1]).toContain('buildBootCommand');
      expect(buildBootCommand).toHaveBeenCalled();
    } finally {
      engine.prepareLaunch = originalPrepareLaunch;
      engine.buildBootCommand = originalBuildBootCommand;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('tears down the spawned pid when readiness fails', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-teardown-'));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const tornDown: number[] = [];
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown;
    const spawn = mock(() => ({ pid: 4321 } as const));
    try {
      engine.teardown = mock(async (pid: number) => {
        tornDown.push(pid);
      });
      const result = await startModelHost({
        key: { name: 'mlx-host-server' },
        workloadsDir,
        runtimeDir,
        spawn,
        probeReady: async () => ({ ready: false, modelIds: [] }),
      });

      expect(result.ok).toBe(false);
      expect(tornDown).toEqual([4321]);
    } finally {
      engine.teardown = originalTeardown;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('sanitizes the spawned env to the allowlist', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-env-'));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const spawn = mock(() => ({ pid: 4321 } as const));
    const env = {
      PATH: '/usr/bin',
      HOME: '/Users/test',
      USER: 'test',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TMPDIR: '/tmp',
      LLAMACTL_MODELS_DIR: '/models',
      LLAMA_CPP_MODELS: '/llama-models',
      LLAMA_CPP_BIN: '/bin/llama',
      SECRET_TOKEN: 'leak',
    } as NodeJS.ProcessEnv;
    try {
      const result = await startModelHost({
        key: { name: 'mlx-host-server' },
        workloadsDir,
        runtimeDir,
        env,
        spawn,
        probeReady: async () => ({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      const [, , options] = spawn.mock.calls[0]!;
      expect(options.env?.SECRET_TOKEN).toBeUndefined();
      expect(options.env?.PATH).toBe('/usr/bin');
      expect(options.env?.LLAMA_CPP_BIN).toBe('/bin/llama');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('startModelHost writes state sidecar with the spawn pid', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-start-'));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const spawn = mock(() => ({ pid: 4321 } as const));
    try {
      const result = await startModelHost({
        key: { name: 'mlx-host-server' },
        workloadsDir,
        runtimeDir,
        spawn,
        probeReady: async () => ({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(readFileSync(join(runtimeDir, 'workloads', 'mlx-host-server', 'modelhost.state'), 'utf8')).toContain('"pid": 4321');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('stopModelHost reads state, tears down the pid, and removes sidecar state', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-stop-'));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const spawn = mock(() => ({ pid: 4321 } as const));
    const tornDown: number[] = [];
    try {
      await startModelHost({
        key: { name: 'mlx-host-server' },
        workloadsDir,
        runtimeDir,
        spawn,
        probeReady: async () => ({ ready: true, modelIds: [] }),
      });

      const result = await stopModelHost({
        key: { name: 'mlx-host-server' },
        runtimeDir,
        teardown: async (pid) => {
          tornDown.push(pid);
        },
      });

      expect(result.ok).toBe(true);
      expect(tornDown).toEqual([4321]);
      expect(result.pid).toBe(4321);
      expect(statusModelHost({ key: { name: 'mlx-host-server' }, runtimeDir })).toEqual({ state: 'Stopped' });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('statusModelHost reports Stopped when there is no sidecar', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-status-'));
    try {
      expect(statusModelHost({
        key: { name: 'mlx-host-server' },
        runtimeDir: join(tmp, 'runtime'),
      })).toEqual({ state: 'Stopped' });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
