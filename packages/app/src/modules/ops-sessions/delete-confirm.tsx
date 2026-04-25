import * as React from 'react';
import { Button } from '../../ui';

interface Props {
  sessionId: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteConfirm({ sessionId, onConfirm, onCancel }: Props): React.JSX.Element {
  return (
    <div
      data-testid={`ops-sessions-delete-confirm-${sessionId}`}
      style={{
        padding: 12,
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 6,
        background: 'var(--color-bg-elevated)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <span style={{ flex: 1, fontSize: 14 }}>
        Delete session <code>{sessionId}</code>? This removes its journal directory.
      </span>
      <Button variant="destructive" onClick={onConfirm}>
        Delete
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
