import type { TabEntry } from '@/stores/tab-store';

export type TabDispatch =
  | { kind: 'workload'; instanceId: string }
  | { kind: 'node'; instanceId: string }
  | { kind: 'ops-session'; instanceId: string }
  | null;

/** Pure — exported so the dispatch table is unit-testable without
 *  pulling in the lazy detail components. */
export function dispatchTab(tab: TabEntry): TabDispatch {
  if (tab.kind === 'workload' && tab.instanceId) {
    return { kind: 'workload', instanceId: tab.instanceId };
  }
  if (tab.kind === 'node' && tab.instanceId) {
    return { kind: 'node', instanceId: tab.instanceId };
  }
  if (tab.kind === 'ops-session' && tab.instanceId) {
    return { kind: 'ops-session', instanceId: tab.instanceId };
  }
  return null;
}
