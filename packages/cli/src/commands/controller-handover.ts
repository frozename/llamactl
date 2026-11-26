// #223: retiring a node's local controller for a central one. The seat must never
// be left unsupervised, so the local controller is stopped only after the central
// has proven it holds every local ModelHost: same spec hash, the same engine pid
// seen through its own route to this node, and a live controller lock of its own.
import { computeModelHostSpecHash, readModelHostState } from "@llamactl/core/engines/state";
import { modelHostStore, type NodeClient, workloadLock, workloadStore } from "@llamactl/remote";
import {
  externalManagerOf,
  LOCAL_NODE_ID,
  MANAGED_BY_LABEL,
  type ModelHostManifest,
  specForHash,
} from "@llamactl/remote/workload/modelhost-schema";

import { getNodeClientByName } from "../dispatcher.js";
import { defaultUpdateDeps, type ExecFn } from "./update/deps.js";
import {
  DEFAULT_UNITS,
  killModeProblem,
  killsChildren,
  makeServiceManager,
  pickServiceManagerKind,
  type ServiceInfo,
  type ServiceManager,
  type ServiceManagerKind,
} from "./update/services.js";

export interface HandoverLocalHost {
  name: string;
  /** Hash of the launch-affecting spec fields, as the reconciler computes it. */
  specHash: string;
  enabled: boolean;
  /** Value of llamactl.io/managed-by on the local copy, null when unlabelled. */
  managedBy: string | null;
}

/** The engine this node's own state sidecar records for a ModelHost. */
export interface HandoverEngineRecord {
  pid: number;
  specHash: string | null;
}

export type CentralLive =
  | { state: string; pid: number | null; specHash: string | null }
  | { error: string };

/** What the central controller reports about one ModelHost, through its own route. */
export interface CentralHostView {
  found: boolean;
  node: string | null;
  managedBy: string | null;
  specHash: string | null;
  live: CentralLive;
  /** Pid of the live controller lock on the central's workloads directory. */
  controllerPid: number | null;
}

export interface HandoverOptions {
  to: string;
  node: string;
  timeoutMs: number;
  pollMs: number;
  dryRun: boolean;
  controllerUnit: string | null;
}

export interface StopLocalResult {
  ok: boolean;
  detail: string;
}

