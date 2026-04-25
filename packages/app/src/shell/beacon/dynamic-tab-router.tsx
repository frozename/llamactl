import * as React from 'react';
import { WorkloadDetail, NodeDetail, OpsSessionDetail } from '@/modules/ops/detail';
import type { TabEntry } from '@/stores/tab-store';
import { dispatchTab } from './tab-dispatch';

/**
 * Render the right detail component for a non-module tab. Dispatches
 * on TabKind — the tabKey prefix carries the same information but
 * `kind` is the authoritative field in the tab store.
 */
export function DynamicTabRouter({ tab }: { tab: TabEntry }): React.JSX.Element | null {
  const d = dispatchTab(tab);
  if (!d) return null;
  if (d.kind === 'workload') return <WorkloadDetail workloadId={d.instanceId} />;
  if (d.kind === 'node') return <NodeDetail nodeName={d.instanceId} />;
  return <OpsSessionDetail sessionId={d.instanceId} />;
}
