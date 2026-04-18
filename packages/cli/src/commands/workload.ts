import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  workloadSchema,
  workloadStore,
} from '@llamactl/remote';
import { getNodeClientByName } from '../dispatcher.js';

const APPLY_USAGE = `Usage: llamactl apply -f <manifest.yaml>

Reconcile a ModelRun manifest against the target node:
  * If the node already runs the same rel with the same extraArgs,
    apply is a no-op and prints "unchanged".
  * If it runs a different config, the existing server is stopped and
    the new spec is started in its place.
  * If no server is running, the spec is started fresh.

The accepted manifest is persisted under \$DEV_STORAGE/workloads/<name>.yaml
so 'llamactl get workloads' can list it afterwards.
`;

const GET_USAGE = `Usage: llamactl get workloads [--json]

List every workload manifest and the live phase of its target node
(Running / Stopped / Mismatch / Unreachable).
`;

const DESCRIBE_USAGE = `Usage: llamactl describe workload <name> [--json]

Print a workload manifest plus the live serverStatus from its target
node, side by side.
`;

const DELETE_USAGE = `Usage: llamactl delete workload <name> [--keep-running]

Stop the server on the target node (unless --keep-running is set) and
remove the manifest file from the workloads directory.
`;

interface ApplyFlags {
  file: string;
  json: boolean;
}

function parseApplyFlags(args: string[]): ApplyFlags | { error: string } {
  let file = '';
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-f' || arg === '--file') {
      file = args[++i] ?? '';
    } else if (arg.startsWith('--file=')) {
      file = arg.slice('--file='.length);
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '-h' || arg === '--help') {
      return { error: 'help' };
    } else if (arg.startsWith('-')) {
      return { error: `Unknown flag: ${arg}` };
    } else if (!file) {
      file = arg;
    } else {
      return { error: `Unexpected extra argument: ${arg}` };
    }
  }
  if (!file) return { error: 'apply: -f <manifest.yaml> is required' };
  return { file, json };
}

