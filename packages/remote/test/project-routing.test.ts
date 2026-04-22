import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import {
  appendProjectRoutingJournal,
  defaultProjectRoutingJournalPath,
  packRouteForUsage,
  parseProjectNodeName,
  resolveProjectNodeTarget,
  type BudgetSnapshot,
  type ProjectRoutingDecision,
} from '../src/config/project-routing.js';
import type { Project } from '../src/config/projects.js';
import { ProjectSchema } from '../src/config/projects.js';

function makeProject(overrides: Partial<Project['spec']> = {}): Project {
  return ProjectSchema.parse({
    apiVersion: 'llamactl/v1',
    kind: 'Project',
    metadata: { name: 'novaflow' },
    spec: {
      path: '/Users/me/DevStorage/repos/work/novaflow',
      routing: {
        quick_qna: 'private-first',
        code_review: 'mac-mini.claude-pro',
      },
      ...overrides,
    },
  });
}

describe('parseProjectNodeName', () => {
  test('accepts project:<name>/<taskKind>', () => {
    expect(parseProjectNodeName('project:novaflow/quick_qna')).toEqual({
      project: 'novaflow',
      taskKind: 'quick_qna',
    });
  });
  test('rejects non-project prefix', () => {
    expect(parseProjectNodeName('mac-mini.claude-pro')).toBeNull();
    expect(parseProjectNodeName('private-first')).toBeNull();
    expect(parseProjectNodeName('')).toBeNull();
  });
  test('rejects malformed shapes (missing slash, empty halves)', () => {
    expect(parseProjectNodeName('project:novaflow')).toBeNull();
    expect(parseProjectNodeName('project:/quick_qna')).toBeNull();
    expect(parseProjectNodeName('project:novaflow/')).toBeNull();
  });
});

describe('resolveProjectNodeTarget — passthrough', () => {
  test('non-project node name returns unchanged + decision: null', async () => {
    const out = await resolveProjectNodeTarget('mac-mini.claude-pro');
    expect(out.node).toBe('mac-mini.claude-pro');
    expect(out.decision).toBeNull();
  });
});

describe('resolveProjectNodeTarget — project matches', () => {
  test('matched taskKind rewrites node + decision.reason=matched', async () => {
    const project = makeProject();
    const out = await resolveProjectNodeTarget('project:novaflow/code_review', {
      loadProjects: () => [project],
      now: () => Date.UTC(2026, 3, 22, 12, 0, 0),
    });
    expect(out.node).toBe('mac-mini.claude-pro');
    expect(out.decision).not.toBeNull();
    expect(out.decision!.reason).toBe('matched');
    expect(out.decision!.matched).toBe(true);
    expect(out.decision!.project).toBe('novaflow');
    expect(out.decision!.taskKind).toBe('code_review');
    expect(out.decision!.target).toBe('mac-mini.claude-pro');
    expect(out.decision!.ts).toBe('2026-04-22T12:00:00.000Z');
  });
  test('unknown taskKind falls back to private-first + reason=fallback-default', async () => {
    const project = makeProject();
    const out = await resolveProjectNodeTarget(
      'project:novaflow/unseen_task',
      { loadProjects: () => [project] },
    );
    expect(out.node).toBe('private-first');
    expect(out.decision!.reason).toBe('fallback-default');
    expect(out.decision!.matched).toBe(false);
  });
});

describe('resolveProjectNodeTarget — project not found', () => {
  test('stale project name falls back to private-first + reason=project-not-found', async () => {
    const out = await resolveProjectNodeTarget('project:ghost/quick_qna', {
      loadProjects: () => [],
    });
    expect(out.node).toBe('private-first');
    expect(out.decision!.reason).toBe('project-not-found');
    expect(out.decision!.matched).toBe(false);
  });
});

