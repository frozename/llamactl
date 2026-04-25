import * as React from 'react';
import { EditorialHero, Button } from '@/ui';
import type { SessionView } from '@/lib/use-ops-session';

interface Props {
  view: SessionView;
  onOpenInOpsChat: () => void;
}

const STATUS_LABEL: Record<SessionView['status'], string> = {
  live: 'Live',
  done: 'Done',
  refused: 'Refused',
  aborted: 'Aborted',
};

const STATUS_TONE: Record<SessionView['status'], 'default' | 'ok' | 'info'> = {
  live: 'info',
  done: 'ok',
  refused: 'default',
  aborted: 'default',
};

export function SessionHeader({ view, onOpenInOpsChat }: Props): React.JSX.Element {
  const ledeParts = [
    `${view.iterations.length} iteration${view.iterations.length === 1 ? '' : 's'}`,
    view.startedAt ? `started ${new Date(view.startedAt).toLocaleString()}` : null,
    view.endedAt ? `ended ${new Date(view.endedAt).toLocaleString()}` : null,
  ].filter(Boolean) as string[];

  return (
    <div data-testid="ops-session-header">
      <EditorialHero
        eyebrow={`Session ${view.sessionId}`}
        title={view.goal || 'Loading…'}
        lede={ledeParts.join(' · ')}
        pills={[{ label: STATUS_LABEL[view.status], tone: STATUS_TONE[view.status] }]}
        actions={
          view.status === 'live' ? (
            <Button onClick={onOpenInOpsChat} data-testid="ops-session-open-in-ops-chat">
              Open in Ops Chat
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
