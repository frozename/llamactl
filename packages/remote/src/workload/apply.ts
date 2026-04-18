import type { ModelRun, ModelRunStatus, ModelRunWorker } from './schema.js';

/**
 * Structural subset of `NodeClient` that `applyOne` actually touches.
 * Declared here so the workload layer doesn't force its consumers
 * (router.ts, the CLI) to pass the full typed `NodeClient` — both
 * `clientForNode` inside the router and the CLI's pinned client
 * satisfy this narrower shape, which eliminates an unsafe `as any`
 * cast at the router boundary.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SubscribeCallbacks = { onData: (e: any) => void; onError: (err: any) => void; onComplete: () => void };
type Unsubscribable = { unsubscribe?: () => void };

export interface WorkloadClient {
  serverStatus: {
    query(): Promise<{
      state: string;
      rel: string | null;
      extraArgs: string[];
      pid: number | null;
      endpoint: string;
      advertisedEndpoint?: string | null;
    }>;
  };
  serverStop: { mutate(input?: { graceSeconds?: number }): Promise<unknown> };
  serverStart: {
    subscribe(
      input: { target: string; extraArgs?: string[]; timeoutSeconds?: number },
      callbacks: SubscribeCallbacks,
    ): Unsubscribable;
  };
  rpcServerStart: {
    subscribe(
      input: { host?: string; port: number; extraArgs?: string[]; timeoutSeconds?: number },
      callbacks: SubscribeCallbacks,
    ): Unsubscribable;
  };
  rpcServerStop: { mutate(input?: { graceSeconds?: number }): Promise<unknown> };
}

export type ApplyAction = 'unchanged' | 'started' | 'restarted' | 'pending';

export interface ApplyEvent {
  type: 'stop' | 'start' | 'started' | 'skipped' | 'worker-start' | 'worker-ready' | 'gateway-pending';
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

/** Fan out rpc-server starts across every worker in the spec. Returns
 *  "host:port,host:port,..." suitable for llama-server's --rpc flag. */
async function startWorkers(
  workers: readonly ModelRunWorker[],
  getClient: (nodeName: string) => WorkloadClient,
  onEvent?: (e: ApplyEvent) => void,
): Promise<{ rpcList: string; error?: string }> {
  const endpoints: string[] = [];
  for (const worker of workers) {
    onEvent?.({
      type: 'worker-start',
      message: `worker ${worker.node}: starting rpc-server on ${worker.rpcHost}:${worker.rpcPort}`,
    });
    const wc = getClient(worker.node);
    // Stop any prior rpc-server on that node; ignore errors.
    try { await wc.rpcServerStop.mutate({ graceSeconds: 2 }); } catch {}
    const started = await new Promise<{ ok: boolean; endpoint: string; error?: string } | null>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`rpc-server start timeout on ${worker.node}`)),
          (worker.timeoutSeconds + 5) * 1000,
        );
        let done: { ok: boolean; endpoint: string; error?: string } | null = null;
        const sub = wc.rpcServerStart.subscribe(
          {
            host: '0.0.0.0',
            port: worker.rpcPort,
            ...(worker.extraArgs.length > 0 ? { extraArgs: worker.extraArgs } : {}),
            timeoutSeconds: worker.timeoutSeconds,
          },
          {
            onData: (e: unknown) => {
              const evt = e as { type?: string; result?: unknown };
              if (evt.type === 'done') done = evt.result as typeof done;
            },
            onError: (err: unknown) => { clearTimeout(timer); reject(err as Error); },
            onComplete: () => { clearTimeout(timer); resolve(done); },
          },
        );
        void sub;
      },
    );
    if (!started || !started.ok) {
      return {
        rpcList: '',
        error: `worker ${worker.node}: ${started?.error ?? 'rpc-server failed to start'}`,
      };
    }
    onEvent?.({
      type: 'worker-ready',
      message: `worker ${worker.node}: ready on ${worker.rpcHost}:${worker.rpcPort}`,
    });
    endpoints.push(`${worker.rpcHost}:${worker.rpcPort}`);
  }
  return { rpcList: endpoints.join(',') };
}

async function stopWorkers(
  workers: readonly ModelRunWorker[],
  getClient: (nodeName: string) => WorkloadClient,
): Promise<void> {
  // Reverse order mirrors start order — keeps logs easier to read.
  for (const worker of [...workers].reverse()) {
    try {
      const wc = getClient(worker.node);
      await wc.rpcServerStop.mutate({ graceSeconds: 3 });
    } catch {
      // best effort
    }
  }
}

/**
 * Diff one workload against the live status of its target node and
 * converge: stop the running server if the config differs, then start
 * the new spec. No-op when observed already matches desired.
 *
 * Shared by the CLI `apply` command and the controller reconciler so
 * both land the same restart semantics. When spec.workers is
 * non-empty, starts rpc-server on each worker first and appends
 * `--rpc host1:p1,host2:p2,...` to the coordinator's extraArgs.
 */
export async function applyOne(
  manifest: ModelRun,
  getClient: (nodeName: string) => WorkloadClient,
  onEvent?: (e: ApplyEvent) => void,
): Promise<ApplyResult> {
  if (manifest.spec.gateway) {
    const now = new Date().toISOString();
    const msg =
      `gateway workload targeting '${manifest.spec.node}': ` +
      `registry wiring lands in a follow-up — manifest is validated and tracked but no upstream mutation yet`;
    onEvent?.({ type: 'gateway-pending', message: `${manifest.metadata.name}: ${msg}` });
    return {
      action: 'pending',
      statusSection: {
        phase: 'Pending',
        serverPid: null,
        endpoint: null,
        lastTransitionTime: now,
        conditions: [
          {
            type: 'Applied',
            status: 'False',
            reason: 'GatewayRegistrationPending',
            message: msg,
            lastTransitionTime: now,
          },
        ],
      },
    };
  }
  const client = getClient(manifest.spec.node);
  const status = await client.serverStatus.query();

  const desiredRel = manifest.spec.target.value;
  // Compose the effective extraArgs: user args + the --rpc flag if
  // this workload has workers. The coordinator's server.rel /
  // extraArgs comparison below uses the composed form so a diff
  // between "with --rpc" and "without" triggers a restart.
  let effectiveExtraArgs: string[] = manifest.spec.extraArgs;
  const workers = manifest.spec.workers;

  let rpcFlag: string[] = [];
  if (workers.length > 0) {
    rpcFlag = [
      '--rpc',
      workers.map((w) => `${w.rpcHost}:${w.rpcPort}`).join(','),
    ];
    effectiveExtraArgs = [...manifest.spec.extraArgs, ...rpcFlag];
  }
  const desiredArgs = effectiveExtraArgs;
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

  if (workers.length > 0) {
    const wres = await startWorkers(workers, getClient, onEvent);
    if (wres.error) {
      const when = new Date().toISOString();
      return {
        action,
        statusSection: {
          phase: 'Failed',
          serverPid: null,
          endpoint: null,
          lastTransitionTime: when,
          conditions: [
            {
              type: 'Applied',
              status: 'False',
              reason: action,
              message: wres.error,
              lastTransitionTime: when,
            },
          ],
        },
        error: wres.error,
      };
    }
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
        ...(desiredArgs.length > 0 ? { extraArgs: desiredArgs } : {}),
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
    // Tear down any workers we just started so a failed coordinator
    // doesn't leave rpc-servers listening forever.
    if (workers.length > 0) await stopWorkers(workers, getClient);
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