function sameExtraArgs(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function runApply(args: string[]): Promise<number> {
  const parsed = parseApplyFlags(args);
  if ('error' in parsed) {
    const stream = parsed.error === 'help' ? process.stdout : process.stderr;
    stream.write(APPLY_USAGE);
    return parsed.error === 'help' ? 0 : 1;
  }
  const manifestPath = resolvePath(parsed.file);
  if (!existsSync(manifestPath)) {
    process.stderr.write(`apply: file not found: ${manifestPath}\n`);
    return 1;
  }
  const raw = readFileSync(manifestPath, 'utf8');
  let manifest: workloadSchema.ModelRun;
  try {
    manifest = workloadStore.parseWorkload(raw);
  } catch (err) {
    process.stderr.write(`apply: manifest rejected: ${(err as Error).message}\n`);
    return 1;
  }

  const client = getNodeClientByName(manifest.spec.node);
  const status = await client.serverStatus.query();

  const desiredRel = manifest.spec.target.value;
  const desiredArgs = manifest.spec.extraArgs;
  const liveRel = status.rel;
  const liveArgs = status.extraArgs ?? [];
  const running = status.state === 'up';
  const matches =
    running && liveRel === desiredRel && sameExtraArgs(liveArgs, desiredArgs);

  let action: 'unchanged' | 'started' | 'restarted' = 'unchanged';
  type StartDone = { ok: boolean; pid: number | null; endpoint: string; error?: string };
  let startResult: StartDone | null = null;

  if (matches) {
    action = 'unchanged';
  } else {
    if (running) {
      await client.serverStop.mutate({ graceSeconds: 5 });
      action = 'restarted';
    } else {
      action = 'started';
    }
    startResult = await new Promise<StartDone | null>((resolve, reject) => {
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
            if (e.type === 'done') done = e.result as typeof done;
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
      process.stderr.write(`apply: ${err}\n`);
      return 1;
    }
  }

  const now = new Date().toISOString();
  const statusSection: workloadSchema.ModelRunStatus = {
    phase: 'Running',
    serverPid: startResult?.pid ?? status.pid,
    endpoint: startResult?.endpoint ?? status.endpoint,
    lastTransitionTime: now,
    conditions: [
      {
        type: 'Applied',
        status: 'True',
        reason: action,
        lastTransitionTime: now,
      },
    ],
  };
  const persisted: workloadSchema.ModelRun = {
    ...manifest,
    status: statusSection,
  };
  const savedPath = workloadStore.saveWorkload(persisted);

  if (parsed.json) {
    process.stdout.write(
      `${JSON.stringify({ action, path: savedPath, status: statusSection }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `${action} modelrun/${manifest.metadata.name} on node ${manifest.spec.node}\n`,
    );
    process.stdout.write(`  manifest: ${savedPath}\n`);
    if (statusSection.endpoint) process.stdout.write(`  endpoint: ${statusSection.endpoint}\n`);
    if (statusSection.serverPid) process.stdout.write(`  pid:      ${statusSection.serverPid}\n`);
  }
  return 0;
}

type WorkloadRow = {
  name: string;
  node: string;
  phase: 'Running' | 'Stopped' | 'Mismatch' | 'Unreachable';
  rel: string;
  endpoint: string | null;
};

async function inspect(
  manifest: workloadSchema.ModelRun,
): Promise<WorkloadRow> {
  try {
    const client = getNodeClientByName(manifest.spec.node);
    const status = await client.serverStatus.query();
    const desired = manifest.spec.target.value;
    const running = status.state === 'up';
    let phase: WorkloadRow['phase'] = 'Stopped';
    if (running && status.rel === desired) phase = 'Running';
    else if (running && status.rel !== desired) phase = 'Mismatch';
    return {
      name: manifest.metadata.name,
      node: manifest.spec.node,
      phase,
      rel: desired,
      endpoint: status.endpoint ?? null,
    };
  } catch {
    return {
      name: manifest.metadata.name,
      node: manifest.spec.node,
      phase: 'Unreachable',
      rel: manifest.spec.target.value,
      endpoint: null,
    };
  }
}

export async function runGet(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  let json = false;
  for (const arg of rest) {
    if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(GET_USAGE);
      return 0;
    } else {
      process.stderr.write(`get: unknown argument ${arg}\n`);
      return 1;
    }
  }
  if (sub !== 'workloads' && sub !== 'workload') {
    process.stderr.write(GET_USAGE);
    return 1;
  }

  const manifests = workloadStore.listWorkloads();
  const rows = await Promise.all(manifests.map(inspect));
  if (json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write('No workloads registered.\n');
    return 0;
  }
  const pad = (s: string, w: number): string =>
    s.length >= w ? s : s + ' '.repeat(w - s.length);
  const nameW = Math.max(4, ...rows.map((r) => r.name.length));
  const nodeW = Math.max(4, ...rows.map((r) => r.node.length));
  const phaseW = Math.max(5, ...rows.map((r) => r.phase.length));
  process.stdout.write(
    `${pad('NAME', nameW)}  ${pad('NODE', nodeW)}  ${pad('PHASE', phaseW)}  REL\n`,
  );
  for (const r of rows) {
    process.stdout.write(
      `${pad(r.name, nameW)}  ${pad(r.node, nodeW)}  ${pad(r.phase, phaseW)}  ${r.rel}\n`,
    );
  }
  return 0;
}

export async function runDescribe(args: string[]): Promise<number> {
  const [kind, name, ...rest] = args;
  let json = false;
  for (const arg of rest) {
    if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(DESCRIBE_USAGE);
      return 0;
    } else {
      process.stderr.write(`describe: unknown argument ${arg}\n`);
      return 1;
    }
  }
  if (kind !== 'workload' && kind !== 'workloads') {
    process.stderr.write(DESCRIBE_USAGE);
    return 1;
  }
  if (!name) {
    process.stderr.write(DESCRIBE_USAGE);
    return 1;
  }
  let manifest: workloadSchema.ModelRun;
  try {
    manifest = workloadStore.loadWorkloadByName(name);
  } catch (err) {
    process.stderr.write(`describe: ${(err as Error).message}\n`);
    return 1;
  }
  let liveStatus: unknown = null;
  try {
    const client = getNodeClientByName(manifest.spec.node);
    liveStatus = await client.serverStatus.query();
  } catch (err) {
    liveStatus = { error: (err as Error).message };
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ manifest, liveStatus }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`Name:       ${manifest.metadata.name}\n`);
  process.stdout.write(`Node:       ${manifest.spec.node}\n`);
  process.stdout.write(`Target:     ${manifest.spec.target.kind}:${manifest.spec.target.value}\n`);
  process.stdout.write(`ExtraArgs:  ${manifest.spec.extraArgs.join(' ') || '(none)'}\n`);
  process.stdout.write(`RestartPolicy: ${manifest.spec.restartPolicy}\n`);
  if (manifest.status) {
    process.stdout.write(
      `Status:     phase=${manifest.status.phase} endpoint=${manifest.status.endpoint ?? 'none'} pid=${manifest.status.serverPid ?? 'none'} since=${manifest.status.lastTransitionTime}\n`,
    );
  }
  process.stdout.write(`LiveStatus: ${JSON.stringify(liveStatus, null, 2).replace(/\n/g, '\n            ')}\n`);
  return 0;
}

export async function runDelete(args: string[]): Promise<number> {
  const [kind, name, ...rest] = args;
  let keepRunning = false;
  for (const arg of rest) {
    if (arg === '--keep-running') keepRunning = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(DELETE_USAGE);
      return 0;
    } else {
      process.stderr.write(`delete: unknown argument ${arg}\n`);
      return 1;
    }
  }
  if (kind !== 'workload' && kind !== 'workloads') {
    process.stderr.write(DELETE_USAGE);
    return 1;
  }
  if (!name) {
    process.stderr.write(DELETE_USAGE);
    return 1;
  }
  let manifest: workloadSchema.ModelRun;
  try {
    manifest = workloadStore.loadWorkloadByName(name);
  } catch (err) {
    process.stderr.write(`delete: ${(err as Error).message}\n`);
    return 1;
  }
  if (!keepRunning) {
    try {
      const client = getNodeClientByName(manifest.spec.node);
      const status = await client.serverStatus.query();
      // Only stop the server if the running rel matches this workload's
      // target. If something else is running there (perhaps another
      // workload was applied on top), leave it alone.
      if (status.state === 'up' && status.rel === manifest.spec.target.value) {
        await client.serverStop.mutate({ graceSeconds: 5 });
        process.stdout.write(`stopped server on node ${manifest.spec.node}\n`);
      } else if (status.state === 'up') {
        process.stdout.write(
          `skipped stop: node ${manifest.spec.node} is running a different rel (${status.rel ?? 'unknown'})\n`,
        );
      }
    } catch (err) {
      process.stderr.write(
        `warning: failed to reach node ${manifest.spec.node}: ${(err as Error).message}\n`,
      );
    }
  }
  const ok = workloadStore.deleteWorkload(name);
  if (!ok) {
    process.stderr.write(`delete: workload '${name}' not found in store\n`);
    return 1;
  }
  process.stdout.write(`deleted modelrun/${name}\n`);
  return 0;
}
