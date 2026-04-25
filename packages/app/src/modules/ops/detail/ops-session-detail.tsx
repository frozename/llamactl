import * as React from 'react';

interface Props {
  sessionId: string;
}

/**
 * Placeholder — full session replay lands later. Renders the id and
 * a hint so the tab isn't empty; the ops-chat replay timeline will
 * hook in here once the session journal contract is finalized.
 */
export function OpsSessionDetail({ sessionId }: Props): React.JSX.Element {
  return (
    <div data-testid="ops-session-detail-root" style={{ padding: 48, maxWidth: 1100, margin: '0 auto' }}>
      <h2 style={{ fontSize: 28, margin: '0 0 8px', fontWeight: 600, color: 'var(--color-text)' }}>
        Ops session {sessionId}
      </h2>
      <p style={{ color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.6 }}>
        Session replay and timeline ship post-renewal. For now, the session tab serves as a
        stable anchor you can pin and return to.
      </p>
    </div>
  );
}