export interface HandoverDeps {
  listLocalHosts: () => HandoverLocalHost[];
  listLocalModelRuns: () => string[];
  readLocalEngine: (name: string) => HandoverEngineRecord | null;
  queryCentral: (name: string) => Promise<CentralHostView>;
  labelHost: (name: string, manager: string) => void;
  unlabelHost: (name: string) => void;
  /** Why the local controller unit could not be stopped safely, or null. Runs before anything is written. */
  checkLocalController: () => Promise<string | null>;
  stopLocalController: () => Promise<StopLocalResult>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export const DEFAULT_HANDOVER_TIMEOUT_MS = 120_000;
export const DEFAULT_HANDOVER_POLL_MS = 2_000;

export const HANDOVER_USAGE = `Usage: llamactl controller handover --to=<central> --node=<name>
                                  [--timeout=<s>] [--dry-run] [--controller-unit=<name>]

Hand this node's ModelHosts over to a central controller, then stop the local
controller that used to supervise them.

The local controller is stopped only after the central confirms every local
ModelHost: same spec hash, the same engine pid seen through its own route to
this node, and a live controller lock on the directory holding those manifests.
Until that confirmation nothing is written and the local controller keeps
supervising the seat, so a hand-over can never leave it unsupervised.

Flags:
  --to=<central>          Name of the central controller's node (required).
  --node=<name>           This node's name, as the manifests spell it (required).
  --timeout=<s>           Seconds to wait for the central to adopt every host
                          (default 120).
  --dry-run               Verify the adoption and print the plan; write no
                          labels and do not stop the local controller.
  --controller-unit=<n>   Override the launchd label / systemd unit to stop.

A ModelHost already labelled for another manager is reported as skipped and
left alone. The hand-over refuses while an enabled ModelRun still runs here:
'llamactl controller handover' only moves ModelHosts.

Adoption is confirmed by labelling each host 'llamactl.io/managed-by=<central>';
the local reconciler skips labelled hosts, so a restarted local controller
cannot reclaim the seat. If the stop itself fails the labels stay: the hosts
are handed over and the still-running local controller skips them. After the
stop the unit is disabled so it does not start again at the next boot.

The hand-over refuses up front, before anything is written, when the local
controller unit cannot be stopped without taking its engines down: a systemd
unit with KillMode=control-group or KillMode=mixed kills every engine in its
cgroup on stop. Set KillMode=process on the unit first.
`;

function flagValue(arg: string, prefix: string): string {
  return arg.slice(prefix.length);
}

function parseTimeout(arg: string, seconds: string): number | { error: string } {
  const value = Number.parseFloat(seconds);
  if (!Number.isFinite(value) || value <= 0) {
    return { error: `controller handover: invalid --timeout: ${arg}` };
  }
  return Math.round(value * 1000);
}

function parsePoll(arg: string, seconds: string): number | { error: string } {
  const value = Number.parseFloat(seconds);
  if (!Number.isFinite(value) || value <= 0) {
    return { error: `controller handover: invalid --poll: ${arg}` };
  }
  return Math.round(value * 1000);
}

interface HandoverFlagState {
  to: string;
  node: string;
  timeoutMs: number;
  pollMs: number;
  dryRun: boolean;
  controllerUnit: string | null;
}

type FlagResult = { value: Partial<HandoverFlagState> } | { error: string };

function parseHandoverFlag(arg: string): FlagResult {
  if (arg === "--dry-run") return { value: { dryRun: true } };
  if (arg.startsWith("--to=")) return { value: { to: flagValue(arg, "--to=") } };
  if (arg.startsWith("--node=")) return { value: { node: flagValue(arg, "--node=") } };
  if (arg.startsWith("--controller-unit=")) {
    const unit = flagValue(arg, "--controller-unit=");
    if (unit === "") return { error: "controller handover: --controller-unit needs a name" };
    return { value: { controllerUnit: unit } };
  }
  if (arg.startsWith("--timeout=")) {
    const parsed = parseTimeout(arg, flagValue(arg, "--timeout="));
    return typeof parsed === "number" ? { value: { timeoutMs: parsed } } : parsed;
  }
  if (arg.startsWith("--poll=")) {
    const parsed = parsePoll(arg, flagValue(arg, "--poll="));
    return typeof parsed === "number" ? { value: { pollMs: parsed } } : parsed;
  }
  return { error: `controller handover: unknown flag ${arg}` };
}

export function parseHandoverFlags(args: readonly string[]): HandoverOptions | { error: string } {
  const state: HandoverFlagState = {
    to: "",
    node: "",
    timeoutMs: DEFAULT_HANDOVER_TIMEOUT_MS,
    pollMs: DEFAULT_HANDOVER_POLL_MS,
    dryRun: false,
    controllerUnit: null,
  };
  for (const arg of args) {
    if (arg === "-h" || arg === "--help") return { error: "help" };
    const parsed = parseHandoverFlag(arg);
    if ("error" in parsed) return parsed;
    Object.assign(state, parsed.value);
  }
  if (state.to === "") return { error: "controller handover: --to=<central> is required" };
  if (state.node === "") return { error: "controller handover: --node=<name> is required" };
  return {
    to: state.to,
    node: state.node,
    timeoutMs: state.timeoutMs,
    pollMs: state.pollMs,
    dryRun: state.dryRun,
    controllerUnit: state.controllerUnit,
  };
}

/**
 * Why the central has not adopted this host yet, or null when it has. The engine
 * checks only apply while this node still has a live engine record: a host the
 * local node holds stopped is adopted on the manifest alone.
 */
export function adoptionProblem(
  host: HandoverLocalHost,
  engine: HandoverEngineRecord | null,
  view: CentralHostView,
  opts: Pick<HandoverOptions, "to" | "node">,
): string | null {
  const ref = `modelhost/${host.name}`;
  if (!view.found) return `${ref}: central ${opts.to} holds no ModelHost ${host.name}`;
  if (view.controllerPid === null) return `${ref}: no live controller on ${opts.to}`;
  if (view.managedBy !== null) {
    return `${ref}: the central copy is itself marked ${MANAGED_BY_LABEL}=${view.managedBy}`;
  }
  if (view.node !== opts.node) {
    return `${ref}: the central copy targets node ${String(view.node)}, not ${opts.node}`;
  }
  if (view.specHash !== host.specHash) {
    return `${ref}: central spec ${String(view.specHash)} differs from local spec ${host.specHash}`;
  }
  if ("error" in view.live) {
    return `${ref}: ${opts.to} cannot reach this node: ${view.live.error}`;
  }
  if (engine === null) return null;
  if (view.live.state !== "Running" || view.live.pid !== engine.pid) {
    return `${ref}: central sees ${view.live.state} pid ${String(view.live.pid)}, not engine pid ${String(engine.pid)}`;
  }
  if (view.live.specHash !== null && view.live.specHash !== host.specHash) {
    return `${ref}: the running spec hash ${view.live.specHash} differs from local spec ${host.specHash}`;
  }
  return null;
}

function hostRef(name: string): string {
  return `modelhost/${name}`;
}

function describeHost(host: HandoverLocalHost, opts: HandoverOptions): string {
  return `${hostRef(host.name)} (${host.enabled ? "enabled" : "disabled"}, adopted by ${opts.to})`;
}

async function candidateProblem(
  host: HandoverLocalHost,
  opts: HandoverOptions,
  deps: HandoverDeps,
): Promise<string | null> {
  let view: CentralHostView;
  try {
    view = await deps.queryCentral(host.name);
  } catch (err) {
    return `${hostRef(host.name)}: cannot query ${opts.to}: ${(err as Error).message}`;
  }
  return adoptionProblem(host, deps.readLocalEngine(host.name), view, opts);
}

/** One poll round: every candidate still unconfirmed on the previous round. */
async function pollAdoption(
  candidates: readonly HandoverLocalHost[],
  previous: ReadonlyMap<string, string>,
  opts: HandoverOptions,
  deps: HandoverDeps,
): Promise<Map<string, string>> {
  const problems = new Map<string, string>();
  for (const host of candidates) {
    if (previous.size > 0 && !previous.has(host.name)) continue;
    const problem = await candidateProblem(host, opts, deps);
    if (problem !== null) problems.set(host.name, problem);
  }
  return problems;
}

function reportTimeout(
  problems: ReadonlyMap<string, string>,
  opts: HandoverOptions,
  deps: HandoverDeps,
): number {
  for (const problem of problems.values()) deps.stderr(`controller handover: ${problem}`);
  deps.stderr(
    `controller handover: ${opts.to} had not adopted every host within ${String(
      Math.round(opts.timeoutMs / 1000),
    )}s; nothing was labelled and the local controller keeps supervising them`,
  );
  return 1;
}

/** (c) Poll until every candidate is adopted, or the timeout gives up. */
async function verifyAdoption(
  candidates: readonly HandoverLocalHost[],
  opts: HandoverOptions,
  deps: HandoverDeps,
): Promise<number> {
  const start = deps.now();
  let problems = new Map<string, string>();
  for (;;) {
    problems = await pollAdoption(candidates, problems, opts, deps);
    if (problems.size === 0) return 0;
    if (deps.now() - start >= opts.timeoutMs) return reportTimeout(problems, opts, deps);
    await deps.sleep(opts.pollMs);
  }
}

/** (e) Label the hosts still missing the label; roll this run's labels back on failure. */
function labelCandidates(
  candidates: readonly HandoverLocalHost[],
  opts: HandoverOptions,
  deps: HandoverDeps,
): string[] | null {
  const labeled: string[] = [];
  for (const host of candidates) {
    if (host.managedBy === opts.to) continue;
    try {
      deps.labelHost(host.name, opts.to);
      labeled.push(host.name);
    } catch (err) {
      for (const name of labeled) deps.unlabelHost(name);
      deps.stderr(
        `controller handover: labeling failed after ${String(labeled.length)} label(s), rolled back: ${(err as Error).message}`,
      );
      return null;
    }
  }
  return labeled;
}

/** (f) The stop comes last. Labels stay put: a still-running local controller skips them. */
async function stopAfterHandover(
  candidates: readonly HandoverLocalHost[],
  opts: HandoverOptions,
  deps: HandoverDeps,
): Promise<number> {
  const stop = await deps.stopLocalController();
  const names = candidates.map((host) => hostRef(host.name)).join(", ");
  if (stop.ok) {
    deps.stdout(`controller handover: ${names} handed over to ${opts.to}; ${stop.detail}`);
    return 0;
  }
  deps.stderr(
    `controller handover: ${names} are handed over to ${opts.to} (labelled ${MANAGED_BY_LABEL}=${opts.to}) ` +
      `but the local controller is still running; it skips these hosts while the labels stay, so re-run ` +
      `'llamactl controller handover --to=${opts.to} --node=${opts.node}' or stop it by hand`,
  );
  deps.stderr(`controller handover: ${stop.detail}`);
  return 1;
}

function reportPlan(
  candidates: readonly HandoverLocalHost[],
  opts: HandoverOptions,
  deps: HandoverDeps,
): void {
  deps.stdout(
    `controller handover: ${opts.to} has adopted ${String(candidates.length)} local ModelHost(s)`,
  );
  for (const host of candidates) deps.stdout(`  ${describeHost(host, opts)}`);
}

export async function runControllerHandover(
  opts: HandoverOptions,
  deps: HandoverDeps,
): Promise<number> {
  const modelRuns = deps.listLocalModelRuns();
  if (modelRuns.length > 0) {
    deps.stderr(
      `controller handover: refusing while enabled ModelRun(s) still run on ${opts.node}: ${modelRuns.join(", ")}`,
    );
    deps.stderr(
      "controller handover: stop those workloads first; hand-over covers ModelHosts only",
    );
    return 1;
  }
  const candidates: HandoverLocalHost[] = [];
  for (const host of deps.listLocalHosts()) {
    if (host.managedBy !== null && host.managedBy !== opts.to) {
      deps.stdout(
        `${hostRef(host.name)}: skipped (already managed by ${host.managedBy}, not ${opts.to})`,
      );
      continue;
    }
    candidates.push(host);
  }
  const unitProblem = await deps.checkLocalController();
  if (unitProblem !== null) {
    deps.stderr(`controller handover: ${unitProblem}`);
    deps.stderr("controller handover: nothing was labelled and the local controller keeps running");
    return 1;
  }
  if ((await verifyAdoption(candidates, opts, deps)) !== 0) return 1;
  if (opts.dryRun) {
    reportPlan(candidates, opts, deps);
    deps.stdout("controller handover: --dry-run wrote no labels and left the controller running");
    return 0;
  }
  if (labelCandidates(candidates, opts, deps) === null) return 1;
  return await stopAfterHandover(candidates, opts, deps);
}

// ---- production deps -------------------------------------------------------

function localHostView(manifest: ModelHostManifest): HandoverLocalHost {
  return {
    name: manifest.metadata.name,
    specHash: computeModelHostSpecHash(specForHash(manifest.spec)),
    enabled: manifest.spec.enabled,
    managedBy: externalManagerOf(manifest),
  };
}

function notFoundView(): CentralHostView {
  return {
    found: false,
    node: null,
    managedBy: null,
    specHash: null,
    live: { error: "not found" },
    controllerPid: null,
  };
}

export function isMissingWorkload(err: unknown): boolean {
  const error = err as { code?: unknown; message?: unknown };
  if (error.code === "NOT_FOUND") return true;
  const message = typeof error.message === "string" ? error.message : String(err);
  return message.toLowerCase().includes("not found");
}

function centralLive(status: unknown): CentralLive {
  if (typeof status !== "object" || status === null) return { error: String(status) };
  const record = status as Record<string, unknown>;
  const error = record["error"];
  if (typeof error === "string") return { error };
  const pid = record["pid"];
  const specHash = record["specHash"];
  const state = record["state"];
  return {
    state: typeof state === "string" ? state : "Unknown",
    pid: typeof pid === "number" ? pid : null,
    specHash: typeof specHash === "string" ? specHash : null,
  };
}

export type WorkloadDescribeResult = Awaited<ReturnType<NodeClient["workloadDescribe"]["query"]>>;

export function describeView(result: WorkloadDescribeResult): CentralHostView {
  const manifest = result.manifest;
  const host = manifest.kind === "ModelHost" ? manifest : null;
  return {
    found: true,
    node: manifest.spec.node,
    managedBy: host === null ? null : externalManagerOf(host),
    specHash: host === null ? null : computeModelHostSpecHash(specForHash(host.spec)),
    live: centralLive(result.liveStatus),
    controllerPid: result.controllerPid ?? null,
  };
}

function withoutManagedBy(labels: Record<string, string> | undefined): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (key !== MANAGED_BY_LABEL) kept[key] = value;
  }
  return kept;
}

