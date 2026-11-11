/**
 * #221: physical-node grouping plus a bounded pool, so one slow or
 * unreachable node cannot delay the others in a controller reconcile
 * pass. Items that touch the same physical node (coordinator or worker,
 * transitively) stay in one serial group — the port race and the
 * rpc-server worker race need that — while distinct groups run
 * concurrently up to a fixed bound.
 */

export const DEFAULT_RECONCILE_NODE_CONCURRENCY = 4;

/** Clamp a caller-supplied bound into a usable worker count; absent or
 *  non-finite input falls back to the default. */
export function normalizeNodeConcurrency(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_RECONCILE_NODE_CONCURRENCY;
  return Math.max(1, Math.floor(n));
}

/** Union-find root lookup with path compression over a parent array. */
function findRoot(parent: number[], i: number): number {
  const point = parent[i];
  if (point === undefined || point === i) return i;
  const root = findRoot(parent, point);
  parent[i] = root;
  return root;
}

/** Union every item into `parent` through its node keys; true when any
 *  item reported a null key list, which merges everything into one group. */
function unionItemKeys<T>(
  items: readonly T[],
  keysOf: (item: T) => readonly string[] | null,
  parent: number[],
): boolean {
  const firstSeen = new Map<string, number>();
  let mergesAll = false;
  for (const [index, item] of items.entries()) {
    const keys = keysOf(item);
    if (keys === null) {
      mergesAll = true;
      continue;
    }
    for (const key of keys) {
      const seen = firstSeen.get(key);
      if (seen === undefined) firstSeen.set(key, index);
      else parent[findRoot(parent, seen)] = findRoot(parent, index);
    }
  }
  return mergesAll;
}

/** Collect the union-find components as index lists ordered by smallest
 *  index, indices ascending inside each component. */
function collectComponents(parent: number[]): number[][] {
  const byRoot = new Map<number, number[]>();
  for (const [index] of parent.entries()) {
    const root = findRoot(parent, index);
    const group = byRoot.get(root);
    if (group === undefined) byRoot.set(root, [index]);
    else group.push(index);
  }
  const groups = [...byRoot.values()];
  groups.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  for (const group of groups) group.sort((a, b) => a - b);
  return groups;
}

/**
 * Union-find over node keys: item i and item j share a group when a key
 * (a resolved physical-node identity) touches both, transitively. A null
 * key list (unknown node) merges every item into ONE group; an empty key
 * list is that item's own singleton. Groups are ordered by their smallest
 * item index, indices ascending inside each group.
 */
export function groupByNodes<T>(
  items: readonly T[],
  keysOf: (item: T) => readonly string[] | null,
): number[][] {
  const parent = items.map((_, index) => index);
  if (unionItemKeys(items, keysOf, parent)) {
    return items.length === 0 ? [] : [Array.from({ length: items.length }, (_u, i) => i)];
  }
  return collectComponents(parent);
}

/**
 * Run every group through a pool of at most `concurrency` workers,
 * started synchronously in group order with no await before the first
 * worker calls `run`. Workers pull the next group from a shared cursor
 * and await that group's indices strictly in order. A rejection at one
 * index does not stop the other groups; the first error is rethrown only
 * after every worker has finished.
 */
export async function runNodeGroups(
  groups: readonly (readonly number[])[],
  concurrency: number,
  run: (index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  let firstError: Error | undefined;
  const worker = async (): Promise<void> => {
    while (cursor < groups.length) {
      const groupIndex = cursor;
      cursor += 1;
      const group = groups[groupIndex];
      if (group === undefined) continue;
      for (const index of group) {
        try {
          await run(index);
        } catch (err) {
          firstError ??= err instanceof Error ? err : new Error(String(err));
        }
      }
    }
  };
  const started = Array.from({ length: Math.min(concurrency, groups.length) }, () => worker());
  await Promise.all(started);
  if (firstError !== undefined) throw firstError;
}
