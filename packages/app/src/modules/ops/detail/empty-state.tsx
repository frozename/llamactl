import * as React from 'react';
import { EditorialHero } from '@/ui';

interface Props {
  sessionId: string;
}

export function OpsSessionEmpty({ sessionId }: Props): React.JSX.Element {
  return (
    <div data-testid="ops-session-empty">
      <EditorialHero
        eyebrow={`Session ${sessionId}`}
        title="Legacy Session"
        lede="This session predates the per-session journal feature (Phase 2). No timeline is available."
      />
    </div>
  );
}
