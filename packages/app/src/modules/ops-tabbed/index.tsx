import * as React from 'react';
import { lazy } from 'react';
import { TabbedModule } from '@/shell/tabbed-module';

/**
 * Ops Chat page — the tool-calling conversation + the one-shot
 * planner side by side. Planner is the read-only "what would you
 * do" surface; Ops Chat is the mutation loop. Sharing a tab strip
 * groups them under the same operator-console umbrella.
 */

const OpsChatTab = lazy(() => import('../ops-chat/index'));
const PlanTab = lazy(() => import('../plan/index'));

export default function OpsPage(): React.JSX.Element {
  return (
    <TabbedModule
      moduleId="ops-page"
      title="Ops Console"
      subtitle="Tool-calling conversation + one-shot planner."
      tabs={[
        { id: 'chat', label: 'Ops Chat', Component: OpsChatTab },
        { id: 'plan', label: 'Planner', Component: PlanTab },
      ]}
    />
  );
}
