import * as React from 'react';
import { lazy } from 'react';
import { TabbedModule } from '@/shell/tabbed-module';

/**
 * Models page — groups catalog / presets / pulls / bench / lmstudio
 * into tabs under a single activity-bar entry. The underlying
 * modules are unchanged; this wrapper just mounts them side-by-side
 * as tab panels. Each tab keeps its own state when the others
 * are open.
 */

const CatalogTab = lazy(() => import('../models/index'));
const PresetsTab = lazy(() => import('../presets/index'));
const PullsTab = lazy(() => import('../pulls/index'));
const BenchTab = lazy(() => import('../bench/index'));
const LMStudioTab = lazy(() => import('../lmstudio/index'));
const ServerTab = lazy(() => import('../server/index'));

export default function ModelsPage(): React.JSX.Element {
  return (
    <TabbedModule
      moduleId="models-page"
      title="Models"
      subtitle="Catalog, tuning, and model-runtime state for the fleet."
      tabs={[
        { id: 'catalog', label: 'Catalog', Component: CatalogTab },
        { id: 'presets', label: 'Presets', Component: PresetsTab },
        { id: 'pulls', label: 'Pulls', Component: PullsTab },
        { id: 'bench', label: 'Bench', Component: BenchTab },
        { id: 'lmstudio', label: 'LM Studio', Component: LMStudioTab },
        { id: 'server', label: 'Local Server', Component: ServerTab },
      ]}
    />
  );
}
