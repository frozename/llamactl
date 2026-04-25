import { describe, test, expect } from 'bun:test';
import { bucketTabsByAge } from '../../../src/shell/beacon/session-buckets';
import type { TabEntry } from '../../../src/stores/tab-store';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function tab(key: string, openedAt: number): TabEntry {
  return { tabKey: key, title: key, kind: 'module', openedAt };
}

describe('bucketTabsByAge', () => {
  test('1h ago lands in Today', () => {
    const t = tab('a', NOW - HOUR);
    const { today, earlier, older } = bucketTabsByAge([t], [], NOW);
    expect(today.map((x) => x.tabKey)).toEqual(['a']);
    expect(earlier).toEqual([]);
    expect(older).toEqual([]);
  });

  test('25h ago lands in Earlier this week', () => {
    const t = tab('b', NOW - 25 * HOUR);
    const { today, earlier, older } = bucketTabsByAge([t], [], NOW);
    expect(today).toEqual([]);
    expect(earlier.map((x) => x.tabKey)).toEqual(['b']);
    expect(older).toEqual([]);
  });

  test('8 days ago lands in Older', () => {
    const t = tab('c', NOW - 8 * DAY);
    const { today, earlier, older } = bucketTabsByAge([t], [], NOW);
    expect(today).toEqual([]);
    expect(earlier).toEqual([]);
    expect(older.map((x) => x.tabKey)).toEqual(['c']);
  });

  test('boundary at 24h is Earlier (age >= 24h falls out of Today)', () => {
    const t = tab('boundary', NOW - DAY);
    const { today, earlier } = bucketTabsByAge([t], [], NOW);
    expect(today).toEqual([]);
    expect(earlier.map((x) => x.tabKey)).toEqual(['boundary']);
  });

  test('empty input returns three empty buckets', () => {
    const { today, earlier, older } = bucketTabsByAge([], [], NOW);
    expect(today).toEqual([]);
    expect(earlier).toEqual([]);
    expect(older).toEqual([]);
  });

  test('merges open tabs with closed LRU and sorts by openedAt desc', () => {
    const open1 = tab('open-old', NOW - 10 * HOUR);
    const open2 = tab('open-new', NOW - 1 * HOUR);
    const closedTab = tab('closed', NOW - 3 * HOUR);
    const { today } = bucketTabsByAge([open1, open2], [closedTab], NOW);
    expect(today.map((x) => x.tabKey)).toEqual(['open-new', 'closed', 'open-old']);
  });

  test('mixed-age inputs split correctly across all three buckets', () => {
    const a = tab('a', NOW - 2 * HOUR);
    const b = tab('b', NOW - 30 * HOUR);
    const c = tab('c', NOW - 14 * DAY);
    const { today, earlier, older } = bucketTabsByAge([a, b, c], [], NOW);
    expect(today.map((x) => x.tabKey)).toEqual(['a']);
    expect(earlier.map((x) => x.tabKey)).toEqual(['b']);
    expect(older.map((x) => x.tabKey)).toEqual(['c']);
  });
});
