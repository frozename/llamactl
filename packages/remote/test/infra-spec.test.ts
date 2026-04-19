import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  defaultInfraPackagesDir,
  infraPackageSpecPath,
  listInfraPackageSpecs,
  loadInfraPackageSpec,
  resolveInfraArtifact,
  type InfraPackageSpec,
} from '../src/infra/spec.js';

let dir = '';

const SAMPLE_SPEC: InfraPackageSpec = {
  name: 'llama-cpp',
  versions: {
    b4500: {
      platforms: {
        'darwin-arm64': {
          url: 'https://example.com/llama-b4500-darwin-arm64.tar.gz',
          sha256: '1'.repeat(64),
        },
        'linux-x64': {
          url: 'https://example.com/llama-b4500-linux-x64.tar.gz',
          sha256: '2'.repeat(64),
        },
      },
      service: false,
      notes: 'llama.cpp build b4500',
    },
    b4501: {
      platforms: {
        'darwin-arm64': {
          url: 'https://example.com/llama-b4501-darwin-arm64.tar.gz',
          sha256: '3'.repeat(64),
        },
      },
      service: false,
    },
  },
  default: 'b4501',
};

function seedSpec(name: string, spec: InfraPackageSpec = SAMPLE_SPEC): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.yaml`);
  writeFileSync(path, stringifyYaml(spec), 'utf8');
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llamactl-infra-spec-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('defaultInfraPackagesDir', () => {
  test('honors LLAMACTL_INFRA_PACKAGES_DIR', () => {
    expect(
      defaultInfraPackagesDir({ LLAMACTL_INFRA_PACKAGES_DIR: '/custom' }),
    ).toBe('/custom');
  });
  test('falls back to DEV_STORAGE/packages', () => {
    expect(defaultInfraPackagesDir({ DEV_STORAGE: '/tmp/dev' })).toBe('/tmp/dev/packages');
  });
});

describe('loadInfraPackageSpec', () => {
  test('parses a well-formed spec', () => {
    seedSpec('llama-cpp');
    const spec = loadInfraPackageSpec('llama-cpp', dir);
    expect(spec.name).toBe('llama-cpp');
    expect(Object.keys(spec.versions).sort()).toEqual(['b4500', 'b4501']);
    expect(spec.default).toBe('b4501');
    expect(spec.versions.b4500!.platforms['darwin-arm64']?.sha256).toBe('1'.repeat(64));
  });

  test('throws when the file is missing', () => {
    expect(() => loadInfraPackageSpec('does-not-exist', dir)).toThrow(
      /infra package spec not found/,
    );
  });

  test('rejects bad sha256', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'bogus.yaml'),
      stringifyYaml({
        name: 'bogus',
        versions: {
          v1: {
            platforms: {
              'darwin-arm64': { url: 'https://x', sha256: 'not-hex' },
            },
          },
        },
      }),
      'utf8',
    );
    expect(() => loadInfraPackageSpec('bogus', dir)).toThrow();
  });

  test('silently drops unknown platform keys — forward-compat for specs that add new targets', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'pkg.yaml'),
      stringifyYaml({
        name: 'pkg',
        versions: {
          v1: {
            platforms: {
              'darwin-arm64': { url: 'https://x', sha256: 'a'.repeat(64) },
              'bsd-ppc64': { url: 'https://x', sha256: 'a'.repeat(64) },
            },
          },
        },
      }),
      'utf8',
    );
    // Parses — unknown keys stripped by zod's .partial() on the
    // explicit platform object. resolveInfraArtifact still returns
    // 'unknown-platform' for bsd-ppc64 because that key isn't in
    // the InfraPlatformKind enum.
    const spec = loadInfraPackageSpec('pkg', dir);
    expect(Object.keys(spec.versions.v1!.platforms)).toEqual(['darwin-arm64']);
  });
});

describe('listInfraPackageSpecs', () => {
  test('empty dir returns []', () => {
    expect(listInfraPackageSpecs(dir)).toEqual([]);
  });

  test('enumerates yaml files + skips malformed ones', () => {
    seedSpec('llama-cpp');
    seedSpec('embersynth', {
      name: 'embersynth',
      versions: {
        '0.2.0': {
          platforms: {
            'darwin-arm64': { url: 'https://e', sha256: 'a'.repeat(64) },
          },
          service: true,
        },
      },
    });
    // Drop a malformed file to exercise the skip path.
    writeFileSync(join(dir, 'garbage.yaml'), 'not: [valid: }{', 'utf8');
    const rows = listInfraPackageSpecs(dir);
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(['embersynth', 'llama-cpp']);
    const llama = rows.find((r) => r.name === 'llama-cpp')!;
    expect(llama.versions).toEqual(['b4500', 'b4501']);
    expect(llama.default).toBe('b4501');
    const ember = rows.find((r) => r.name === 'embersynth')!;
    expect(ember.default).toBeNull();
  });
});

describe('resolveInfraArtifact', () => {
  test('happy path: known version + known platform yields the artifact', () => {
    const result = resolveInfraArtifact(SAMPLE_SPEC, 'b4500', 'darwin-arm64');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.url).toBe('https://example.com/llama-b4500-darwin-arm64.tar.gz');
    expect(result.platform).toBe('darwin-arm64');
  });

  test('unknown version surfaces reason + the list of known versions', () => {
    const result = resolveInfraArtifact(SAMPLE_SPEC, 'b9999', 'darwin-arm64');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown-version');
    expect(result.message).toContain('b4500');
    expect(result.message).toContain('b4501');
  });

  test('unknown platform surfaces reason + the list of known platforms', () => {
    const result = resolveInfraArtifact(SAMPLE_SPEC, 'b4500', 'linux-arm64');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown-platform');
    expect(result.message).toContain('darwin-arm64');
    expect(result.message).toContain('linux-x64');
  });
});

describe('infraPackageSpecPath', () => {
  test('composes <dir>/<pkg>.yaml', () => {
    expect(infraPackageSpecPath('llama-cpp', '/base')).toBe('/base/llama-cpp.yaml');
  });
});
