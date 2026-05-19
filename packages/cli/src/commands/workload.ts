import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  config as kubecfg,
  noderunApply,
  noderunSchema,
  noderunStore,
  workloadApply,
  workloadGatewayHandlers,
  workloadSchema,
  workloadStore,
} from '@llamactl/remote';
import {
  listModelHosts,
  saveModelHost,
} from '../../../remote/src/workload/modelhost-store.js';
import { readModelHostState } from '../../../core/src/engines/state.js';
import { getNodeClientByName } from '../dispatcher.js';
import { makeSpecArtifactResolver } from './noderun-helpers.js';

const APPLY_USAGE = `Usage: llamactl apply -f <manifest.yaml> [--evict <name>]... [--force]

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

Usage: llamactl describe node <name> [--json]

Show the node budget rollup for declared workloads on that node.
`;

const DELETE_USAGE = `Usage: llamactl delete workload <name> [--keep-running]

Stop the server on the target node (unless --keep-running is set) and
remove the manifest file from the workloads directory.
`;

export interface NodeBudgetView {
  budget: number;
  reserved: number;
  workloads: Array<{
    name: string;
    endpoint: string | null;
    phase: string;
    expectedMemoryGiB: number | null;
  }>;
}

interface WorkloadTestSeams {
  getNodeClientByName?: typeof getNodeClientByName;
}

let workloadTestSeams: WorkloadTestSeams = {};

export function __setWorkloadTestSeams(seams: WorkloadTestSeams): void {
  workloadTestSeams = { ...seams };
}

export function __resetWorkloadTestSeams(): void {
  workloadTestSeams = {};
}

function getWorkloadNodeClient(name: string) {
  return (workloadTestSeams.getNodeClientByName ?? getNodeClientByName)(name);
}

export function renderNodeBudget(budget: NodeBudgetView): string {
  const pad = (s: string, w: number): string => (s.length >= w ? s : s + ' '.repeat(w - s.length));
  const out: string[] = [];
  out.push(`Budget:   ${budget.reserved.toFixed(1)} / ${budget.budget.toFixed(1)} GiB`);
  out.push(`Workloads:`);
  if (budget.workloads.length === 0) {
    out.push('  (none)');
  } else {
    const rows = budget.workloads.map((row) => ({
      name: row.name,
      endpoint: row.endpoint ?? '-',
      phase: row.phase.toLowerCase(),
      memory: row.expectedMemoryGiB == null ? '-' : `${row.expectedMemoryGiB.toFixed(1)} GiB`,
    }));
    const nameW = Math.max(4, ...rows.map((r) => r.name.length));
    const endpointW = Math.max(8, ...rows.map((r) => r.endpoint.length));
    const phaseW = Math.max(5, ...rows.map((r) => r.phase.length));
    for (const row of rows) {
      out.push(`  ${pad(row.name, nameW)}  ${pad(row.endpoint, endpointW)}  ${pad(row.phase, phaseW)}  ${row.memory}`);
    }
  }
  if (budget.reserved > budget.budget) {
    out.push(`WARNING: budget exceeded (${budget.reserved.toFixed(1)} > ${budget.budget.toFixed(1)} GiB) — applies will require --force`);
  }
  return out.join('\n') + '\n';
}

interface ApplyFlags {
  file: string;
  json: boolean;
  evict: string[];
  force: boolean;
}

function parseApplyFlags(args: string[]): ApplyFlags | { error: string } {
  let file = '';
  let json = false;
  const evict: string[] = [];
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-f' || arg === '--file') {
      file = args[++i] ?? '';
    } else if (arg.startsWith('--file=')) {
      file = arg.slice('--file='.length);
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--evict') {
      const value = args[++i] ?? '';
      if (!value) return { error: 'apply: --evict requires a value' };
      evict.push(value);
    } else if (arg.startsWith('--evict=')) {
      const value = arg.slice('--evict='.length);
      if (!value) return { error: 'apply: --evict requires a value' };
      evict.push(value);
    } else if (arg === '--force') {
      force = true;
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
  return { file, json, evict, force };
}

