import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activateInfraVersion,
  defaultInfraDir,
  ensurePackageDir,
  infraCurrentSymlink,
  infraVersionDir,
  listInstalledInfra,
  removeInfraPackage,
  removeInfraVersion,
  resolveCurrentVersion,
} from '../src/infra/layout.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llamactl-infra-layout-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedVersion(pkg: string, version: string): string {
  const versionDir = infraVersionDir(pkg, version, dir);
  mkdirSync(join(versionDir, 'bin'), { recursive: true });
  return versionDir;
}

describe('defaultInfraDir', () => {
  test('honors LLAMACTL_INFRA_DIR override', () => {
    expect(defaultInfraDir({ LLAMACTL_INFRA_DIR: '/custom' })).toBe('/custom');
  });
  test('falls back to DEV_STORAGE/infra', () => {
    expect(defaultInfraDir({ DEV_STORAGE: '/tmp/dev' })).toBe('/tmp/dev/infra');
  });
});

describe('listInstalledInfra', () => {
  test('empty dir yields empty list', () => {
    expect(listInstalledInfra(dir)).toEqual([]);
  });

  test('missing dir yields empty list (no throw)', () => {
    expect(listInstalledInfra(join(dir, 'does-not-exist'))).toEqual([]);
  });

  test('enumerates versions per package, sorted', () => {
    seedVersion('llama-cpp', 'b4500');
    seedVersion('llama-cpp', 'b4501');
    seedVersion('embersynth', '0.2.0');
    const rows = listInstalledInfra(dir);
    expect(rows).toHaveLength(2);
    const llama = rows.find((r) => r.pkg === 'llama-cpp')!;
    expect(llama.versions).toEqual(['b4500', 'b4501']);
    expect(llama.active).toBeNull();
    const ember = rows.find((r) => r.pkg === 'embersynth')!;
    expect(ember.versions).toEqual(['0.2.0']);
  });

  test('active version reflects the `current` symlink target', () => {
    seedVersion('llama-cpp', 'b4500');
    seedVersion('llama-cpp', 'b4501');
    activateInfraVersion('llama-cpp', 'b4501', dir);
    const rows = listInstalledInfra(dir);
    expect(rows[0]!.active).toBe('b4501');
  });

  test('dangling `current` symlink (points at a removed version) surfaces as active:null', () => {
    seedVersion('llama-cpp', 'b4500');
    activateInfraVersion('llama-cpp', 'b4500', dir);
    // Remove the version behind the symlink but not the symlink itself.
    rmSync(infraVersionDir('llama-cpp', 'b4500', dir), { recursive: true, force: true });
    const rows = listInstalledInfra(dir);
    expect(rows[0]!.versions).toEqual([]);
    expect(rows[0]!.active).toBeNull();
  });

  test('ignores stray symlinks that do not match any installed version', () => {
    seedVersion('llama-cpp', 'b4500');
    // Point `current` at a non-existent version.
    symlinkSync('b9999', infraCurrentSymlink('llama-cpp', dir));
    const rows = listInstalledInfra(dir);
    expect(rows[0]!.active).toBeNull();
  });
});

describe('activateInfraVersion', () => {
  test('creates the symlink when absent', () => {
    seedVersion('llama-cpp', 'b4500');
    activateInfraVersion('llama-cpp', 'b4500', dir);
    const link = infraCurrentSymlink('llama-cpp', dir);
    expect(existsSync(link)).toBe(true);
    expect(readlinkSync(link)).toBe('b4500');
  });

  test('overwrites an existing symlink atomically (rename-over)', () => {
    seedVersion('llama-cpp', 'b4500');
    seedVersion('llama-cpp', 'b4501');
    activateInfraVersion('llama-cpp', 'b4500', dir);
    activateInfraVersion('llama-cpp', 'b4501', dir);
    expect(readlinkSync(infraCurrentSymlink('llama-cpp', dir))).toBe('b4501');
  });

  test('throws when the version is not installed', () => {
    expect(() => activateInfraVersion('llama-cpp', 'b9999', dir)).toThrow(/not installed/);
  });
});

describe('resolveCurrentVersion', () => {
  test('returns null for uninstalled packages', () => {
    expect(resolveCurrentVersion('llama-cpp', dir)).toBeNull();
  });

  test('returns the active version + dir', () => {
    seedVersion('llama-cpp', 'b4500');
    activateInfraVersion('llama-cpp', 'b4500', dir);
    const resolved = resolveCurrentVersion('llama-cpp', dir);
    expect(resolved).not.toBeNull();
    expect(resolved!.version).toBe('b4500');
    expect(resolved!.dir).toBe(infraVersionDir('llama-cpp', 'b4500', dir));
  });

  test('returns null when the symlink target is gone', () => {
    seedVersion('llama-cpp', 'b4500');
    activateInfraVersion('llama-cpp', 'b4500', dir);
    rmSync(infraVersionDir('llama-cpp', 'b4500', dir), { recursive: true, force: true });
    expect(resolveCurrentVersion('llama-cpp', dir)).toBeNull();
  });
});

describe('removeInfraVersion + removeInfraPackage', () => {
  test('removeInfraVersion leaves other versions + symlink alone', () => {
    seedVersion('llama-cpp', 'b4500');
    seedVersion('llama-cpp', 'b4501');
    activateInfraVersion('llama-cpp', 'b4501', dir);
    expect(removeInfraVersion('llama-cpp', 'b4500', dir)).toBe(true);
    const rows = listInstalledInfra(dir);
    expect(rows[0]!.versions).toEqual(['b4501']);
    expect(rows[0]!.active).toBe('b4501');
  });

  test('removeInfraVersion returns false when version missing', () => {
    expect(removeInfraVersion('llama-cpp', 'nope', dir)).toBe(false);
  });

  test('removeInfraPackage nukes the whole pkg dir', () => {
    seedVersion('llama-cpp', 'b4500');
    seedVersion('llama-cpp', 'b4501');
    activateInfraVersion('llama-cpp', 'b4501', dir);
    expect(removeInfraPackage('llama-cpp', dir)).toBe(true);
    expect(listInstalledInfra(dir)).toEqual([]);
  });
});

describe('ensurePackageDir', () => {
  test('creates the pkg directory idempotently', () => {
    const first = ensurePackageDir('llama-cpp', dir);
    const second = ensurePackageDir('llama-cpp', dir);
    expect(first).toBe(second);
    expect(existsSync(first)).toBe(true);
  });
});
