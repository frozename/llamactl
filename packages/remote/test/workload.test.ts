import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ModelRunSchema,
  type ModelRun,
} from '../src/workload/schema.js';
import {
  defaultWorkloadsDir,
  deleteWorkload,
  listWorkloadNames,
  listWorkloads,
  loadWorkload,
  loadWorkloadByName,
  parseWorkload,
  saveWorkload,
  workloadPath,
} from '../src/workload/store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llamactl-workloads-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sampleYaml = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: gemma-qa
  labels:
    env: dev
spec:
  node: gpu1
  target:
    kind: rel
    value: gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf
  extraArgs:
    - --ctx-size
    - "32768"
  restartPolicy: Always
  endpoint:
    host: 0.0.0.0
    port: 8080
`;

const minimalYaml = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: minimal
spec:
  node: local
  target:
    value: foo/bar.gguf
`;

const multiNodeYaml = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: llama-70b-split
spec:
  node: coordinator
  target:
    kind: rel
    value: llama-70b.gguf
  workers:
    - node: gpu-worker-1
      rpcHost: 10.0.0.21
      rpcPort: 50052
    - node: gpu-worker-2
      rpcHost: 10.0.0.22
      rpcPort: 50052
  timeoutSeconds: 60
`;

describe('ModelRun schema', () => {
  test('parses a fully-specified manifest', () => {
    const m = parseWorkload(sampleYaml);
    expect(m.metadata.name).toBe('gemma-qa');
    expect(m.spec.node).toBe('gpu1');
    expect(m.spec.target.kind).toBe('rel');
    expect(m.spec.extraArgs).toEqual(['--ctx-size', '32768']);
    expect(m.spec.restartPolicy).toBe('Always');
  });

  test('applies defaults to a minimal manifest', () => {
    const m = parseWorkload(minimalYaml);
    expect(m.spec.target.kind).toBe('rel');
    expect(m.spec.extraArgs).toEqual([]);
    expect(m.spec.restartPolicy).toBe('Always');
    expect(m.metadata.labels).toEqual({});
    expect(m.spec.timeoutSeconds).toBe(60);
  });

  test('rejects a bad name', () => {
    const bad = sampleYaml.replace('name: gemma-qa', 'name: Gemma-QA');
    expect(() => parseWorkload(bad)).toThrow(/lowercase alphanumeric/);
  });

  test('rejects wrong apiVersion', () => {
    const bad = sampleYaml.replace('apiVersion: llamactl/v1', 'apiVersion: wrong');
    expect(() => parseWorkload(bad)).toThrow();
  });

  test('rejects wrong kind', () => {
    const bad = sampleYaml.replace('kind: ModelRun', 'kind: Pod');
    expect(() => parseWorkload(bad)).toThrow();
  });

  test('round-trips through save + load', () => {
    const m = parseWorkload(sampleYaml);
    const path = saveWorkload(m, dir);
    const reloaded = loadWorkload(path);
    expect(reloaded).toEqual(m);
  });

  test('parses a multi-node manifest with workers', () => {
    const m = parseWorkload(multiNodeYaml);
    expect(m.spec.node).toBe('coordinator');
    expect(m.spec.workers).toHaveLength(2);
    expect(m.spec.workers[0]).toEqual({
      node: 'gpu-worker-1',
      rpcHost: '10.0.0.21',
      rpcPort: 50052,
      extraArgs: [],
      timeoutSeconds: 30,
    });
    expect(m.spec.workers[1]?.rpcHost).toBe('10.0.0.22');
  });

  test('rejects a worker with port out of range', () => {
    const bad = multiNodeYaml.replace('rpcPort: 50052', 'rpcPort: 99999');
    expect(() => parseWorkload(bad)).toThrow();
  });

  test('defaults workers to [] when absent', () => {
    const m = parseWorkload(minimalYaml);
    expect(m.spec.workers).toEqual([]);
  });
});

describe('workload store', () => {
  test('defaultWorkloadsDir respects DEV_STORAGE', () => {
    expect(defaultWorkloadsDir({ DEV_STORAGE: '/foo' }))
      .toBe('/foo/workloads');
  });

  test('defaultWorkloadsDir respects LLAMACTL_WORKLOADS_DIR', () => {
    expect(defaultWorkloadsDir({ LLAMACTL_WORKLOADS_DIR: '/explicit' }))
      .toBe('/explicit');
  });

  test('save + load by name', () => {
    const m = parseWorkload(sampleYaml);
    saveWorkload(m, dir);
    const loaded = loadWorkloadByName('gemma-qa', dir);
    expect(loaded).toEqual(m);
  });

  test('listWorkloadNames empty dir returns []', () => {
    expect(listWorkloadNames(dir)).toEqual([]);
  });

  test('listWorkloadNames returns sorted names', () => {
    const m1 = parseWorkload(sampleYaml);
    saveWorkload(m1, dir);
    const m2 = parseWorkload(minimalYaml);
    saveWorkload(m2, dir);
    const extra = parseWorkload(
      sampleYaml.replace('name: gemma-qa', 'name: alpha'),
    );
    saveWorkload(extra, dir);
    expect(listWorkloadNames(dir)).toEqual(['alpha', 'gemma-qa', 'minimal']);
  });

  test('listWorkloads returns parsed manifests', () => {
    saveWorkload(parseWorkload(sampleYaml), dir);
    const loaded = listWorkloads(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.metadata.name).toBe('gemma-qa');
  });

  test('listWorkloadNames ignores non-YAML files', () => {
    writeFileSync(join(dir, 'readme.txt'), 'hi', 'utf8');
    saveWorkload(parseWorkload(sampleYaml), dir);
    expect(listWorkloadNames(dir)).toEqual(['gemma-qa']);
  });

  test('deleteWorkload removes the file and returns true', () => {
    saveWorkload(parseWorkload(sampleYaml), dir);
    expect(deleteWorkload('gemma-qa', dir)).toBe(true);
    expect(listWorkloadNames(dir)).toEqual([]);
  });

  test('deleteWorkload returns false when absent', () => {
    expect(deleteWorkload('missing', dir)).toBe(false);
  });

  test('loadWorkload throws on missing path', () => {
    expect(() => loadWorkload(join(dir, 'nope.yaml'))).toThrow(/not found/);
  });

  test('workloadPath composes the filename from the metadata name', () => {
    expect(workloadPath('foo', dir)).toBe(join(dir, 'foo.yaml'));
  });

  test('saveWorkload rewrites an existing manifest in place', () => {
    const a = parseWorkload(sampleYaml);
    saveWorkload(a, dir);
    const b: ModelRun = {
      ...a,
      spec: { ...a.spec, extraArgs: ['--new'] },
    };
    saveWorkload(b, dir);
    const raw = readFileSync(workloadPath('gemma-qa', dir), 'utf8');
    expect(raw).toContain('--new');
    expect(raw).not.toContain('--ctx-size');
  });

  test('ModelRunSchema round-trips via the exported schema object', () => {
    const m = parseWorkload(minimalYaml);
    const parsed = ModelRunSchema.parse(m);
    expect(parsed).toEqual(m);
  });
});