export function stampApplyAnnotations(
  manifest: workloadSchema.ModelRun,
  flags: Pick<ApplyFlags, 'evict' | 'force'>,
): workloadSchema.ModelRun {
  if (flags.evict.length === 0 && !flags.force) return manifest;
  const annotations = manifest.metadata.annotations;
  if (flags.evict.length > 0) {
    annotations['llamactl.io/evict'] = flags.evict.join(',');
  }
  if (flags.force) {
    annotations['llamactl.io/force-admit'] = 'true';
  }
  return manifest;
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
  // Peek at `kind` to route — ModelRun and NodeRun have different
  // schemas + different applier semantics but share the apply CLI.
  let kind: string | undefined;
  try {
    kind = (parseYaml(raw) as { kind?: string } | null)?.kind;
  } catch {
    process.stderr.write(`apply: manifest YAML is not parseable\n`);
    return 1;
  }
  if (kind === 'NodeRun') {
    return applyNodeRunFromRaw(raw, parsed.json);
  }
  if (kind === 'ModelHost') {
    return applyModelHostFromRaw(raw, parsed.json);
  }
  return applyModelRunFromRaw(raw, parsed.json, parsed);
}

async function applyModelRunFromRaw(
  raw: string,
  json: boolean,
  flags: Pick<ApplyFlags, 'evict' | 'force'>,
): Promise<number> {
  let manifest: workloadSchema.ModelRun;
  try {
    manifest = workloadStore.parseWorkload(raw);
    stampApplyAnnotations(manifest, flags);
  } catch (err) {
    process.stderr.write(`apply: manifest rejected: ${(err as Error).message}\n`);
    return 1;
  }

  let result: workloadApply.ApplyResult;
  try {
    // Resolve the target node against the current kubeconfig so the
    // gateway dispatcher can route sirius/embersynth manifests to the
    // right handler. Non-gateway manifests never touch this path.
    const cfg = kubecfg.loadConfig();
    const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
    const cluster = cfg.clusters.find((c) => c.name === ctx?.cluster);
    const lookupNode = (name: string) =>
      (cluster?.nodes ?? []).find((n) => n.name === name);
    const gatewayDispatch = (opts: Parameters<NonNullable<Parameters<typeof workloadApply.applyOne>[3]>>[0]) =>
      workloadGatewayHandlers.dispatchGatewayApply({
        manifest: opts.manifest,
        getClient: opts.getClient,
        resolveNode: lookupNode,
        ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      });
    result = await workloadApply.applyOne(
      manifest,
      (name) => getNodeClientByName(name),
      undefined,
      gatewayDispatch,
      {
        resolveNodeIdentity: (n) => lookupNode(n)?.endpoint ?? null,
      },
    );
  } catch (err) {
    process.stderr.write(`apply: ${(err as Error).message}\n`);
    return 1;
  }
  if (result.error) {
    process.stderr.write(`apply: ${result.error}\n`);
    return 1;
  }

  const persisted: workloadSchema.ModelRun = {
    ...manifest,
    status: result.statusSection,
  };
  const savedPath = workloadStore.saveWorkload(persisted);

  // Gateway manifests land as Pending (upstream missing) or Failed
  // (reload call didn't succeed). Surface both as a non-zero exit —
  // the manifest is persisted either way so the operator can inspect
  // it with `llamactl describe workload` but the run itself is
  // incomplete. Agent manifests that reach 'started' always produce
  // phase=Running here, so the check only fires on gateway paths.
  const phase = result.statusSection.phase;
  const conditionMessage = result.statusSection.conditions[0]?.message ?? '';
  const conditionReason = result.statusSection.conditions[0]?.reason ?? '';
  const gatewayIncomplete = manifest.spec.gateway && phase !== 'Running';
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ action: result.action, path: savedPath, status: result.statusSection }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `${result.action} modelrun/${manifest.metadata.name} on node ${manifest.spec.node}\n`,
    );
    process.stdout.write(`  manifest: ${savedPath}\n`);
    process.stdout.write(`  phase:    ${phase}\n`);
    if (result.statusSection.endpoint) {
      process.stdout.write(`  endpoint: ${result.statusSection.endpoint}\n`);
    }
    if (result.statusSection.serverPid) {
      process.stdout.write(`  pid:      ${result.statusSection.serverPid}\n`);
    }
    if (gatewayIncomplete) {
      process.stderr.write(
        `apply: gateway workload did not reach Running (phase=${phase}, reason=${conditionReason}): ${conditionMessage}\n`,
      );
    }
  }
  return gatewayIncomplete ? 1 : 0;
}

