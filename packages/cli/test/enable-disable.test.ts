import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  parseWorkload,
  saveWorkload,
} from '../../remote/src/workload/store.js';
import type { ModelRun } from '../../remote/src/workload/schema.js';
import {
  setWorkloadEnabledWithDeps,
  type SetEnabledDeps,
} from '../src/commands/setEnabled.js';

let tmp = '';
let workloadsDir = '';
let applyCalls = 0;

function makeManifest(enabled = true): ModelRun {
  return parseWorkload([
    'apiVersion: llamactl/v1',
    'kind: ModelRun',
    'metadata:',
    '  name: gemma-qa',
    'spec:',
    '  node: gpu1',
    `  enabled: ${enabled ? 'true' : 'false'}`,
    '  target:',
    '    kind: rel',
    '    value: fake-org/fake-model.gguf',
    '  restartPolicy: Always',
    '',
  ].join('\n'));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-enable-disable-'));
  workloadsDir = join(tmp, 'workloads');
  applyCalls = 0;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function deps() {
  return {
    loadWorkloadByName: (name: string) => {
      return parseYaml(readFileSync(join(workloadsDir, `${name}.yaml`), 'utf8')) as ModelRun;
    },
    saveWorkload: (manifest: ModelRun) => saveWorkload(manifest, workloadsDir),
    loadConfig: () => ({ currentContext: 'default', contexts: [], clusters: [], users: [] }),
    resolveNode: (_cfg: unknown, node: string) => ({ node: { endpoint: `https://${node}` } }),
    getNodeClientByName: () => ({}),
    applyOne: async (manifest: ModelRun) => {
      applyCalls++;
      return {
        action: manifest.spec.enabled ? 'started' : 'stopped',
        statusSection: {
          phase: manifest.spec.enabled ? 'Running' : 'Stopped',
          endpoint: manifest.spec.enabled ? 'http://127.0.0.1:8080' : null,
          serverPid: manifest.spec.enabled ? 1234 : null,
          lastTransitionTime: '2026-05-13T00:00:00.000Z',
          conditions: [],
        },
        error: null,
      };
    },
  } as unknown as SetEnabledDeps;
}

describe('llamactl enable/disable', () => {
  test('disable flips spec.enabled false and re-applies', async () => {
    saveWorkload(makeManifest(true), workloadsDir);

    const result = await setWorkloadEnabledWithDeps('gemma-qa', false, deps());

    expect(result.code).toBe(0);
    expect(result.message).toBe('disabled modelrun/gemma-qa\n');
    expect(applyCalls).toBe(1);

    const saved = parseYaml(readFileSync(join(workloadsDir, 'gemma-qa.yaml'), 'utf8')) as ModelRun;
    expect(saved.spec.enabled).toBe(false);
  });

  test('enable flips spec.enabled true and re-applies', async () => {
    saveWorkload(makeManifest(false), workloadsDir);

    const result = await setWorkloadEnabledWithDeps('gemma-qa', true, deps());

    expect(result.code).toBe(0);
    expect(result.message).toBe('enabled modelrun/gemma-qa\n');
    expect(applyCalls).toBe(1);

    const saved = parseYaml(readFileSync(join(workloadsDir, 'gemma-qa.yaml'), 'utf8')) as ModelRun;
    expect(saved.spec.enabled).toBe(true);
  });

  test('unknown workload returns not found', async () => {
    const result = await setWorkloadEnabledWithDeps('ghost', true, deps());

    expect(result.code).toBe(1);
    expect(result.message).toContain('workload not found: ghost');
    expect(applyCalls).toBe(0);
  });
});
