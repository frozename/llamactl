import * as React from 'react';
import { Input } from '@/ui';
import { Search } from 'lucide-react';
import { ExplorerTree } from './explorer-tree';
import { SearchView } from './search-view';
import { SessionsView } from './sessions-view';
import { FleetView } from './fleet-view';
import { getRailView, type RailViewId } from './rail-views';

interface ExplorerPanelProps {
  activeView: RailViewId;
}

/**
 * The 280 px left panel. Its content depends on the active rail view:
 * Explorer = module tree; Search / Sessions / Fleet are real in P3.
 * Cost / Settings are not rail views — they're tab-openers in the rail's
 * bottom group, handled directly by `ActivityRail`.
 */
export function ExplorerPanel({ activeView }: ExplorerPanelProps): React.JSX.Element {
  return (
    <aside
      data-testid={`rail-panel-${activeView}`}
      style={{
        width: 280,
        background: 'var(--color-surface-1)',
        borderRight: '1px solid var(--color-border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <Header label={activeView} />
      {activeView === 'explorer' && <ExplorerBody />}
      {activeView === 'search' && <SearchView />}
      {activeView === 'sessions' && <SessionsView />}
      {activeView === 'fleet' && <FleetView />}
    </aside>
  );
}

function Header({ label }: { label: RailViewId }): React.JSX.Element {
  const displayLabel = label === 'explorer' ? 'Beacon' : getRailView(label).label;
  return (
    <div style={{ padding: '14px 18px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <h2
        style={{
          margin: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--color-text-tertiary)',
          fontWeight: 500,
        }}
      >
        {displayLabel}
      </h2>
    </div>
  );
}

function ExplorerBody(): React.JSX.Element {
  return (
    <>
      <div style={{ padding: '0 14px 10px' }}>
        <Input leadingSlot={<Search size={12} />} placeholder="Search files…" />
      </div>
      <ExplorerTree />
    </>
  );
}

