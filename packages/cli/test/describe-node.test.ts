import { describe, expect, test } from 'bun:test';
import { renderNodeBudget } from '../src/commands/workload.js';

describe('renderNodeBudget', () => {
  test('renders empty workload list', () => {
    const out = renderNodeBudget({ budget: 16, reserved: 0, workloads: [] });
    expect(out).toContain('Budget:   0.0 / 16.0 GiB');
    expect(out).toContain('Workloads:');
    expect(out).toContain('(none)');
    expect(out).not.toContain('WARNING');
  });

  test('renders two workloads aligned with memory + phase', () => {
    const out = renderNodeBudget({
      budget: 24,
      reserved: 11,
      workloads: [
        {
          name: 'gemma4-26b-a4b-mtp-local',
          endpoint: '127.0.0.1:8181',
          phase: 'Running',
          expectedMemoryGiB: 18,
        },
        {
          name: 'granite41-8b-long-lived-local',
          endpoint: '127.0.0.1:8083',
          phase: 'Pending',
          expectedMemoryGiB: null,
        },
      ],
    });
    expect(out).toContain('Budget:   11.0 / 24.0 GiB');
    expect(out).toMatch(/gemma4-26b-a4b-mtp-local\s+127\.0\.0\.1:8181\s+running\s+18\.0 GiB/);
    expect(out).toMatch(/granite41-8b-long-lived-local\s+127\.0\.0\.1:8083\s+pending\s+-$/m);
  });

  test('budget-exceeded prints the warning', () => {
    const out = renderNodeBudget({
      budget: 16,
      reserved: 22.5,
      workloads: [{ name: 'big', endpoint: null, phase: 'Running', expectedMemoryGiB: 22.5 }],
    });
    expect(out).toContain('WARNING: budget exceeded (22.5 > 16.0 GiB)');
  });
});
