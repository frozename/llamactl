import type { NodeClient } from '../client/node-client.js';
import type { ModelRun, ModelRunStatus } from './schema.js';

export type ApplyAction = 'unchanged' | 'started' | 'restarted';

export interface ApplyEvent {
  type: 'stop' | 'start' | 'started' | 'skipped';
  message: string;
}

export interface ApplyResult {
  action: ApplyAction;
  statusSection: ModelRunStatus;
  error?: string;
}

function sameExtraArgs(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface StartDone {
  ok: boolean;
  pid: number | null;
  endpoint: string;
  error?: string;
}

/**
 * Diff one workload against the live status of its target node and
 * converge: stop the running server if the config differs, then start
 * the new spec. No-op when observed already matches desired.
 *
 * Shared by the CLI `apply` command and the controller reconciler so
 * both land the same restart semantics.
 */
export async function applyOne(
  manifest: ModelRun,
  client: NodeClient,
  onEvent?: (e: ApplyEvent) => void,
): Promise<ApplyResult> {
  const status = await client.serverStatus.query();

  const desiredRel = manifest.spec.target.value;
  const desiredArgs = manifest.spec.extraArgs;
  const liveRel = status.rel;
  const liveArgs = status.extraArgs ?? [];
  const running = status.state === 'up';
  const matches =
    running && liveRel === desiredRel && sameExtraArgs(liveArgs, desiredArgs);

  const now = new Date().toISOString();

  if (matches) {
    onEvent?.({
      type: 'skipped',
      message: `${manifest.metadata.name}: already running (${desiredRel})`,
    });
    return {
      action: 'unchanged',
      statusSection: {
        phase: 'Running',
        serverPid: status.pid,
        endpoint: status.endpoint,
        lastTransitionTime: now,
        conditions: [
          { type: 'Applied', status: 'True', reason: 'unchanged', lastTransitionTime: now },
        ],
      },
    };
  }

  let action: ApplyAction;
  if (running) {
    onEvent?.({ type: 'stop', message: `${manifest.metadata.name}: stopping mismatched server` });
    await client.serverStop.mutate({ graceSeconds: 5 });
    action = 'restarted';
  } else {
    action = 'started';
  }

  onEvent?.({ type: 'start', message: `${manifest.metadata.name}: starting ${desiredRel}` });
  const startResult = await new Promise<StartDone | null>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('serverStart timed out')),
      (manifest.spec.timeoutSeconds + 5) * 1000,
    );
    let done: StartDone | null = null;
    const sub = client.serverStart.subscribe(
      {
        target: desiredRel,
        extraArgs: desiredArgs.length > 0 ? desiredArgs : undefined,
        timeoutSeconds: manifest.spec.timeoutSeconds,
      },
      {
        onData: (evt: unknown) => {
          const e = evt as { type?: string; result?: unknown };
          if (e.type === 'done') done = e.result as StartDone;
        },
        onError: (err: unknown) => {
          clearTimeout(timer);
          reject(err as Error);
        },
        onComplete: () => {
          clearTimeout(timer);
          resolve(done);
        },
      },
    );
    void sub;
  });

  if (!startResult || !startResult.ok) {
    const err = startResult?.error ?? 'serverStart failed';
    return {
      action,
      statusSection: {
        phase: 'Failed',
        serverPid: null,
        endpoint: null,
        lastTransitionTime: now,
        conditions: [
          { type: 'Applied', status: 'False', reason: action, message: err, lastTransitionTime: now },
        ],
      },
      error: err,
    };
  }

  onEvent?.({
    type: 'started',
    message: `${manifest.metadata.name}: ready at ${startResult.endpoint} pid=${startResult.pid ?? '?'}`,
  });

  return {
    action,
    statusSection: {
      phase: 'Running',
      serverPid: startResult.pid,
      endpoint: startResult.endpoint,
      lastTransitionTime: now,
      conditions: [
        { type: 'Applied', status: 'True', reason: action, lastTransitionTime: now },
      ],
    },
  };
}
