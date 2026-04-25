import * as React from 'react';
import { EditorialHero } from '../../ui';
import { trpc } from '../../lib/trpc';
import { useTabStore } from '../../stores/tab-store';
import { SessionsTable } from './sessions-table';
import { DeleteConfirm } from './delete-confirm';

export default function OpsSessionsModule(): React.JSX.Element {
  const list = trpc.opsSessionList.useQuery({ limit: 100 });
  const del = trpc.opsSessionDelete.useMutation({
    onSuccess: () => list.refetch(),
  });
  const [confirmId, setConfirmId] = React.useState<string | null>(null);

  function open(sessionId: string): void {
    useTabStore.getState().open({
      tabKey: `ops-session:${sessionId}`,
      title: `Session ${sessionId.slice(0, 8)}`,
      kind: 'ops-session',
      instanceId: sessionId,
      openedAt: Date.now(),
    });
  }

  return (
    <div
      data-testid="ops-sessions-root"
      style={{ padding: '32px 48px 48px', maxWidth: 1200, margin: '0 auto' }}
    >
      <EditorialHero
        eyebrow="Replay archive"
        title="Ops Sessions"
        lede="Every Ops Chat planner session that has run on this node, oldest hidden after 100. Delete is permanent."
      />
      <div style={{ marginTop: 24 }}>
        {confirmId ? (
          <DeleteConfirm
            sessionId={confirmId}
            onConfirm={() => {
              del.mutate({ sessionId: confirmId });
              setConfirmId(null);
            }}
            onCancel={() => setConfirmId(null)}
          />
        ) : (
          <SessionsTable
            sessions={list.data?.sessions ?? []}
            onOpen={open}
            onDelete={setConfirmId}
          />
        )}
      </div>
    </div>
  );
}
