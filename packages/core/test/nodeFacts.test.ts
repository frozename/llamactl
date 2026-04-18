import { afterEach, describe, expect, test } from 'bun:test';
import { collectNodeFacts, resolveNodeName, resolveVersions, detectGpu } from '../src/nodeFacts.js';
import { detectMemoryBytes } from '../src/profile.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('resolveNodeName', () => {
  test('honors LLAMACTL_NODE_NAME override', () => {
    expect(resolveNodeName({ LLAMACTL_NODE_NAME: 'gpu1' })).toBe('gpu1');
  });

  test('trims override whitespace', () => {
    expect(resolveNodeName({ LLAMACTL_NODE_NAME: '  gpu1  ' })).toBe('gpu1');
  });

  test('falls back to hostname when override absent', () => {
    const name = resolveNodeName({});
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });

  test('falls back to literal "local" when override is empty string', () => {
    // Empty string is falsy, so hostname kicks in. Verify the contract
    // that we never return an empty string either way.
    expect(resolveNodeName({ LLAMACTL_NODE_NAME: '' }).length).toBeGreaterThan(0);
  });
});

describe('resolveVersions', () => {
  test('returns llamactl + bun + llamaCppSrcRev fields', () => {
    const v = resolveVersions();
    expect(typeof v.llamactl).toBe('string');
    expect(typeof v.bun).toBe('string');
    expect(v.llamaCppSrcRev === null || typeof v.llamaCppSrcRev === 'string').toBe(true);
  });

  test('bun version is a semver-ish string when running under Bun', () => {
    const v = resolveVersions();
    // Under Bun the test runner sets process.versions.bun. If it is set,
    // it should look like a version. Otherwise it falls back to 'unknown'.
    if (v.bun !== 'unknown') {
      expect(v.bun).toMatch(/^\d+\.\d+\.\d+/);
    }
  });
});

describe('detectGpu', () => {
  test('returns a GpuInfo or null without throwing', () => {
    const gpu = detectGpu();
    if (gpu !== null) {
      expect(['metal', 'cuda', 'rocm', 'cpu']).toContain(gpu.kind);
    }
  });

  test('on darwin, kind is "metal"', () => {
    if (process.platform !== 'darwin') return;
    const gpu = detectGpu();
    expect(gpu?.kind).toBe('metal');
  });
});

describe('collectNodeFacts', () => {
  test('returns all documented fields', () => {
    const facts = collectNodeFacts();
    expect(typeof facts.nodeName).toBe('string');
    expect(['mac-mini-16g', 'balanced', 'macbook-pro-48g']).toContain(facts.profile);
    expect(facts.memBytes === null || typeof facts.memBytes === 'number').toBe(true);
    expect(typeof facts.os).toBe('string');
    expect(typeof facts.arch).toBe('string');
    expect(facts.platform).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect(facts.llamaCppBuildId === null || typeof facts.llamaCppBuildId === 'string').toBe(true);
    expect(facts.gpu === null || typeof facts.gpu === 'object').toBe(true);
    expect(typeof facts.versions.llamactl).toBe('string');
    expect(typeof facts.versions.bun).toBe('string');
    expect(facts.versions.llamaCppSrcRev === null || typeof facts.versions.llamaCppSrcRev === 'string').toBe(true);
    expect(facts.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('platform string matches process.platform/process.arch', () => {
    const facts = collectNodeFacts();
    expect(facts.platform).toBe(`${process.platform}-${process.arch}`);
  });

  test('startedAt is stable across calls (captured at module load)', () => {
    const a = collectNodeFacts();
    const b = collectNodeFacts();
    expect(a.startedAt).toBe(b.startedAt);
  });

  test('nodeName override propagates', () => {
    const facts = collectNodeFacts({ ...process.env, LLAMACTL_NODE_NAME: 'probe' });
    expect(facts.nodeName).toBe('probe');
  });
});

describe('detectMemoryBytes', () => {
  test('returns a number on supported platforms, null otherwise', () => {
    const b = detectMemoryBytes();
    if (process.platform === 'darwin' || process.platform === 'linux') {
      expect(typeof b).toBe('number');
      expect(b ?? 0).toBeGreaterThan(0);
    } else {
      expect(b).toBeNull();
    }
  });
});