function setManagedByLabel(
  workloadsDir: string,
  name: string,
  manager: string | null,
): ModelHostManifest {
  const host = modelHostStore.loadModelHostByName(name, workloadsDir);
  const labels = withoutManagedBy(host.metadata.labels);
  if (manager !== null) labels[MANAGED_BY_LABEL] = manager;
  return { ...host, metadata: { ...host.metadata, labels } };
}

/**
 * Effects the production deps run through, injectable so tests drive them with
 * a temp workloads directory and fake exec/clock instead of the real host.
 */
export interface HandoverSystem {
  exec: ExecFn;
  readFile: (path: string) => string | null;
  uid: number;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  liveLockHolder: (workloadsDir: string) => number | null;
  describeCentral: (to: string, name: string) => Promise<WorkloadDescribeResult>;
  readEngineState: (name: string) => { pid: number; specHash?: string | null } | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise<void>((resolve): void => {
    setTimeout(resolve, ms);
  });
}

export function defaultHandoverSystem(): HandoverSystem {
  const update = defaultUpdateDeps();
  return {
    exec: update.exec,
    readFile: update.readFile,
    uid: update.uid,
    env: update.env,
    platform: process.platform,
    liveLockHolder: (workloadsDir: string): number | null =>
      workloadLock.liveLockHolder(workloadsDir),
    describeCentral: async (to: string, name: string): Promise<WorkloadDescribeResult> =>
      await getNodeClientByName(to).workloadDescribe.query({ name }),
    readEngineState: (name: string): { pid: number; specHash?: string | null } | null =>
      readModelHostState({ name }),
    now: (): number => Date.now(),
    sleep: sleepMs,
    stdout: (line: string): void => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line: string): void => {
      process.stderr.write(`${line}\n`);
    },
  };
}

