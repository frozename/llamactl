import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');

function readPackageJson(path: string): { scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as { scripts?: Record<string, string> };
}

describe('strict lint rollout baselines', () => {
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
});