describe('resolveProjectNodeTarget — budget check', () => {
  test('over-budget flips the decision to private-first with reason=over-budget', async () => {
    const project = makeProject({ budget: { usd_per_day: 1.0 } });
    const out = await resolveProjectNodeTarget(
      'project:novaflow/code_review',
      {
        loadProjects: () => [project],
        checkBudget: async () => ({
          usdToday: 1.25,
          usdLimit: 1.0,
        } satisfies BudgetSnapshot),
      },
    );
    expect(out.node).toBe('private-first');
    expect(out.decision!.reason).toBe('over-budget');
    // Preserve the declared match so operators see what WOULD have
    // been routed — the budget just overrode it.
    expect(out.decision!.matched).toBe(true);
    expect(out.decision!.budget?.usdToday).toBeCloseTo(1.25, 6);
    expect(out.decision!.budget?.limit).toBeCloseTo(1.0, 6);
  });
  test('under-budget keeps the matched decision unchanged', async () => {
    const project = makeProject({ budget: { usd_per_day: 1.0 } });
    const out = await resolveProjectNodeTarget(
      'project:novaflow/code_review',
      {
        loadProjects: () => [project],
        checkBudget: async () => ({ usdToday: 0.5, usdLimit: 1.0 }),
      },
    );
    expect(out.node).toBe('mac-mini.claude-pro');
    expect(out.decision!.reason).toBe('matched');
  });
  test('broken budget snapshotter does not block the dispatch', async () => {
    const project = makeProject({ budget: { usd_per_day: 1.0 } });
    const out = await resolveProjectNodeTarget(
      'project:novaflow/code_review',
      {
        loadProjects: () => [project],
        checkBudget: async () => {
          throw new Error('cost-guardian unreachable');
        },
      },
    );
    // Original target preserved; the routing path does NOT fail
    // because cost-guardian is down.
    expect(out.node).toBe('mac-mini.claude-pro');
    expect(out.decision!.reason).toBe('matched');
  });
  test('budget block with no USD limit is not evaluated', async () => {
    const project = makeProject({
      budget: { cli_calls_per_day: { 'claude-pro': 500 } },
    });
    let called = false;
    const out = await resolveProjectNodeTarget(
      'project:novaflow/code_review',
      {
        loadProjects: () => [project],
        checkBudget: async () => {
          called = true;
          return { usdToday: 999, usdLimit: 1 };
        },
      },
    );
    expect(called).toBe(false);
    expect(out.decision!.reason).toBe('matched');
  });
});

describe('decision journal', () => {
  let tmp = '';
  const originalEnv = { ...process.env };
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'llamactl-project-routing-'));
    process.env = {
      ...originalEnv,
      LLAMACTL_PROJECT_ROUTING_JOURNAL: join(tmp, 'project-routing.jsonl'),
    };
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  test('append writes a JSONL line with the decision record', async () => {
    const decision: ProjectRoutingDecision = {
      ts: '2026-04-22T12:00:00.000Z',
      project: 'novaflow',
      taskKind: 'code_review',
      target: 'mac-mini.claude-pro',
      matched: true,
      reason: 'matched',
    };
    await appendProjectRoutingJournal(decision);
    const path = defaultProjectRoutingJournalPath();
    const raw = readFileSync(path, 'utf8').trim();
    const parsed = JSON.parse(raw);
    expect(parsed.project).toBe('novaflow');
    expect(parsed.target).toBe('mac-mini.claude-pro');
    expect(parsed.reason).toBe('matched');
  });

  test('append tolerates IO errors (non-throwing)', async () => {
    // Point the journal at a path inside a read-only dir that we
    // can't create. The appender should swallow + continue.
    process.env = {
      ...originalEnv,
      LLAMACTL_PROJECT_ROUTING_JOURNAL:
        '/this/path/definitely/cannot/be/created/by/test/journal.jsonl',
    };
    const decision: ProjectRoutingDecision = {
      ts: new Date().toISOString(),
      project: 'x',
      taskKind: 'y',
      target: 'private-first',
      matched: false,
      reason: 'fallback-default',
    };
    // Must not throw.
    await appendProjectRoutingJournal(decision);
  });
});

describe('packRouteForUsage', () => {
  test('packs decision into a stable route string', () => {
    const decision: ProjectRoutingDecision = {
      ts: '2026-04-22T12:00:00.000Z',
      project: 'novaflow',
      taskKind: 'code_review',
      target: 'mac-mini.claude-pro',
      matched: true,
      reason: 'matched',
    };
    expect(packRouteForUsage(decision)).toBe(
      'project:novaflow/code_review/mac-mini.claude-pro',
    );
  });
});

describe('loadProjects file-backed resolution', () => {
  let tmp = '';
  const originalEnv = { ...process.env };
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'llamactl-project-routing-file-'));
    process.env = {
      ...originalEnv,
      LLAMACTL_PROJECTS_FILE: join(tmp, 'projects.yaml'),
    };
    const yaml = stringifyYaml({
      apiVersion: 'llamactl/v1',
      kind: 'ProjectList',
      projects: [makeProject()],
    });
    writeFileSync(join(tmp, 'projects.yaml'), yaml, 'utf8');
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });
  test('resolves against the file at LLAMACTL_PROJECTS_FILE when no loader is injected', async () => {
    const out = await resolveProjectNodeTarget('project:novaflow/code_review');
    expect(out.node).toBe('mac-mini.claude-pro');
    expect(out.decision!.matched).toBe(true);
  });
});
