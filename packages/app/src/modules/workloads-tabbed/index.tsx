import * as React from 'react';
import { lazy } from 'react';
import { TabbedModule } from '@/shell/tabbed-module';

/**
 * Workloads page — ModelRuns + Composites side by side. Composites
 * are multi-workload bundles (services, workloads, RAG, gateways
 * applied with DAG ordering); they share the same apply/describe/
 * delete semantics as a single ModelRun, so they live together.
 */

const WorkloadsTab = lazy(() => import('../workloads/index'));
const CompositesTab = lazy(() => import('../composites/index'));

export default function WorkloadsPage(): React.JSX.Element {
  return (
    <TabbedModule
      moduleId="workloads-page"
      title="Workloads"
      subtitle="ModelRuns + Composites. Start, reconcile, tear down."
      tabs={[
        { id: 'workloads', label: 'Model Runs', Component: WorkloadsTab },
        { id: 'composites', label: 'Composites', Component: CompositesTab },
      ]}
    />
  );
}
