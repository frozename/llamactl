import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addSchedule,
  isDue,
  loadSchedules,
  removeSchedule,
  saveSchedules,
  updateSchedule,
  type BenchSchedule,
} from '../src/bench/schedule.js';

/**
 * Round-trip + dueness checks for the bench scheduler store. The
 * scheduler loop itself is covered indirectly via the router e2e
 * suite once a schedule fires; this test stays at the unit level.
 */

let tmp = '';
function makeScheduleFile(): string {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-benchsched-'));
  return join(tmp, 'schedules.yaml');
}

beforeEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('bench schedule store', () => {
  test('round-trips through YAML save + load', () => {
    const path = makeScheduleFile();
    const entry = {
      id: 's1',
      node: 'local',
      rel: 'org/repo/model-Q4.gguf',
      mode: 'auto' as const,
      intervalSeconds: 86_400,
      enabled: true,
    };
    saveSchedules(addSchedule([], entry), path);
    const loaded = loadSchedules(path);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe('s1');
    expect(loaded[0]!.node).toBe('local');
    expect(loaded[0]!.intervalSeconds).toBe(86_400);
    expect(loaded[0]!.lastRunAt).toBeNull();
  });

  test('duplicate id is rejected', () => {
    const entry = {
      id: 'dup',
      node: 'local',
      rel: 'x/y.gguf',
      mode: 'auto' as const,
      intervalSeconds: 3600,
      enabled: true,
    };
    const once = addSchedule([], entry);
    expect(() => addSchedule(once, entry)).toThrow(/already exists/);
  });

  test('removeSchedule + updateSchedule behave as expected', () => {
    const a: BenchSchedule = {
      id: 'a',
      node: 'local',
      rel: 'a/a.gguf',
      mode: 'auto',
      intervalSeconds: 3600,
      enabled: true,
      lastRunAt: null,
      lastError: null,
    };
    const b: BenchSchedule = { ...a, id: 'b', rel: 'b/b.gguf' };
    const seeded = [a, b];
    expect(removeSchedule(seeded, 'a')).toHaveLength(1);
    expect(updateSchedule(seeded, 'a', { enabled: false })[0]!.enabled).toBe(false);
    // `id` cannot be mutated through updateSchedule.
    expect(updateSchedule(seeded, 'a', { id: 'nope' } as Partial<BenchSchedule>)[0]!.id).toBe('a');
  });

  test('isDue returns true for fresh schedules and elapsed intervals', () => {
    const now = 2_000_000_000_000;
    const fresh: BenchSchedule = {
      id: 'f',
      node: 'local',
      rel: 'f/f.gguf',
      mode: 'auto',
      intervalSeconds: 60,
      enabled: true,
      lastRunAt: null,
      lastError: null,
    };
    expect(isDue(fresh, now)).toBe(true);

    const recent = { ...fresh, lastRunAt: new Date(now - 30 * 1000).toISOString() };
    expect(isDue(recent, now)).toBe(false);

    const elapsed = { ...fresh, lastRunAt: new Date(now - 120 * 1000).toISOString() };
    expect(isDue(elapsed, now)).toBe(true);

    const disabled = { ...fresh, enabled: false };
    expect(isDue(disabled, now)).toBe(false);
  });
});
