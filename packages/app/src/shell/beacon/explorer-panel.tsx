import * as React from 'react';
import { Input } from '@/ui';
import { Search } from 'lucide-react';
import { ExplorerTree } from './explorer-tree';
import { SearchView } from './search-view';
import { getRailView, type RailViewId } from './rail-views';

interface ExplorerPanelProps {
  activeView: RailViewId;
}

/**
 * The 280 px left panel. Its content depends on the active rail view:
 * Explorer = module tree; Search / Sessions / Fleet / Cost = stubs in
 * P2 that become real in P3; Tokens is handled by the separate
 * TokensPanel slide-in (this panel renders the prompt).
 */
export function ExplorerPanel({ activeView }: ExplorerPanelProps): React.JSX.Element {
  return (
    <aside
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
      {activeView === 'sessions' && <StubBody message="Sessions view ships in P3. Recent chat and ops sessions will group here by time." />}
      {activeView === 'fleet' && <StubBody message="Fleet view ships in P3. Node tree + quick context switcher." />}
      {activeView === 'tokens' && <StubBody message="Tokens inspector slides from the right edge — look over there." />}
      {activeView === 'cost' && <StubBody message="Cost details render here in P3. For now, open Cost via the command palette." />}
      {activeView === 'settings' && <StubBody message="Click the Settings rail button to open the Settings tab." />}
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

function StubBody({ message }: { message: string }): React.JSX.Element {
  return (
    <div style={{ padding: '14px 18px', color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
      <p>{message}</p>
    </div>
  );
}
