import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeClient } from '@llamactl/remote';
import { parse as parseYaml } from 'yaml';
import { runProject } from '../src/commands/project.js';
import {
  __setProjectTestSeams,
  __resetProjectTestSeams,
} from '../src/commands/project.js';

/**
 * CLI coverage for `llamactl project …`. Tests run against a stubbed
 * NodeClient (no tRPC round-trip) — each subcommand asserts that
 * flags + payloads land at the right procedure and that the stdout
 * rendering matches the operator-facing format.
 */

interface Captured {
  out: string;
  err: string;
}

function captureStdio<T>(fn: () => Promise<T>): Promise<{ result: T; cap: Captured }> {
  const chunks: Captured = { out: '', err: '' };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (s: string | Uint8Array): boolean => {
    chunks.out += typeof s === 'string' ? s : String(s);
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (s: string | Uint8Array): boolean => {
    chunks.err += typeof s === 'string' ? s : String(s);
    return true;
  };
  return fn()
    .then((result) => ({ result, cap: chunks }))
    .finally(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = origOut;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = origErr;
    });
}

interface StubProcs {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  projectApply: (i: { manifestYaml: string }) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  projectList: () => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  projectGet: (i: { name: string }) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  projectRemove: (i: { name: string }) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  projectIndex: (i: { name: string }) => Promise<any>;
  projectResolveRouting: (i: {
    project: string;
    taskKind: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) => Promise<any>;
}

function makeStubClient(overrides: Partial<StubProcs> = {}): NodeClient {
  const stubs: StubProcs = {
    projectApply: async () => ({
      ok: true,
      name: 'test',
      path: '/tmp/projects.yaml',
      created: true,
    }),
    projectList: async () => ({
      ok: true,
      projects: [
        {
          apiVersion: 'llamactl/v1',
          kind: 'Project',
          metadata: { name: 'demo' },
          spec: {
            path: '/abs/demo',
            stack: ['typescript'],
            routing: { quick_qna: 'private-first' },
            rag: { node: 'kb-pg', collection: 'demo_docs', docsGlob: 'docs/**/*.md' },
          },
        },
      ],
    }),
    projectGet: async ({ name }) => ({
      ok: true,
      project: {
        apiVersion: 'llamactl/v1',
        kind: 'Project',
        metadata: { name },
        spec: {
          path: `/abs/${name}`,
          stack: [],
          routing: {},
        },
      },
    }),
    projectRemove: async () => ({ ok: true, removed: true }),
    projectIndex: async ({ name }) => ({
      ok: true,
      pipelineName: `project-${name}`,
      path: `/tmp/rag-pipelines/project-${name}/spec.yaml`,
      created: true,
    }),
    projectResolveRouting: async ({ project, taskKind }) => ({
      ok: true,
      project,
      taskKind,
      target: 'mac-mini.claude-pro',
      matched: true,
    }),
    ...overrides,
  };
  return {
    projectApply: { mutate: stubs.projectApply },
    projectList: { query: stubs.projectList },
    projectGet: { query: stubs.projectGet },
    projectRemove: { mutate: stubs.projectRemove },
    projectIndex: { mutate: stubs.projectIndex },
    projectResolveRouting: { query: stubs.projectResolveRouting },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as NodeClient;
}

let tmp = '';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-project-'));
  __setProjectTestSeams({ nodeClient: makeStubClient() });
});

afterEach(() => {
  __resetProjectTestSeams();
  rmSync(tmp, { recursive: true, force: true });
});

describe('project — help + unknown', () => {
  test('no subcommand prints USAGE + exit 0', async () => {
    const { result, cap } = await captureStdio(() => runProject([]));
    expect(result).toBe(0);
    expect(cap.out).toContain('Usage: llamactl project');
  });

  test('unknown subcommand → exit 1', async () => {
    const { result, cap } = await captureStdio(() => runProject(['bogus']));
    expect(result).toBe(1);
    expect(cap.err).toContain('Unknown project subcommand');
  });
});

