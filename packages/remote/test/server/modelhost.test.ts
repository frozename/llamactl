import { describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
        waitMs: 1,
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
        waitMs: 1,
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
