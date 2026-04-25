import * as React from 'react';
import { useOpsSession } from '../../../lib/use-ops-session';
import { useTabStore } from '../../../stores/tab-store';
import { SessionHeader } from './session-header';
import { IterationCard } from './iteration-card';
import { OpsSessionEmpty } from './empty-state';

interface Props {
  sessionId: string;
}

export function OpsSessionDetail({ sessionId }: Props): React.JSX.Element {
  const { view, loading, error } = useOpsSession(sessionId);

  // Sticky-user-intent expansion: until the user toggles, latest auto-expands.
  const [userToggled, setUserToggled] = React.useState(false);
  const [explicit, setExplicit] = React.useState<Record<string, boolean>>({});
  const latestId = view.iterations[view.iterations.length - 1]?.stepId;

  function isExpanded(stepId: string): boolean {
    if (userToggled) return explicit[stepId] ?? false;
    return stepId === latestId;
  }

  function toggle(stepId: string): void {
    setUserToggled(true);
    setExplicit((prev) => {
      const wasExpanded = prev[stepId] ?? stepId === latestId;
      return { ...prev, [stepId]: !wasExpanded };
    });
  }

  if (error && view.iterations.length === 0 && !view.goal) {
    return <OpsSessionEmpty sessionId={sessionId} />;
  }

  return (
    <div
      data-testid="ops-session-detail-root"
      style={{ padding: '32px 48px 48px', maxWidth: 1100, margin: '0 auto' }}
    >
      <SessionHeader
        view={view}
        onOpenInOpsChat={() => {
          useTabStore.getState().open({
            tabKey: 'module:ops-chat',
            title: 'Ops Chat',
            kind: 'module',
            openedAt: Date.now(),
          });
        }}
      />
      {loading && view.iterations.length === 0 && (
        <div
          data-testid="ops-session-loading"
          style={{ padding: 24, color: 'var(--color-text-secondary)', textAlign: 'center' }}
        >
          Loading session…
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 24 }}>
        {view.iterations.map((it) => (
          <IterationCard
            key={it.stepId}
            it={it}
            expanded={isExpanded(it.stepId)}
            onToggle={() => toggle(it.stepId)}
          />
        ))}
      </div>
      {view.status === 'refused' && view.refusalReason && (
        <div
          data-testid="ops-session-refusal"
          style={{
            marginTop: 24,
            padding: 16,
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 8,
            background: 'var(--color-bg-elevated)',
            color: 'var(--color-text)',
          }}
        >
          <strong>Refused:</strong> {view.refusalReason}
        </div>
      )}
    </div>
  );
}
