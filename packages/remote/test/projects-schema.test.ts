import { describe, expect, test } from 'bun:test';

import { ProjectSchema, resolveProjectRouting } from '../src/config/projects.js';

/**
 * Schema contract for the Project resource (Phase 2). Covers the
 * defaults + optionality + required-field rules called out in the
 * plan, plus the `resolveProjectRouting` fallback contract.
 */

describe('ProjectSchema', () => {
  test('minimal manifest parses with stack + routing defaults', () => {
    const parsed = ProjectSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'Project',
      metadata: { name: 'minimal' },
      spec: { path: '/abs/path' },
    });
    expect(parsed.metadata.name).toBe('minimal');
    expect(parsed.spec.path).toBe('/abs/path');
    expect(parsed.spec.stack).toEqual([]);
    expect(parsed.spec.routing).toEqual({});
    expect(parsed.spec.rag).toBeUndefined();
    expect(parsed.spec.budget).toBeUndefined();
    expect(parsed.spec.purpose).toBeUndefined();
  });

  test('rag block is optional; when set, docsGlob defaults to docs/**/*.md', () => {
    const parsed = ProjectSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'Project',
      metadata: { name: 'with-rag' },
      spec: {
        path: '/abs/path',
        rag: { node: 'kb-pg', collection: 'docs' },
      },
    });
    expect(parsed.spec.rag).toBeDefined();
    expect(parsed.spec.rag!.node).toBe('kb-pg');
    expect(parsed.spec.rag!.collection).toBe('docs');
    expect(parsed.spec.rag!.docsGlob).toBe('docs/**/*.md');
    expect(parsed.spec.rag!.schedule).toBeUndefined();
  });

  test('routing record accepts arbitrary task-kind keys', () => {
    const parsed = ProjectSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'Project',
      metadata: { name: 'r' },
      spec: {
        path: '/abs',
        routing: {
          quick_qna: 'private-first',
          code_review: 'mac-mini.claude-pro',
          deep_dive: 'cli:claude-pro',
        },
      },
    });
    expect(parsed.spec.routing.quick_qna).toBe('private-first');
    expect(parsed.spec.routing.code_review).toBe('mac-mini.claude-pro');
    expect(Object.keys(parsed.spec.routing).length).toBe(3);
  });

  test('budget block is optional; cli_calls_per_day enforces non-negative int', () => {
    const parsed = ProjectSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'Project',
      metadata: { name: 'b' },
      spec: {
        path: '/abs',
        budget: {
          usd_per_day: 2.5,
          cli_calls_per_day: { 'claude-pro': 100 },
        },
      },
    });
    expect(parsed.spec.budget!.usd_per_day).toBe(2.5);
    expect(parsed.spec.budget!.cli_calls_per_day!['claude-pro']).toBe(100);

    // Negative cli_calls_per_day is rejected.
    expect(() =>
      ProjectSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'Project',
        metadata: { name: 'b' },
        spec: {
          path: '/abs',
          budget: { cli_calls_per_day: { 'claude-pro': -1 } },
        },
      }),
    ).toThrow();
  });

  test('invalid apiVersion rejected', () => {
    expect(() =>
      ProjectSchema.parse({
        apiVersion: 'llamactl/v2',
        kind: 'Project',
        metadata: { name: 'x' },
        spec: { path: '/abs' },
      }),
    ).toThrow();
  });

  test('invalid kind rejected', () => {
    expect(() =>
      ProjectSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'NotAProject',
        metadata: { name: 'x' },
        spec: { path: '/abs' },
      }),
    ).toThrow();
  });

  test('empty name rejected', () => {
    expect(() =>
      ProjectSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'Project',
        metadata: { name: '' },
        spec: { path: '/abs' },
      }),
    ).toThrow();
  });

  test('empty spec.path rejected', () => {
    expect(() =>
      ProjectSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'Project',
        metadata: { name: 'x' },
        spec: { path: '' },
      }),
    ).toThrow();
  });

  test('rag block requires both node and collection', () => {
    expect(() =>
      ProjectSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'Project',
        metadata: { name: 'x' },
        spec: {
          path: '/abs',
          rag: { node: 'kb-pg' },
        },
      }),
    ).toThrow();
    expect(() =>
      ProjectSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'Project',
        metadata: { name: 'x' },
        spec: {
          path: '/abs',
          rag: { collection: 'docs' },
        },
      }),
    ).toThrow();
  });
});

describe('resolveProjectRouting', () => {
  test('returns declared target when task kind is in policy', () => {
    const project = ProjectSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'Project',
      metadata: { name: 'r' },
      spec: {
        path: '/abs',
        routing: { quick_qna: 'mac-mini.claude-pro' },
      },
    });
    const r = resolveProjectRouting(project, 'quick_qna');
    expect(r.target).toBe('mac-mini.claude-pro');
    expect(r.matched).toBe(true);
  });

  test('falls back to literal "private-first" when no entry matches', () => {
    const project = ProjectSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'Project',
      metadata: { name: 'r' },
      spec: { path: '/abs' },
    });
    const r = resolveProjectRouting(project, 'unknown_kind');
    expect(r.target).toBe('private-first');
    expect(r.matched).toBe(false);
  });

  test('matched=false when routing map is empty', () => {
    const project = ProjectSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'Project',
      metadata: { name: 'r' },
      spec: {
        path: '/abs',
        routing: { code_review: 'cloud-only' },
      },
    });
    const r = resolveProjectRouting(project, 'quick_qna');
    expect(r.target).toBe('private-first');
    expect(r.matched).toBe(false);
  });
});
