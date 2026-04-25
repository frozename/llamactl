import type { TabEntry } from '@/stores/tab-store';

export interface SessionBuckets {
  today: TabEntry[];
  earlier: TabEntry[];
  older: TabEntry[];
}

const ONE_DAY_MS = 24 * 3_600_000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

/** Pure — exported so the bucketing is unit-testable without rendering. */
export function bucketTabsByAge(
  tabs: readonly TabEntry[],
  closed: readonly TabEntry[],
  now: number,
): SessionBuckets {
  const all = [...tabs, ...closed].sort((a, b) => b.openedAt - a.openedAt);
  const today: TabEntry[] = [];
  const earlier: TabEntry[] = [];
  const older: TabEntry[] = [];
  for (const t of all) {
    const age = now - t.openedAt;
    if (age < ONE_DAY_MS) today.push(t);
    else if (age < ONE_WEEK_MS) earlier.push(t);
    else older.push(t);
  }
  return { today, earlier, older };
}
