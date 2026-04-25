import * as React from 'react';

/**
 * Opened when a user activates the Workloads group leaf directly
 * (not one of its children). Steers the user to Model Runs for the
 * full list, or to a specific workload via the Explorer subtree.
 */
export default function WorkloadsPlaceholder(): React.JSX.Element {
  return (
    <div data-testid="workloads-root" style={{ padding: 48, color: 'var(--color-text-secondary)', maxWidth: 720 }}>
      <h2 style={{ fontSize: 20, margin: '0 0 8px', color: 'var(--color-text)' }}>
        Workloads
      </h2>
      <p style={{ margin: 0, lineHeight: 1.6 }}>
        Expand this group in the Explorer to open a specific workload, or open
        {' '}
        <strong style={{ color: 'var(--color-text)' }}>Model Runs</strong>
        {' '}
        for the full list.
      </p>
    </div>
  );
}
