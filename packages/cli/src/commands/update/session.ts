// Everything `llamactl update` learns before it decides anything: the
// checkout, the services and the environment they run with, the managed model
// hosts, the agent, and whether this process runs inside a unit it would
// restart. Read-only apart from `git fetch`.
import { sourceRevision } from "@llamactl/core";
import { workloadStore } from "@llamactl/remote";
import { join } from "node:path";

import type { UpdateDeps } from "./deps.js";
import type { UpdateFlags } from "./flags.js";

import {
  type CheckoutState,
  fetchArgs,
  type GitFn,
  makeGit,
  originGithubRepo,
  readCheckout,
  UpdateError,
} from "./git.js";
import { defaultUpdateHistoryPath } from "./history.js";
import {
  type AgentEndpoint,
  agentHealthy,
  hostBaseUrl,
  hostIdle,
  hostReady,
  type IdleState,
  resolveAgentEndpoint,
} from "./probes.js";
import { controllerLogSource, type LogSource, type SnapshotHost } from "./procedure.js";
import {
  ancestorPids,
  cgroupWithin,
  checkServiceMatch,
  DEFAULT_UNITS,
  enclosingService,
  killModeProblem,
  killsChildren,
  makeServiceManager,
  parseCgroupPath,
  pickServiceManagerKind,
  serviceBun,
  type ServiceInfo,
  type ServiceManager,
  type ServiceManagerKind,
  type ServiceRole,
} from "./services.js";

export interface HostStatus extends SnapshotHost {
  url: string;
  ready: boolean;
  idle: IdleState;
}

export interface ServicesState {
  kind: ServiceManagerKind | null;
  manager: ServiceManager | null;
  controller: ServiceInfo | null;
  agent: ServiceInfo | null;
  /** Reasons --apply/--rollback cannot drive these services. */
  problems: string[];
  warnings: string[];
}

export interface Session {
  deps: UpdateDeps;
  flags: UpdateFlags;
  repo: string;
  git: GitFn;
  checkout: CheckoutState;
  services: ServicesState;
  /** The updater's own settings: the process env over the controller unit's env. */
  settingEnv: NodeJS.ProcessEnv;
  /** llamactl state paths: the controller unit's env over the process env. */
  stateEnv: NodeJS.ProcessEnv;
  hosts: HostStatus[];
  agentEndpoint: AgentEndpoint | null;
  agentHealthy: boolean;
  bun: string;
  historyPath: string;
  heavyLock: string | null;
  ghRepo: string | null;
  controllerLog: LogSource;
  /** Name of the unit this process runs inside, when it is one the update restarts. */
  insideUnit: string | null;
  warnings: string[];
}

function nonEmpty(value: string | undefined): string | null {
  const v = value?.trim();
  return v === undefined || v === "" ? null : v;
}

function resolveRepo(flags: UpdateFlags, deps: UpdateDeps): string {
  if (flags.repo !== null) return flags.repo;
  const root = sourceRevision.findRepoRoot(deps.moduleDir, {
    existsFn: (p) => deps.fileSize(p) !== null,
  });
  if (root === null) {
    throw new UpdateError(
      "this llamactl is not running from a git checkout; `llamactl update` updates source installs only (pass --repo <checkout>)",
    );
  }
  return root;
}

function unitName(
  flags: UpdateFlags,
  deps: UpdateDeps,
  kind: ServiceManagerKind,
  role: ServiceRole,
): { name: string; explicit: boolean } {
  const flag = role === "controller" ? flags.controllerUnit : flags.agentUnit;
  const env = nonEmpty(
    deps.env[
      role === "controller" ? "LLAMACTL_UPDATE_CONTROLLER_UNIT" : "LLAMACTL_UPDATE_AGENT_UNIT"
    ],
  );
  const explicit = flag ?? env;
  return explicit !== null
    ? { name: explicit, explicit: true }
    : { name: DEFAULT_UNITS[kind][role], explicit: false };
}

const UNIT_HELP =
  "configure the units with --controller-unit/--agent-unit (or LLAMACTL_UPDATE_CONTROLLER_UNIT / LLAMACTL_UPDATE_AGENT_UNIT), or run the services as the default units: see docs/self-update.md";

