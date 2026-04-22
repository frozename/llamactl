import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';

import { router } from '../src/router.js';

/**
 * tRPC surfaces for `project *`. Covers:
 *   - apply: parse error, schema error, happy path (on-disk YAML
 *     after the call), idempotent re-apply
 *   - list / get / remove: basic dispatch + error shapes
 *   - index: routes through ragPipelineApply and surfaces the
 *     generated pipeline name + disk path; BAD_REQUEST when
 *     spec.rag is absent
 *   - resolveRouting: matched vs default fallback
 *
 * `LLAMACTL_PROJECTS_FILE` pins the project store into a tmpdir
 * and `LLAMACTL_RAG_PIPELINES_DIR` catches the rag-pipeline
 * manifest that `projectIndex` auto-wires.
 */

const originalEnv = { ...process.env };
let tmp = '';
let projectsPath = '';
let pipelinesRoot = '';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-router-project-'));
  projectsPath = join(tmp, 'projects.yaml');
  pipelinesRoot = join(tmp, 'rag-pipelines');
  Object.assign(process.env, {
    LLAMACTL_PROJECTS_FILE: projectsPath,
    LLAMACTL_RAG_PIPELINES_DIR: pipelinesRoot,
    LLAMACTL_CONFIG: join(tmp, 'config'),
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

function manifestYaml(
  name: string,
  overrides: Record<string, unknown> = {},
): string {
  return stringifyYaml({
    apiVersion: 'llamactl/v1',
    kind: 'Project',
    metadata: { name },
    spec: {
      path: `/abs/${name}`,
      stack: ['typescript'],
      routing: { quick_qna: 'mac-mini.claude-pro' },
      ...overrides,
    },
  });
}

describe('projectApply', () => {
  test('happy path writes projects.yaml and reports created=true', async () => {
    const caller = router.createCaller({});
    const res = await caller.projectApply({ manifestYaml: manifestYaml('alpha') });
    expect(res.ok).toBe(true);
    expect(res.name).toBe('alpha');
    expect(res.created).toBe(true);
    expect(res.path).toBe(projectsPath);
    expect(existsSync(projectsPath)).toBe(true);
  });

  test('re-apply reports created=false and upserts in place', async () => {
    const caller = router.createCaller({});
    await caller.projectApply({ manifestYaml: manifestYaml('reapply') });
    const res = await caller.projectApply({
      manifestYaml: manifestYaml('reapply', {
        path: '/abs/reapply-v2',
        routing: {},
      }),
    });
    expect(res.created).toBe(false);
    const list = await caller.projectList();
    expect(list.projects.length).toBe(1);
    expect(list.projects[0]!.spec.path).toBe('/abs/reapply-v2');
  });

  test('invalid YAML → BAD_REQUEST', async () => {
    const caller = router.createCaller({});
    await expect(
      caller.projectApply({ manifestYaml: 'not: [valid\n' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('schema-invalid (missing path) → BAD_REQUEST', async () => {
    const caller = router.createCaller({});
    const bad = stringifyYaml({
      apiVersion: 'llamactl/v1',
      kind: 'Project',
      metadata: { name: 'bad' },
      spec: {},
    });
    await expect(
      caller.projectApply({ manifestYaml: bad }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('projectList', () => {
  test('empty registry → projects: []', async () => {
    const caller = router.createCaller({});
    const res = await caller.projectList();
    expect(res.projects).toEqual([]);
  });

  test('lists applied projects', async () => {
    const caller = router.createCaller({});
    await caller.projectApply({ manifestYaml: manifestYaml('a') });
    await caller.projectApply({ manifestYaml: manifestYaml('b') });
    const res = await caller.projectList();
    const names = res.projects.map((p) => p.metadata.name).sort();
    expect(names).toEqual(['a', 'b']);
  });
});

describe('projectGet', () => {
  test('NOT_FOUND when absent', async () => {
    const caller = router.createCaller({});
    await expect(
      caller.projectGet({ name: 'ghost' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('returns the full manifest when present', async () => {
    const caller = router.createCaller({});
    await caller.projectApply({ manifestYaml: manifestYaml('there') });
    const res = await caller.projectGet({ name: 'there' });
    expect(res.project.metadata.name).toBe('there');
    expect(res.project.spec.routing.quick_qna).toBe('mac-mini.claude-pro');
  });
});

describe('projectRemove', () => {
  test('removed=false when absent', async () => {
    const caller = router.createCaller({});
    const res = await caller.projectRemove({ name: 'ghost' });
    expect(res.ok).toBe(true);
    expect(res.removed).toBe(false);
  });

  test('removed=true + entry gone when present', async () => {
    const caller = router.createCaller({});
    await caller.projectApply({ manifestYaml: manifestYaml('bye') });
    const res = await caller.projectRemove({ name: 'bye' });
    expect(res.removed).toBe(true);
    const list = await caller.projectList();
    expect(list.projects.length).toBe(0);
  });

  test('leaves other projects intact', async () => {
    const caller = router.createCaller({});
    await caller.projectApply({ manifestYaml: manifestYaml('keep') });
    await caller.projectApply({ manifestYaml: manifestYaml('drop') });
    await caller.projectRemove({ name: 'drop' });
    const list = await caller.projectList();
    expect(list.projects.map((p) => p.metadata.name)).toEqual(['keep']);
  });
});

describe('projectIndex', () => {
  test('NOT_FOUND when project is absent', async () => {
    const caller = router.createCaller({});
    await expect(
      caller.projectIndex({ name: 'ghost' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('BAD_REQUEST when spec.rag is missing', async () => {
    const caller = router.createCaller({});
    // Project without a rag block — indexing should fail loudly.
    await caller.projectApply({
      manifestYaml: manifestYaml('norag', { rag: undefined }),
    });
    await expect(
      caller.projectIndex({ name: 'norag' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('generates and applies a RagPipeline manifest named project-<name>', async () => {
    const caller = router.createCaller({});
    await caller.projectApply({
      manifestYaml: manifestYaml('indexed', {
        path: '/abs/indexed',
        purpose: 'demo project',
        rag: {
          node: 'kb-pg',
          collection: 'indexed_docs',
          docsGlob: 'docs/**/*.md',
        },
      }),
    });
    const res = await caller.projectIndex({ name: 'indexed' });
    expect(res.ok).toBe(true);
    expect(res.pipelineName).toBe('project-indexed');
    // The generated rag-pipeline spec.yaml should exist on disk.
    const specPath = join(pipelinesRoot, 'project-indexed', 'spec.yaml');
    expect(res.path).toBe(specPath);
    expect(existsSync(specPath)).toBe(true);
    // Inspect the generated manifest shape.
    const parsed = parseYaml(readFileSync(specPath, 'utf8')) as {
      apiVersion: string;
      kind: string;
      metadata: { name: string };
      spec: {
        destination: { ragNode: string; collection: string };
        sources: Array<{ kind: string; root: string; glob: string; tag: Record<string, string> }>;
        transforms: Array<{ kind: string; chunk_size?: number }>;
        on_duplicate: string;
      };
    };
    expect(parsed.kind).toBe('RagPipeline');
    expect(parsed.metadata.name).toBe('project-indexed');
    expect(parsed.spec.destination.ragNode).toBe('kb-pg');
    expect(parsed.spec.destination.collection).toBe('indexed_docs');
    expect(parsed.spec.sources[0]!.root).toBe('/abs/indexed');
    expect(parsed.spec.sources[0]!.glob).toBe('docs/**/*.md');
    expect(parsed.spec.sources[0]!.tag.project).toBe('indexed');
    expect(parsed.spec.sources[0]!.tag.purpose).toBe('demo project');
    expect(parsed.spec.transforms[0]!.kind).toBe('markdown-chunk');
    expect(parsed.spec.on_duplicate).toBe('replace');
  });

  test('threads spec.rag.schedule into the pipeline when declared', async () => {
    const caller = router.createCaller({});
    await caller.projectApply({
      manifestYaml: manifestYaml('scheduled', {
        rag: {
          node: 'kb-pg',
          collection: 'c',
          docsGlob: 'docs/**/*.md',
          schedule: '@every 1h',
        },
      }),
    });
    const res = await caller.projectIndex({ name: 'scheduled' });
    const parsed = parseYaml(readFileSync(res.path, 'utf8')) as {
      spec: { schedule?: string };
    };
    expect(parsed.spec.schedule).toBe('@every 1h');
  });
});

describe('projectResolveRouting', () => {
  test('NOT_FOUND when project is absent', async () => {
    const caller = router.createCaller({});
    await expect(
      caller.projectResolveRouting({ project: 'ghost', taskKind: 'quick_qna' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('returns the declared target when policy matches', async () => {
    const caller = router.createCaller({});
    await caller.projectApply({
      manifestYaml: manifestYaml('declared', {
        routing: { quick_qna: 'mac-mini.claude-pro' },
      }),
    });
    const res = await caller.projectResolveRouting({
      project: 'declared',
      taskKind: 'quick_qna',
    });
    expect(res.target).toBe('mac-mini.claude-pro');
    expect(res.matched).toBe(true);
  });

  test('falls back to private-first when no policy entry matches', async () => {
    const caller = router.createCaller({});
    await caller.projectApply({
      manifestYaml: manifestYaml('fallback', { routing: {} }),
    });
    const res = await caller.projectResolveRouting({
      project: 'fallback',
      taskKind: 'anything',
    });
    expect(res.target).toBe('private-first');
    expect(res.matched).toBe(false);
  });
});