describe('project add', () => {
  test('missing name → exit 1', async () => {
    const { result, cap } = await captureStdio(() => runProject(['add']));
    expect(result).toBe(1);
    expect(cap.err).toContain('<name> is required');
  });

  test('missing --path → exit 1', async () => {
    const { result, cap } = await captureStdio(() =>
      runProject(['add', 'foo']),
    );
    expect(result).toBe(1);
    expect(cap.err).toContain('--path is required');
  });

  test('partial rag flags → exit 1', async () => {
    const { result, cap } = await captureStdio(() =>
      runProject(['add', 'foo', '--path', '/abs', '--rag-node', 'kb-pg']),
    );
    expect(result).toBe(1);
    expect(cap.err).toContain('--rag-node and --rag-collection must be set together');
  });

  test('happy path builds + applies a Project manifest', async () => {
    let sawYaml = '';
    __setProjectTestSeams({
      nodeClient: makeStubClient({
        projectApply: async (i) => {
          sawYaml = i.manifestYaml;
          return { ok: true, name: 'novaflow', path: '/tmp/projects.yaml', created: true };
        },
      }),
    });
    const { result, cap } = await captureStdio(() =>
      runProject([
        'add',
        'novaflow',
        '--path',
        '/abs/novaflow',
        '--purpose',
        'NestJS monorepo',
        '--stack',
        'nestjs,nextjs',
        '--rag-node',
        'kb-chroma',
        '--rag-collection',
        'novaflow_docs',
        '--route',
        'quick_qna=private-first',
        '--route',
        'code_review=mac-mini.claude-pro',
      ]),
    );
    expect(result).toBe(0);
    expect(cap.out).toContain("applied project 'novaflow'");
    const parsed = parseYaml(sawYaml) as {
      apiVersion: string;
      kind: string;
      metadata: { name: string };
      spec: {
        path: string;
        purpose?: string;
        stack?: string[];
        rag?: { node: string; collection: string };
        routing?: Record<string, string>;
      };
    };
    expect(parsed.apiVersion).toBe('llamactl/v1');
    expect(parsed.kind).toBe('Project');
    expect(parsed.metadata.name).toBe('novaflow');
    expect(parsed.spec.path).toBe('/abs/novaflow');
    expect(parsed.spec.purpose).toBe('NestJS monorepo');
    expect(parsed.spec.stack).toEqual(['nestjs', 'nextjs']);
    expect(parsed.spec.rag!.node).toBe('kb-chroma');
    expect(parsed.spec.rag!.collection).toBe('novaflow_docs');
    expect(parsed.spec.routing!.quick_qna).toBe('private-first');
    expect(parsed.spec.routing!.code_review).toBe('mac-mini.claude-pro');
  });

  test('bad --route syntax → exit 1', async () => {
    const { result, cap } = await captureStdio(() =>
      runProject([
        'add',
        'x',
        '--path',
        '/abs',
        '--route',
        'missing-equals',
      ]),
    );
    expect(result).toBe(1);
    expect(cap.err).toContain('--route expects <taskKind>=<target>');
  });
});

describe('project apply', () => {
  test('missing -f → exit 1', async () => {
    const { result, cap } = await captureStdio(() => runProject(['apply']));
    expect(result).toBe(1);
    expect(cap.err).toContain('-f <file.yaml> is required');
  });

  test('file not on disk → exit 1', async () => {
    const { result, cap } = await captureStdio(() =>
      runProject(['apply', '-f', '/nope/no-such.yaml']),
    );
    expect(result).toBe(1);
    expect(cap.err).toContain('file not found');
  });

  test('happy path forwards raw YAML', async () => {
    const p = join(tmp, 'project.yaml');
    writeFileSync(
      p,
      'apiVersion: llamactl/v1\nkind: Project\nmetadata:\n  name: piped\nspec:\n  path: /abs/piped\n',
    );
    const { result, cap } = await captureStdio(() =>
      runProject(['apply', '-f', p]),
    );
    expect(result).toBe(0);
    expect(cap.out).toContain("applied project 'test'");
  });
});