export async function waitForLockRelease(
  workloadsDir: string,
  info: ServiceInfo,
  opts: Pick<HandoverOptions, "timeoutMs" | "pollMs">,
  system: Pick<HandoverSystem, "liveLockHolder" | "now" | "sleep">,
): Promise<StopLocalResult> {
  const deadline = system.now() + opts.timeoutMs;
  for (;;) {
    if (system.liveLockHolder(workloadsDir) === null) {
      return { ok: true, detail: `stopped ${info.name} (pid ${String(info.pid ?? "?")})` };
    }
    if (system.now() >= deadline) {
      const holder = system.liveLockHolder(workloadsDir);
      return {
        ok: false,
        detail: `${info.name} was stopped but the controller lock at ${workloadLock.lockFilePath(workloadsDir)} is still held by pid ${String(holder ?? "?")}`,
      };
    }
    await system.sleep(Math.min(opts.pollMs, 1_000));
  }
}

/**
 * Why stopping this controller unit would take the engines it spawned down, or
 * null when it is safe. The same guard 'llamactl update' applies: a KillMode
 * that kills the unit's whole cgroup (control-group, mixed) refuses, naming the
 * other processes when the cgroup is readable. A hand-over must leave the
 * engines running for the central, so it refuses even when no engine is
 * visible in the cgroup right now.
 */
