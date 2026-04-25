import * as React from 'react';
import { Button, Badge, type BadgeVariant } from '../../ui';
import type { SessionStatus } from '../../lib/use-ops-session';

// Local mirror of the server SessionSummary — keeps app free of a
// direct import from @llamactl/remote.
export interface SessionSummary {
  sessionId: string;
  goal: string;
  status: SessionStatus;
  iterations: number;
  startedAt: string;
  endedAt?: string;
  nodeId?: string;
  model?: string;
}

const STATUS_VARIANT: Record<SessionStatus, BadgeVariant> = {
  live: 'brand',
  done: 'ok',
  refused: 'err',
  aborted: 'warn',
};

interface Props {
  sessions: SessionSummary[];
  onOpen: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
}

export function SessionsTable({ sessions, onOpen, onDelete }: Props): React.JSX.Element {
  if (sessions.length === 0) {
    return (
      <div
        data-testid="ops-sessions-empty"
        style={{ padding: 32, color: 'var(--color-text-secondary)', textAlign: 'center' }}
      >
        No sessions yet — kick one off from Ops Chat.
      </div>
    );
  }
  return (
    <table
      data-testid="ops-sessions-table"
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: 14,
        color: 'var(--color-text)',
      }}
    >
      <thead>
        <tr style={{ textAlign: 'left', color: 'var(--color-text-secondary)' }}>
          <th style={{ padding: '8px 12px' }}>Goal</th>
          <th style={{ padding: '8px 12px' }}>Status</th>
          <th style={{ padding: '8px 12px' }}>Iterations</th>
          <th style={{ padding: '8px 12px' }}>Started</th>
          <th style={{ padding: '8px 12px' }}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr
            key={s.sessionId}
            data-testid={`ops-sessions-row-${s.sessionId}`}
            style={{ borderTop: '1px solid var(--color-border-subtle)' }}
          >
            <td style={{ padding: '10px 12px', maxWidth: 400 }}>
              <div style={{ fontWeight: 500, marginBottom: 2 }}>{s.goal}</div>
              <code style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {s.sessionId}
              </code>
            </td>
            <td style={{ padding: '10px 12px' }}>
              <Badge variant={STATUS_VARIANT[s.status]}>{s.status}</Badge>
            </td>
            <td style={{ padding: '10px 12px' }}>{s.iterations}</td>
            <td style={{ padding: '10px 12px', color: 'var(--color-text-secondary)' }}>
              {new Date(s.startedAt).toLocaleString()}
            </td>
            <td style={{ padding: '10px 12px', display: 'flex', gap: 6 }}>
              <Button onClick={() => onOpen(s.sessionId)}>Open</Button>
              <Button variant="ghost" onClick={() => onDelete(s.sessionId)}>
                Delete
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
