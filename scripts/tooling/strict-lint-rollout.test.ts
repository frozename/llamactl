import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');

function readPackageJson(path: string): { scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as { scripts?: Record<string, string> };
}

describe('strict lint rollout baselines', () => {
  test('bunx eslint on this test file exits cleanly or with lint violations only', () => {
    const proc = spawnSync('bunx', ['eslint', 'scripts/tooling/strict-lint-rollout.test.ts'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(proc.status).not.toBe(2);
    expect(proc.status === 0 || proc.status === 1).toBe(true);
  });

  test('root typecheck covers every TypeScript package', () => {
    const pkg = readPackageJson('package.json');
    const typecheck = pkg.scripts?.typecheck ?? '';
    const packages = ['core', 'cli', 'app', 'remote', 'eval', 'agents', 'fleet-supervisor', 'mcp'];

    for (const name of packages) {
      expect(typecheck).toContain(`packages/${name}`);
    }
  });

  test('app typecheck checks referenced projects instead of the solution shell', () => {
    const pkg = readPackageJson('packages/app/package.json');
    const typecheck = pkg.scripts?.typecheck ?? '';

    expect(typecheck.trim()).not.toBe('tsc --noEmit');
    expect(typecheck).toContain('tsconfig.main.json');
    expect(typecheck).toContain('tsconfig.node.json');
    expect(typecheck).toContain('tsconfig.web.json');
  });

  test('root package.json exposes the strict lint and format scripts', () => {
    const pkg = readPackageJson('package.json');

    expect(pkg.scripts?.lint).toBe('eslint .');
    expect(pkg.scripts?.['lint:fix']).toBe('eslint . --fix');
    expect(pkg.scripts?.format).toBe('prettier . --write');
    expect(pkg.scripts?.['format:check']).toBe('prettier . --check');
  });

  test('tsconfig.eslint.json exists but is not referenced by build typecheck configs', () => {
    expect(existsSync(join(root, 'tsconfig.eslint.json'))).toBe(true);

    const rootTsconfig = existsSync(join(root, 'tsconfig.json'))
      ? readFileSync(join(root, 'tsconfig.json'), 'utf8')
      : '';
    const baseTsconfig = readFileSync(join(root, 'tsconfig.base.json'), 'utf8');

    expect(rootTsconfig).not.toContain('tsconfig.eslint.json');
    expect(baseTsconfig).not.toContain('tsconfig.eslint.json');
  });
});
