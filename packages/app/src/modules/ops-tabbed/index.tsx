import * as React from 'react';
import { lazy } from 'react';
import { TabbedModule } from '@/shell/tabbed-module';
import { OpsExecutorPicker } from './ops-executor-picker';

const OpsChatTab = lazy(() => import('../ops-chat/index'));
const PlanTab = lazy(() => import('../plan/index'));

export default function OpsPage(): React.JSX.Element {
  return (
    <TabbedModule
      moduleId="ops-page"
      title="Ops Console"
      subtitle="Tool-calling conversation + one-shot planner."
      headerRight={<OpsExecutorPicker />}
      tabs={[
        { id: 'chat', label: 'Ops Chat', Component: OpsChatTab },
        { id: 'plan', label: 'Planner', Component: PlanTab },
      ]}
    />
  );
}