async function resolveServices(
  flags: UpdateFlags,
  deps: UpdateDeps,
  repo: string,
): Promise<ServicesState> {
  const state: ServicesState = {
    kind: null,
    manager: null,
    controller: null,
    agent: null,
    problems: [],
    warnings: [],
  };
  const kind = pickServiceManagerKind(flags.serviceManager, deps.platform);
  if (kind === null) {
    state.problems.push(
      `no supported service manager on ${deps.platform} (systemd --user on Linux, launchd on macOS)`,
    );
    return state;
  }
  state.kind = kind;
  const tool = kind === "systemd" ? "systemctl" : "launchctl";
  if (deps.which(tool) === null) {
    state.problems.push(`${tool} not found; cannot manage the llamactl services`);
    return state;
  }
  const manager = makeServiceManager(kind, deps.exec, deps.readFile, deps.uid, deps.env);
  state.manager = manager;
  for (const role of ["controller", "agent"] as const) {
    const { name, explicit } = unitName(flags, deps, kind, role);
    const info = await manager.describe(role, name, explicit);
    state[role] = info;
    const match = checkServiceMatch(info, repo);
    state.problems.push(...match.problems);
    state.warnings.push(...match.warnings);
  }
  if (state.problems.length > 0) state.problems.push(UNIT_HELP);
  return state;
}

async function snapshotHosts(deps: UpdateDeps, stateEnv: NodeJS.ProcessEnv): Promise<HostStatus[]> {
  const workloadsDir = workloadStore.defaultWorkloadsDir(stateEnv);
  return await Promise.all(
    deps.listManagedHosts(stateEnv).map(async (h) => ({
      ...h,
      reconciled: deps.fileSize(join(workloadsDir, `${h.name}.yaml`)) !== null,
      url: hostBaseUrl(h),
      ready: await hostReady(deps.httpGet, h),
      idle: await hostIdle(deps.httpGet, h),
    })),
  );
}

function loadedUnits(services: ServicesState): ServiceInfo[] {
  return [services.controller, services.agent].filter((u): u is ServiceInfo => u?.loaded === true);
}

/**
 * A unit stop or restart must not take a model host down. With a readable
 * cgroup, any process besides the unit's main one blocks a KillMode that kills
 * the cgroup; otherwise fall back to the hosts found through their pid files.
 */
function killModeProblems(
  deps: UpdateDeps,
  services: ServicesState,
  hosts: readonly HostStatus[],
): string[] {
  if (services.kind !== "systemd") return [];
  return loadedUnits(services).flatMap((unit) => {
    if (unit.cgroup === null || !killsChildren(unit)) return [];
    if (unit.cgroupProcs === null) return hostsInUnitCgroup(deps, unit, unit.cgroup, hosts);
    const problem = killModeProblem(unit);
    return problem === null ? [] : [problem];
  });
}

/** Fallback when the unit's cgroup.procs is unreadable: the hosts found through pid files. */
function hostsInUnitCgroup(
  deps: UpdateDeps,
  unit: ServiceInfo,
  cgroup: string,
  hosts: readonly HostStatus[],
): string[] {
  return hosts.flatMap((h) => {
    const hostCgroup = parseCgroupPath(deps.readFile(`/proc/${String(h.pid)}/cgroup`) ?? "");
    if (hostCgroup === null || !cgroupWithin(hostCgroup, cgroup)) return [];
    return [
      `${unit.name} has KillMode=${String(unit.killMode)}: stopping it would kill ${h.name} (pid ${String(h.pid)}); set KillMode=process on the unit first`,
    ];
  });
}

/** A unit whose main process is a model host is the wrong unit (e.g. a misnamed one). */
function hostUnitProblems(services: ServicesState, hosts: readonly HostStatus[]): string[] {
  return loadedUnits(services).flatMap((unit) => {
    const host = hosts.find((h) => h.pid === unit.pid);
    return host === undefined
      ? []
      : [
          `${unit.name}'s main process (pid ${String(host.pid)}) is model host ${host.name}; refusing to stop or restart it`,
        ];
  });
}