async function applyNodeRunFromRaw(raw: string, json: boolean): Promise<number> {
  let manifest: noderunSchema.NodeRun;
  try {
    manifest = noderunStore.parseNodeRun(raw);
  } catch (err) {
    process.stderr.write(`apply: NodeRun manifest rejected: ${(err as Error).message}\n`);
    return 1;
  }
  const client = getNodeClientByName(manifest.spec.node);
  const resolveArtifact = makeSpecArtifactResolver({ client });
  let result: noderunApply.NodeRunApplyResult;
  try {
    result = await noderunApply.applyNodeRun(manifest, {
      client,
      resolveArtifact,
    });
  } catch (err) {
    process.stderr.write(`apply: ${(err as Error).message}\n`);
    return 1;
  }
  const persisted: noderunSchema.NodeRun = { ...manifest, status: result.status };
  const savedPath = noderunStore.saveNodeRun(persisted);
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ actions: result.actions, outcomes: result.outcomes, status: result.status, path: savedPath }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `${result.status.phase.toLowerCase()} noderun/${manifest.metadata.name} on node ${manifest.spec.node}\n`,
    );
    process.stdout.write(`  manifest: ${savedPath}\n`);
    const nonSkip = result.actions.filter((a) => a.type !== 'skip');
    if (nonSkip.length === 0) {
      process.stdout.write(`  no changes — every infra entry already at desired version\n`);
    } else {
      process.stdout.write(`  actions:\n`);
      for (const outcome of result.outcomes) {
        const a = outcome.action;
        const tail = outcome.ok ? '' : `  ERROR: ${outcome.error ?? '(unknown)'}`;
        const label =
          a.type === 'install' ? `install ${a.pkg}@${a.version} (${a.reason})`
          : a.type === 'activate' ? `activate ${a.pkg}@${a.version}`
          : a.type === 'uninstall-version' ? `uninstall ${a.pkg}@${a.version} (${a.reason})`
          : a.type === 'uninstall-pkg' ? `uninstall ${a.pkg} (${a.reason})`
          : `skip ${a.pkg}@${a.version} (${a.reason})`;
        process.stdout.write(`    * ${label}${tail}\n`);
      }
    }
  }
  return result.error ? 1 : 0;
}

