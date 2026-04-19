import { describe, expect, test } from 'bun:test';
import { runPlan } from '../src/commands/plan.js';

/**
 * CLI smoke tests for `llamactl plan`. Exercises:
 *   - --help renders USAGE.
 *   - --stub --auto produces a plan end-to-end (no real model).
 *   - --json --stub emits parseable JSON.
 *   - --model requirement without --stub.
 *
 * We capture stdout/stderr per-test rather than forking a subprocess;
 * the underlying planner + executor are all pure + injectable.
 */

function captureWrites(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  target: any,
): { restore: () => void; output: () => string } {
  const chunks: string[] = [];
  const original = target.write.bind(target);
  target.write = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  return {
    restore: () => {
      target.write = original;
    },
    output: () => chunks.join(''),
  };
}

describe('llamactl plan', () => {
  test('no args prints USAGE and exits 0', async () => {
    const stdout = captureWrites(process.stdout);
    try {
      const code = await runPlan([]);
      expect(code).toBe(0);
      expect(stdout.output()).toContain('USAGE');
    } finally {
      stdout.restore();
    }
  });

  test('unknown subcommand → non-zero + usage to stderr', async () => {
    const stderr = captureWrites(process.stderr);
    try {
      const code = await runPlan(['bogus']);
      expect(code).toBe(1);
      expect(stderr.output()).toContain('unknown subcommand bogus');
    } finally {
      stderr.restore();
    }
  });

  test('run without goal → non-zero + usage', async () => {
    const stderr = captureWrites(process.stderr);
    try {
      const code = await runPlan(['run']);
      expect(code).toBe(1);
      expect(stderr.output()).toContain('goal is required');
    } finally {
      stderr.restore();
    }
  });

  test('run without --stub and without --model → fatal', async () => {
    const stderr = captureWrites(process.stderr);
    try {
      const code = await runPlan(['run', 'hello']);
      expect(code).toBe(1);
      expect(stderr.output()).toContain('--model is required');
    } finally {
      stderr.restore();
    }
  });

  test('run --stub --auto --json produces a valid plan envelope', async () => {
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);
    try {
      const code = await runPlan(['run', 'list everything', '--stub', '--auto', '--json']);
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout.output()) as {
        executor: string;
        toolsAvailable: string[];
        plan: {
          steps: Array<{ tool: string; annotation: string }>;
          reasoning: string;
        };
      };
      expect(parsed.executor).toBe('stub');
      expect(parsed.plan.steps).toHaveLength(1);
      // Harness enumerates tools from llamactl-mcp + nova-mcp; stub
      // picks the first allowlisted tool — whichever alphabetical
      // entry that is — and the post-validation gate is satisfied.
      expect(parsed.toolsAvailable.length).toBeGreaterThan(0);
      expect(parsed.toolsAvailable).toContain(parsed.plan.steps[0]!.tool);
    } finally {
      stdout.restore();
      stderr.restore();
    }
  }, 20_000);

  test('run --stub --auto (pretty render) prints reasoning + step count', async () => {
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);
    try {
      const code = await runPlan(['run', 'hello', '--stub', '--auto']);
      expect(code).toBe(0);
      const err = stderr.output();
      expect(err).toContain('executor: stub');
      expect(err).toContain('steps (1)');
      expect(err).toContain('reasoning:');
    } finally {
      stdout.restore();
      stderr.restore();
    }
  }, 20_000);
});