/** Manifests but no running hosts usually means the runtime dir is not the services'. */
function missingHostsWarning(
  deps: UpdateDeps,
  stateEnv: NodeJS.ProcessEnv,
  hosts: readonly HostStatus[],
): string[] {
  if (hosts.length > 0) return [];
  const dir = workloadStore.defaultWorkloadsDir(stateEnv);
  const manifests = (deps.listDir(dir) ?? []).filter(
    (f) => f.endsWith(".yaml") && !f.startsWith("."),
  );
  if (manifests.length === 0) return [];
  return [
    `${String(manifests.length)} workload manifest(s) in ${dir} but no running managed model host was found; if hosts are running, the runtime dir differs from the services' (check LOCAL_AI_RUNTIME_DIR)`,
  ];
}

async function findInsideUnit(deps: UpdateDeps, services: ServicesState): Promise<string | null> {
  const units = loadedUnits(services);
  if (units.length === 0) return null;
  if (services.kind === "systemd") {
    return (
      enclosingService(parseCgroupPath(deps.readFile("/proc/self/cgroup") ?? ""), units)?.name ??
      null
    );
  }
  const ancestors = new Set([deps.pid, ...(await ancestorPids(deps.exec, deps.pid))]);
  return units.find((u) => u.pid !== null && ancestors.has(u.pid))?.name ?? null;
}

export async function openSession(flags: UpdateFlags, deps: UpdateDeps): Promise<Session> {
  const repo = resolveRepo(flags, deps);
  const git = makeGit(deps.exec, repo);
  const warnings: string[] = [];
  const fetched = await git(fetchArgs(flags.ref));
  if (fetched.code !== 0) {
    warnings.push(
      `git fetch failed (${fetched.stderr.trim()}); using the local remote-tracking refs`,
    );
  }
  const checkout = await readCheckout(git);
  const services = await resolveServices(flags, deps, repo);
  const controllerEnv = services.controller?.env ?? {};
  const settingEnv = { ...controllerEnv, ...deps.env };
  const stateEnv = { ...deps.env, ...controllerEnv };
  const hosts = await snapshotHosts(deps, stateEnv);
  services.problems.push(
    ...killModeProblems(deps, services, hosts),
    ...hostUnitProblems(services, hosts),
  );
  const agentEndpoint =
    services.agent?.loaded !== true
      ? null
      : resolveAgentEndpoint({
          override: nonEmpty(settingEnv["LLAMACTL_UPDATE_AGENT_URL"]),
          argv: services.agent.argv,
          env: { ...deps.env, ...services.agent.env },
          readFile: deps.readFile,
        });
  const bun =
    [services.controller, services.agent]
      .map((u) => (u === null ? null : serviceBun(u, repo)))
      .find((b) => b !== null) ?? deps.execPath;
  return {
    deps,
    flags,
    repo,
    git,
    checkout,
    services,
    settingEnv,
    stateEnv,
    hosts,
    agentEndpoint,
    agentHealthy: agentEndpoint !== null && (await agentHealthy(deps.httpGet, agentEndpoint)),
    bun,
    historyPath: defaultUpdateHistoryPath({
      ...stateEnv,
      LLAMACTL_UPDATE_HISTORY: settingEnv["LLAMACTL_UPDATE_HISTORY"],
    }),
    heavyLock: nonEmpty(settingEnv["LLAMACTL_UPDATE_HEAVY_LOCK"]),
    ghRepo: nonEmpty(settingEnv["LLAMACTL_UPDATE_GH_REPO"]) ?? (await originGithubRepo(git)),
    controllerLog:
      services.controller === null
        ? { kind: "none" }
        : controllerLogSource(
            services.controller,
            nonEmpty(settingEnv["LLAMACTL_UPDATE_CONTROLLER_LOG"]),
          ),
    insideUnit: await findInsideUnit(deps, services),
    warnings: [...warnings, ...services.warnings, ...missingHostsWarning(deps, stateEnv, hosts)],
  };
}

/** Pre-update health that --apply requires: both services up and every managed host ready. */
export function healthProblems(s: Session): string[] {
  const problems: string[] = [];
  const { controller, agent } = s.services;
  for (const unit of [controller, agent]) {
    if (unit?.loaded === true && !unit.active) problems.push(`${unit.name} is not active`);
  }
  if (s.agentEndpoint !== null && !s.agentHealthy) {
    problems.push(`agent ${s.agentEndpoint.url}/healthz is not ok`);
  }
  for (const h of s.hosts) {
    if (!h.ready) problems.push(`model host ${h.name} (${h.url}) is not ready`);
  }
  return problems;
}