export function handoverKillModeProblem(info: ServiceInfo): string | null {
  if (!killsChildren(info)) return null;
  return (
    killModeProblem(info) ??
    `${info.name} has KillMode=${String(info.killMode)}: stopping it would kill every ModelHost engine it spawned; set KillMode=process on the unit first`
  );
}

interface ControllerUnit {
  kind: ServiceManagerKind;
  manager: ServiceManager;
  info: ServiceInfo;
}

type UnitLookup = { holder: null } | { holder: number; unit: ControllerUnit } | { problem: string };

/** The loaded service unit running the local controller, or why it cannot be stopped. */
async function lookupControllerUnit(
  workloadsDir: string,
  opts: Pick<HandoverOptions, "controllerUnit">,
  system: HandoverSystem,
): Promise<UnitLookup> {
  const holder = system.liveLockHolder(workloadsDir);
  if (holder === null) return { holder: null };
  const kind = pickServiceManagerKind(null, system.platform);
  if (kind === null) {
    return {
      problem: `no service manager on ${system.platform}; the local controller (pid ${String(holder)}) holds ${workloadsDir}`,
    };
  }
  const name = opts.controllerUnit ?? DEFAULT_UNITS[kind].controller;
  const manager = makeServiceManager(kind, system.exec, system.readFile, system.uid, system.env);
  const info = await manager.describe("controller", name, opts.controllerUnit !== null);
  if (!info.loaded) {
    return {
      problem: `service ${name} is not loaded, so this command cannot stop the local controller (pid ${String(holder)}); stop it the way it was started`,
    };
  }
  const killMode = handoverKillModeProblem(info);
  if (killMode !== null) return { problem: `refusing to stop the local controller: ${killMode}` };
  return { holder, unit: { kind, manager, info } };
}

