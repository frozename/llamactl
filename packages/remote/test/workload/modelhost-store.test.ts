import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  listModelHosts,
  parseModelHost,
  saveModelHost,
  loadModelHostByName,
  deleteModelHost,
} from '../../src/workload/modelhost-store.js';

const manifest = parseModelHost(`
kind: ModelHost
apiVersion: llamactl.io/v1
metadata:
  name: mlx-host-local
spec:
  enabled: true
  node: local
  engine: omlx
  binary: /tmp/omlx
  endpoint:
    host: 127.0.0.1
    port: 8094
  hostedModels:
    - rel: mlx-community/Qwen3-8B-MLX-4bit
  resources:
    expectedMemoryGiB: 12
  extraArgs: []
  timeoutSeconds: 60
`);

describe('modelhost-store', () => {
  test('save/load round-trips a ModelHost manifest by name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-store-'));
    try {
      const path = saveModelHost(manifest, dir);
      expect(path.endsWith('mlx-host-local.yaml')).toBe(true);
      const loaded = loadModelHostByName('mlx-host-local', dir);
      expect(loaded.metadata.name).toBe('mlx-host-local');
      expect(loaded.kind).toBe('ModelHost');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('listModelHosts skips ModelRun and NodeRun files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-list-'));
    try {
      writeFileSync(join(dir, 'run.yaml'), 'kind: ModelRun\napiVersion: llamactl.io/v1\nmetadata: {name: run}\nspec: {enabled: true, node: local, rel: x, extraArgs: []}\n');
      writeFileSync(join(dir, 'node.yaml'), 'kind: NodeRun\napiVersion: llamactl.io/v1\nmetadata: {name: node}\nspec: {enabled: true}\n');
      saveModelHost(manifest, dir);
      expect(listModelHosts(dir).map((m) => m.metadata.name)).toEqual(['mlx-host-local']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('deleteModelHost removes the stored yaml file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llamactl-modelhost-delete-'));
    try {
      saveModelHost(manifest, dir);
      expect(deleteModelHost('mlx-host-local', dir)).toBe(true);
      expect(deleteModelHost('mlx-host-local', dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
