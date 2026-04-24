import * as React from 'react';
import { WorkloadDetail, NodeDetail, OpsSessionDetail } from '@/modules/ops/detail';
import type { TabEntry } from '@/stores/tab-store';

/**
 * Render the right detail component for a non-module tab. Dispatches
 * on TabKind — the tabKey prefix carries the same information but
 * `kind` is the authoritative field in the tab store.
 */
export function DynamicTabRouter({ tab }: { tab: TabEntry }): React.JSX.Element | null {
  if (tab.kind === 'workload' && tab.instanceId) {
    return <WorkloadDetail workloadId={tab.instanceId} />;
  }
  if (tab.kind === 'node' && tab.instanceId) {
    return <NodeDetail nodeName={tab.instanceId} />;
  }
  if (tab.kind === 'ops-session' && tab.instanceId) {
    return <OpsSessionDetail sessionId={tab.instanceId} />;
  }
  return null;
}