async function applyModelHostFromRaw(raw: string, json: boolean): Promise<number> {
  let manifest: unknown;
  try {
    manifest = parseYaml(raw);
  } catch (err) {
    process.stderr.write(`apply: ModelHost manifest YAML parse failed: ${(err as Error).message}\n`);
    return 1;
  }

  try {
    const outcome = await workloadApply.applyManifest({
      manifest,
      getClient: (name) => getWorkloadNodeClient(name),
    });
    if (!outcome.ok) {
      process.stderr.write(`apply: ${outcome.error}\n`);
      return 1;
    }
    if (outcome.kind !== 'ModelHost') {
      process.stderr.write(`apply: expected ModelHost outcome, got ${outcome.kind}\n`);
      return 1;
    }
    saveModelHost(outcome.manifest);
    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            action: 'started',
            kind: 'ModelHost',
            name: outcome.manifest.metadata.name,
            pid: outcome.pid,
            endpoint: outcome.endpoint,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(
        `modelhost/${outcome.manifest.metadata.name}: ModelHost ready at ${outcome.endpoint}${typeof outcome.pid === 'number' ? ` pid=${outcome.pid}` : ' pid=remote'}\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`apply: ${(err as Error).message}\n`);
    return 1;
  }
}

type WorkloadRow = {
  name: string;
  node: string;
  phase: 'Running' | 'Stopped' | 'Mismatch' | 'Unreachable' | 'Pending' | 'Failed';
  rel: string;
  endpoint: string | null;
  gateway: boolean;
};

async function inspect(
  manifest: workloadSchema.ModelRun,
): Promise<WorkloadRow> {
  // Gateway manifests never run a local server on a reachable agent
  // — their phase lives in the persisted status the handler wrote.
  // Probing serverStatus would always return Unreachable because the
  // target node is a gateway (cloud kind, no agent tRPC endpoint).
  if (manifest.spec.gateway) {
    const status = manifest.status;
    const phase = (status?.phase ?? 'Pending') as WorkloadRow['phase'];
    return {
      name: manifest.metadata.name,
      node: manifest.spec.node,
      phase,
      rel: manifest.spec.target.value,
      endpoint: status?.endpoint ?? null,
      gateway: true,
    };
  }

  try {
    const client = getNodeClientByName(manifest.spec.node);
    const status = await client.serverStatus.query({ workload: manifest.metadata.name });
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
      gateway: false,
    };
  } catch {
    return {
      name: manifest.metadata.name,
      node: manifest.spec.node,
      phase: 'Unreachable',
      rel: manifest.spec.target.value,
      endpoint: null,
      gateway: false,
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
  if (sub === 'noderuns' || sub === 'noderun') {
    return runGetNodeRuns(json);
  }
  if (sub !== 'workloads' && sub !== 'workload') {
    process.stderr.write(GET_USAGE);
    return 1;
  }

  const manifests = workloadStore.listWorkloads();
  const modelHosts = listModelHosts();
  const rows = [
    ...(await Promise.all(manifests.map(inspect))).map((row) => ({
      ...row,
      kind: 'modelrun' as const,
    })),
    ...modelHosts.map((manifest) => {
      const state = readModelHostState({ name: manifest.metadata.name });
      return {
        kind: 'modelhost' as const,
        name: manifest.metadata.name,
        node: manifest.spec.node,
        phase: state ? 'Running' : 'unknown',
        rel: manifest.spec.hostedModels.map((m) => m.rel).join(', '),
        endpoint: state ? `http://${state.host}:${state.port}` : null,
        gateway: false,
      };
    }),
  ];
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
  const kindW = 9;
  process.stdout.write(
    `${pad('NAME', nameW)}  ${pad('NODE', nodeW)}  ${pad('KIND', kindW)}  ${pad('PHASE', phaseW)}  REL\n`,
  );
  for (const r of rows) {
    process.stdout.write(
      `${pad(r.name, nameW)}  ${pad(r.node, nodeW)}  ${pad(r.kind, kindW)}  ${pad(r.phase, phaseW)}  ${r.rel}\n`,
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
  if ((kind === 'noderun' || kind === 'noderuns') && name) {
    return runDescribeNodeRun(name, json);
  }
  if (kind === 'node' && name) {
    return runDescribeNode(name, json);
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
    liveStatus = await client.serverStatus.query({ workload: manifest.metadata.name });
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

async function runDescribeNode(name: string, json: boolean): Promise<number> {
  try {
    const client = getNodeClientByName(name);
    const budget = await client.nodeBudget.query({ node: name });
    if (json) {
      process.stdout.write(`${JSON.stringify(budget, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(renderNodeBudget(budget));
    return 0;
  } catch (err) {
    process.stderr.write(`describe: ${(err as Error).message}\n`);
    return 1;
  }
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
  if ((kind === 'noderun' || kind === 'noderuns') && name) {
    const removed = noderunStore.deleteNodeRun(name);
    if (!removed) {
      process.stderr.write(`delete: noderun ${name} not found\n`);
      return 1;
    }
    process.stdout.write(`deleted noderun/${name}\n`);
    return 0;
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
      const status = await client.serverStatus.query({ workload: manifest.metadata.name });
      // Only stop the server if the running rel matches this workload's
      // target. If something else is running there (perhaps another
      // workload was applied on top), leave it alone.
      if (status.state === 'up' && status.rel === manifest.spec.target.value) {
        await client.serverStop.mutate({ workload: manifest.metadata.name, graceSeconds: 5 });
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

    // Stop rpc-server workers in reverse order. Best-effort — we still
    // want to remove the manifest even if a worker node is unreachable.
    for (const worker of [...manifest.spec.workers].reverse()) {
      try {
        const wc = getNodeClientByName(worker.node);
        await wc.rpcServerStop.mutate({ graceSeconds: 3 });
        process.stdout.write(`stopped rpc-server on worker ${worker.node}\n`);
      } catch (err) {
        process.stderr.write(
          `warning: failed to stop rpc-server on ${worker.node}: ${(err as Error).message}\n`,
        );
      }
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

// ---- NodeRun handlers --------------------------------------------

async function runGetNodeRuns(json: boolean): Promise<number> {
  const manifests = noderunStore.listNodeRuns();
  if (json) {
    process.stdout.write(`${JSON.stringify(manifests, null, 2)}\n`);
    return 0;
  }
  if (manifests.length === 0) {
    process.stdout.write('No NodeRuns registered.\n');
    return 0;
  }
  const pad = (s: string, w: number): string =>
    s.length >= w ? s : s + ' '.repeat(w - s.length);
  const rows = manifests.map((m) => ({
    name: m.metadata.name,
    node: m.spec.node,
    phase: m.status?.phase ?? 'Pending',
    infra: m.spec.infra.map((i) => `${i.pkg}@${i.version}`).join(','),
  }));
  const nameW = Math.max(4, ...rows.map((r) => r.name.length));
  const nodeW = Math.max(4, ...rows.map((r) => r.node.length));
  const phaseW = Math.max(5, ...rows.map((r) => r.phase.length));
  process.stdout.write(
    `${pad('NAME', nameW)}  ${pad('NODE', nodeW)}  ${pad('PHASE', phaseW)}  INFRA\n`,
  );
  for (const r of rows) {
    process.stdout.write(
      `${pad(r.name, nameW)}  ${pad(r.node, nodeW)}  ${pad(r.phase, phaseW)}  ${r.infra}\n`,
    );
  }
  return 0;
}

async function runDescribeNodeRun(name: string, json: boolean): Promise<number> {
  let manifest: noderunSchema.NodeRun;
  try {
    manifest = noderunStore.loadNodeRunByName(name);
  } catch (err) {
    process.stderr.write(`describe: ${(err as Error).message}\n`);
    return 1;
  }
  let liveInfra: unknown = null;
  try {
    const client = getNodeClientByName(manifest.spec.node);
    liveInfra = await client.infraList.query();
  } catch (err) {
    liveInfra = { error: (err as Error).message };
  }
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ manifest, liveInfra }, null, 2)}\n`,
    );
    return 0;
  }
  process.stdout.write(`Name:       ${manifest.metadata.name}\n`);
  process.stdout.write(`Node:       ${manifest.spec.node}\n`);
  process.stdout.write(`Infra:\n`);
  for (const item of manifest.spec.infra) {
    const flags = [
      item.service ? 'service' : 'binary',
      ...(item.tarballUrl ? ['ad-hoc-artifact'] : []),
    ].join(',');
    process.stdout.write(`  * ${item.pkg}@${item.version}  (${flags})\n`);
  }
  if (manifest.status) {
    process.stdout.write(
      `Status:     phase=${manifest.status.phase} since=${manifest.status.lastTransitionTime}\n`,
    );
  }
  process.stdout.write(
    `LiveInfra:  ${JSON.stringify(liveInfra, null, 2).replace(/\n/g, '\n            ')}\n`,
  );
  return 0;
}