describe('project list', () => {
  test('prints one row per project', async () => {
    const { result, cap } = await captureStdio(() => runProject(['list']));
    expect(result).toBe(0);
    expect(cap.out).toContain('demo');
    expect(cap.out).toContain('/abs/demo');
    expect(cap.out).toContain('rag=kb-pg/demo_docs');
    expect(cap.out).toContain('routes=1');
  });

  test('empty registry → informative message', async () => {
    __setProjectTestSeams({
      nodeClient: makeStubClient({
        projectList: async () => ({ ok: true, projects: [] }),
      }),
    });
    const { cap } = await captureStdio(() => runProject(['list']));
    expect(cap.out).toContain('no projects registered');
  });

  test('--json emits structured doc', async () => {
    const { cap } = await captureStdio(() => runProject(['list', '--json']));
    const parsed = JSON.parse(cap.out.trim());
    expect(Array.isArray(parsed.projects)).toBe(true);
  });
});

describe('project get', () => {
  test('prints manifest as YAML', async () => {
    const { result, cap } = await captureStdio(() =>
      runProject(['get', 'demo']),
    );
    expect(result).toBe(0);
    expect(cap.out).toContain('apiVersion: llamactl/v1');
    expect(cap.out).toContain('kind: Project');
  });

  test('missing name → exit 1', async () => {
    const { result, cap } = await captureStdio(() => runProject(['get']));
    expect(result).toBe(1);
    expect(cap.err).toContain('<name> is required');
  });

  test('--json emits JSON', async () => {
    const { cap } = await captureStdio(() =>
      runProject(['get', 'demo', '--json']),
    );
    const parsed = JSON.parse(cap.out.trim());
    expect(parsed.metadata.name).toBe('demo');
  });
});

describe('project rm', () => {
  test('happy path', async () => {
    const { result, cap } = await captureStdio(() =>
      runProject(['rm', 'demo']),
    );
    expect(result).toBe(0);
    expect(cap.out).toContain("removed project 'demo'");
  });

  test('not found → exit 1', async () => {
    __setProjectTestSeams({
      nodeClient: makeStubClient({
        projectRemove: async () => ({ ok: true, removed: false }),
      }),
    });
    const { result, cap } = await captureStdio(() =>
      runProject(['rm', 'ghost']),
    );
    expect(result).toBe(1);
    expect(cap.err).toContain('not found');
  });
});

describe('project index', () => {
  test('missing name → exit 1', async () => {
    const { result, cap } = await captureStdio(() => runProject(['index']));
    expect(result).toBe(1);
    expect(cap.err).toContain('<name> is required');
  });

  test('happy path reports the generated pipeline name', async () => {
    const { result, cap } = await captureStdio(() =>
      runProject(['index', 'novaflow']),
    );
    expect(result).toBe(0);
    expect(cap.out).toContain("indexed project 'novaflow'");
    expect(cap.out).toContain('pipeline: project-novaflow');
    expect(cap.out).toContain('llamactl rag pipeline run project-novaflow');
  });
});

describe('project route', () => {
  test('missing name → exit 1', async () => {
    const { result, cap } = await captureStdio(() => runProject(['route']));
    expect(result).toBe(1);
    expect(cap.err).toContain('<name> is required');
  });

  test('missing taskKind → exit 1', async () => {
    const { result, cap } = await captureStdio(() =>
      runProject(['route', 'demo']),
    );
    expect(result).toBe(1);
    expect(cap.err).toContain('<taskKind> is required');
  });

  test('prints target + matched label for a declared policy entry', async () => {
    const { result, cap } = await captureStdio(() =>
      runProject(['route', 'demo', 'quick_qna']),
    );
    expect(result).toBe(0);
    expect(cap.out).toContain('demo/quick_qna → mac-mini.claude-pro (matched)');
  });

  test('prints default label when policy falls back', async () => {
    __setProjectTestSeams({
      nodeClient: makeStubClient({
        projectResolveRouting: async ({ project, taskKind }) => ({
          ok: true,
          project,
          taskKind,
          target: 'private-first',
          matched: false,
        }),
      }),
    });
    const { result, cap } = await captureStdio(() =>
      runProject(['route', 'demo', 'never_heard_of']),
    );
    expect(result).toBe(0);
    expect(cap.out).toContain('demo/never_heard_of → private-first (default)');
  });
});