/** Keep the stopped unit from starting again at the next boot or login. */
async function disableUnit(unit: ControllerUnit, system: HandoverSystem): Promise<string | null> {
  const argv =
    unit.kind === "systemd"
      ? ["systemctl", "--user", "disable", unit.info.name]
      : ["launchctl", "disable", `gui/${String(system.uid)}/${unit.info.name}`];
  const r = await system.exec(argv);
  if (r.code === 0) return null;
  const detail = (r.stderr.trim() === "" ? r.stdout : r.stderr).trim();
  return `${argv.join(" ")} exited ${String(r.code)}: ${detail}; disable it by hand so it does not start again at boot`;
}

export async function checkLocalController(
  workloadsDir: string,
  opts: Pick<HandoverOptions, "controllerUnit">,
  system: HandoverSystem,
): Promise<string | null> {
  const lookup = await lookupControllerUnit(workloadsDir, opts, system);
  return "problem" in lookup ? lookup.problem : null;
}

export async function stopLocalController(
  workloadsDir: string,
  opts: Pick<HandoverOptions, "controllerUnit" | "timeoutMs" | "pollMs">,
  system: HandoverSystem,
): Promise<StopLocalResult> {
  const lookup = await lookupControllerUnit(workloadsDir, opts, system);
  if ("problem" in lookup) return { ok: false, detail: lookup.problem };
  if (lookup.holder === null) return { ok: true, detail: "no local controller running" };
  const { unit } = lookup;
  const stopped = await unit.manager.stop(unit.info);
  if (stopped.code !== 0) {
    const detail = (stopped.stderr.trim() === "" ? stopped.stdout : stopped.stderr).trim();
    return {
      ok: false,
      detail: `${unit.info.name} stop exited ${String(stopped.code)}: ${detail}`,
    };
  }
  const disableProblem = await disableUnit(unit, system);
  const released = await waitForLockRelease(workloadsDir, unit.info, opts, system);
  if (disableProblem === null) {
    return released.ok
      ? { ...released, detail: `${released.detail}; disabled ${unit.info.name}` }
      : released;
  }
  return { ok: released.ok, detail: `${released.detail}; but ${disableProblem}` };
}

export function defaultHandoverDeps(
  workloadsDir: string,
  opts: HandoverOptions,
  system: HandoverSystem = defaultHandoverSystem(),
): HandoverDeps {
  return {
    listLocalHosts: (): HandoverLocalHost[] =>
      modelHostStore
        .listModelHosts(workloadsDir)
        .filter((manifest) => manifest.spec.node === LOCAL_NODE_ID)
        .map(localHostView),
    listLocalModelRuns: (): string[] =>
      workloadStore
        .listWorkloads(workloadsDir)
        .filter((manifest) => manifest.spec.node === LOCAL_NODE_ID && manifest.spec.enabled)
        .map((manifest) => manifest.metadata.name),
    readLocalEngine: (name: string): HandoverEngineRecord | null => {
      const state = system.readEngineState(name);
      return state === null ? null : { pid: state.pid, specHash: state.specHash ?? null };
    },
    queryCentral: async (name: string): Promise<CentralHostView> => {
      let result: WorkloadDescribeResult;
      try {
        result = await system.describeCentral(opts.to, name);
      } catch (err) {
        if (isMissingWorkload(err)) return notFoundView();
        throw err;
      }
      return describeView(result);
    },
    labelHost: (name: string, manager: string): void => {
      modelHostStore.saveModelHost(setManagedByLabel(workloadsDir, name, manager), workloadsDir);
    },
    unlabelHost: (name: string): void => {
      modelHostStore.saveModelHost(setManagedByLabel(workloadsDir, name, null), workloadsDir);
    },
    checkLocalController: async (): Promise<string | null> =>
      await checkLocalController(workloadsDir, opts, system),
    stopLocalController: async (): Promise<StopLocalResult> =>
      await stopLocalController(workloadsDir, opts, system),
    now: system.now,
    sleep: system.sleep,
    stdout: system.stdout,
    stderr: system.stderr,
  };
}
