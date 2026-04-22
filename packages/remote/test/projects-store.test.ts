import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defaultProjectsPath,
  loadProjects,
  removeProject,
  saveProjects,
  upsertProject,
  type Project,
} from '../src/config/projects.js';

/**
 * On-disk persistence for the Project resource. Tests drive the
 * store via the `LLAMACTL_PROJECTS_FILE` env override so nothing
 * touches the operator's real `~/.llamactl/projects.yaml`.
 */

let tmp = '';
let path = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-projects-store-'));
  path = join(tmp, 'projects.yaml');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

function makeProject(name: string, overrides: Partial<Project['spec']> = {}): Project {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'Project',
    metadata: { name },
    spec: {
      path: `/abs/${name}`,
      stack: [],
      routing: {},
      ...overrides,
    },
  };
}

describe('defaultProjectsPath', () => {
  test('env override wins over DEV_STORAGE and home fallback', () => {
    const env = {
      LLAMACTL_PROJECTS_FILE: '/custom/projects.yaml',
      DEV_STORAGE: '/dev/store',
      HOME: '/some/home',
    } as NodeJS.ProcessEnv;
    expect(defaultProjectsPath(env)).toBe('/custom/projects.yaml');
  });

  test('DEV_STORAGE used when no override', () => {
    const env = { DEV_STORAGE: '/dev/store' } as NodeJS.ProcessEnv;
    expect(defaultProjectsPath(env)).toBe('/dev/store/projects.yaml');
  });

  test('falls back to $HOME/.llamactl/projects.yaml', () => {
    const env = {} as NodeJS.ProcessEnv;
    const p = defaultProjectsPath(env);
    expect(p.endsWith('/.llamactl/projects.yaml')).toBe(true);
  });

  test('ignores empty-string env override', () => {
    const env = {
      LLAMACTL_PROJECTS_FILE: '   ',
      DEV_STORAGE: '/dev/store',
    } as NodeJS.ProcessEnv;
    expect(defaultProjectsPath(env)).toBe('/dev/store/projects.yaml');
  });
});

describe('loadProjects / saveProjects', () => {
  test('returns [] when file does not exist', () => {
    expect(loadProjects(path)).toEqual([]);
  });

  test('round-trips a minimal project', () => {
    saveProjects([makeProject('alpha')], path);
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('kind: ProjectList');
    expect(raw).toContain('name: alpha');
    const loaded = loadProjects(path);
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.metadata.name).toBe('alpha');
  });

  test('round-trips a project with rag + routing + budget', () => {
    const p = makeProject('full', {
      rag: { node: 'kb-pg', collection: 'docs', docsGlob: 'docs/**/*.md' },
      routing: { quick_qna: 'private-first', code_review: 'claude-pro' },
      budget: {
        usd_per_day: 1.5,
        cli_calls_per_day: { 'claude-pro': 50 },
      },
    });
    saveProjects([p], path);
    const loaded = loadProjects(path);
    expect(loaded[0]!.spec.rag!.collection).toBe('docs');
    expect(loaded[0]!.spec.routing.quick_qna).toBe('private-first');
    expect(loaded[0]!.spec.budget!.usd_per_day).toBe(1.5);
  });

  test('mkdir -p the parent directory on save', () => {
    const nested = join(tmp, 'nested', 'deep', 'projects.yaml');
    saveProjects([makeProject('deep')], nested);
    expect(existsSync(nested)).toBe(true);
  });

  test('respects LLAMACTL_PROJECTS_FILE when path argument is omitted', () => {
    process.env.LLAMACTL_PROJECTS_FILE = path;
    saveProjects([makeProject('env-override')]);
    const loaded = loadProjects();
    expect(loaded[0]!.metadata.name).toBe('env-override');
  });
});

describe('upsertProject', () => {
  test('appends a project not yet present', () => {
    const existing = [makeProject('a')];
    const next = upsertProject(existing, makeProject('b'));
    expect(next.length).toBe(2);
    expect(next.map((p) => p.metadata.name).sort()).toEqual(['a', 'b']);
  });

  test('replaces an existing project by name', () => {
    const existing = [makeProject('a', { routing: { quick_qna: 'v1' } })];
    const next = upsertProject(existing, makeProject('a', { routing: { quick_qna: 'v2' } }));
    expect(next.length).toBe(1);
    expect(next[0]!.spec.routing.quick_qna).toBe('v2');
  });

  test('does not mutate the input array', () => {
    const existing = Object.freeze([makeProject('a')]);
    upsertProject(existing as readonly Project[], makeProject('b'));
    expect(existing.length).toBe(1);
  });
});

describe('removeProject', () => {
  test('removes a matching entry', () => {
    const existing = [makeProject('a'), makeProject('b')];
    const next = removeProject(existing, 'a');
    expect(next.length).toBe(1);
    expect(next[0]!.metadata.name).toBe('b');
  });

  test('returns unchanged list when name does not match', () => {
    const existing = [makeProject('a')];
    const next = removeProject(existing, 'ghost');
    expect(next.length).toBe(1);
  });
});
