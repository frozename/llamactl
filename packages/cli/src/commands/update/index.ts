// `llamactl update` — safe self-update for a source install (a git checkout
// whose controller and agent services run bin.ts with bun). See
// docs/self-update.md for the procedure and its configuration.
import { defaultUpdateDeps, type UpdateDeps } from "./deps.js";
import { parseUpdateFlags, type UpdateFlags, type UpdateMode } from "./flags.js";
import {
  type BranchMode,
  changedFiles,
  commitsBetween,
  DEPLOY_BRANCH,
  depsChanged,
  type GitCommit,
  isAncestor,
  resolveCommit,
  restoreMode,
  UpdateError,
} from "./git.js";
import {
  applyStartLine,
  defaultRollbackTarget,
  failedLine,
  formatHistoryRef,
  type HistoryRef,
  okLine,
  parseHistoryRef,
  rollbackStartLine,
  rolledBackLine,
} from "./history.js";
import { ciState } from "./probes.js";
import {
  buildDeploySteps,
  buildInstallCommand,
  DEFAULT_TIMEOUTS,
  type DeployContext,
  type DeployOutcome,
  ensureControllerRunning,
  INTERRUPTED,
  runDeploy,
  type StepResult,
} from "./procedure.js";
import { healthProblems, openSession, type Session } from "./session.js";

export const UPDATE_USAGE = `Usage: llamactl update [--check | --apply | --rollback [<ref>]] [flags]

Update a source install of llamactl (a git checkout whose controller and
agent services run packages/cli/src/bin.ts with bun) to a newer commit,
or back, without stopping the model hosts it manages.

Modes:
  --check (default)    Fetch and report: current ref -> target, new commits,
                       whether dependencies changed, the target's CI state,
                       service and model-host state, and anything --apply
                       would refuse. Changes nothing but the git fetch.
  --apply              Update to the target. Refuses on tracked local changes,
                       a non-fast-forward target, a local main the target
                       lacks commits of, a target whose CI 'check' run is not
                       green, unhealthy services or hosts, a unit whose
                       KillMode would kill other processes, or when running
                       inside a unit it would restart. Then: take the
                       heavy-job lock (if set and dependencies changed), stop
                       the controller, switch the checkout to the target on
                       branch main, bun install, start the controller, release
                       the lock, wait for it to re-adopt the model hosts, wait
                       for idle hosts, restart the agent, verify. A failure
                       rolls back automatically (exit 1); the controller is
                       always started again before exiting, also on
                       SIGINT/SIGTERM (exit 130).
  --rollback [<ref>]   Same procedure back to <ref> (branch@sha, a sha, or any
                       revision); default: from the history (undo the last
                       verified update or rollback, or retry a failed
                       rollback).

Flags:
  --ref <ref>              Target for --check/--apply (default origin/main).
  --allow-red-ci           Apply even if the target's CI is not green.
  --wait-idle <s>          Wait up to <s> seconds for idle model hosts before
                           restarting the agent (default 600; best-effort).
  --json                   Machine output on stdout (progress goes to stderr).
  --repo <dir>             Checkout to update (default: the one running this CLI).
  --service-manager <m>    systemd | launchd (default: by platform).
  --controller-unit <n>    systemd unit / launchd label of the controller
                           (default llamactl-controller.service / com.llamactl.controller).
  --agent-unit <n>         Same for the agent
                           (default llamactl-agent.service / com.llamactl.agent).

Environment (flags win; the controller unit's Environment/EnvironmentFile is
read too):
  LLAMACTL_UPDATE_HISTORY          History file (default <state home>/update-history.log,
                                   state home = $DEV_STORAGE or ~/.llamactl). Set it
                                   to keep an earlier update script's history.
  LLAMACTL_UPDATE_HEAVY_LOCK       Heavy-job lock file, held from before the
                                   controller stops until it starts (off if unset).
  LLAMACTL_UPDATE_CONTROLLER_UNIT, LLAMACTL_UPDATE_AGENT_UNIT
                                   Same as --controller-unit / --agent-unit.
  LLAMACTL_UPDATE_AGENT_URL        Agent base URL for the health probe.
  LLAMACTL_UPDATE_CONTROLLER_LOG   Controller stdout file, when not discoverable.
  LLAMACTL_UPDATE_GH_REPO          owner/repo for the CI lookup (default: origin).

Run --apply/--rollback from a terminal or a separate transient unit
(systemd-run --user --unit llamactl-update ...), never from inside the
controller or agent service.
`;

const P = "llamactl update:";

type UpdateResult =
  | "applied"
  | "check"
  | "error"
  | "failed"
  | "interrupted"
  | "refused"
  | "rolled-back"
  | "up-to-date";

/** How long --apply/--rollback wait for the heavy-job lock, before stopping anything. */
export const HEAVY_LOCK_WAIT_SEC = 1800;
const EXIT_INTERRUPTED = 130;

interface TargetPlan {
  ref: string;
  sha: string;
  newCommits: number;
  commits: GitCommit[];
  depsChanged: boolean;
  fastForward: boolean;
  /** Local `main` when it has commits the target lacks (`switch -C main` would drop them). */
  divergedMain: string | null;
  upToDate: boolean;
  ci: string;
}

interface Report {
  mode: UpdateMode;
  result: UpdateResult;
  repo: string | null;
  current: { branch: string | null; sha: string } | null;
  target: Omit<TargetPlan, "upToDate"> | null;
  rollbackTarget: HistoryRef | null;
  serviceManager: string | null;
  services: { role: string; name: string; loaded: boolean; active: boolean; pid: number | null }[];
  agent: { url: string; healthy: boolean } | null;
  hosts: {
    name: string;
    kind: string;
    pid: number;
    url: string;
    reconciled: boolean;
    ready: boolean;
    idle: string;
  }[];
  historyFile: string | null;
  refusals: string[];
  warnings: string[];
  steps: StepResult[];
  rollbackSteps: StepResult[];
  /** The final best-effort controller start, when the controller was found stopped. */
  finalStart: StepResult | null;
  error: string | null;
}

function newReport(mode: UpdateMode): Report {
  return {
    mode,
    result: "error",
    repo: null,
    current: null,
    target: null,
    rollbackTarget: null,
    serviceManager: null,
    services: [],
    agent: null,
    hosts: [],
    historyFile: null,
    refusals: [],
    warnings: [],
    steps: [],
    rollbackSteps: [],
    finalStart: null,
    error: null,
  };
}

const short = (sha: string): string => sha.slice(0, 7);

function fillSessionReport(report: Report, s: Session): void {
  report.repo = s.repo;
  report.current = { branch: s.checkout.branch, sha: s.checkout.sha };
  report.serviceManager = s.services.kind;
  report.services = [s.services.controller, s.services.agent].flatMap((u) =>
    u === null
      ? []
      : [{ role: u.role, name: u.name, loaded: u.loaded, active: u.active, pid: u.pid }],
  );
  report.agent =
    s.agentEndpoint === null ? null : { url: s.agentEndpoint.url, healthy: s.agentHealthy };
  report.hosts = s.hosts.map((h) => ({
    name: h.name,
    kind: h.kind,
    pid: h.pid,
    url: h.url,
    reconciled: h.reconciled,
    ready: h.ready,
    idle: h.idle,
  }));
  report.historyFile = s.historyPath;
  report.warnings.push(...s.warnings);
}

function logState(s: Session): void {
  const { log } = s.deps;
  for (const w of s.warnings) log(`${P} WARNING: ${w}`);
  const where = s.checkout.branch === null ? "detached HEAD" : `branch ${s.checkout.branch}`;
  log(`${P} checkout ${s.repo}: ${where} @ ${short(s.checkout.sha)}`);
  const units = [s.services.controller, s.services.agent].flatMap((u) =>
    u === null
      ? []
      : [
          `${u.name} ${u.loaded ? (u.active ? "active" : "inactive") : "not loaded"}${u.pid === null ? "" : ` (pid ${String(u.pid)})`}`,
        ],
  );
  log(`${P} services (${s.services.kind ?? "none"}): ${units.join("; ") || "none found"}`);
  if (s.agentEndpoint !== null) {
    log(`${P} agent ${s.agentEndpoint.url}/healthz: ${s.agentHealthy ? "ok" : "NOT ok"}`);
  }
  const hosts = s.hosts.map(
    (h) =>
      `${h.name} (${h.kind} pid ${String(h.pid)}, ${h.url}, ${h.ready ? "ready" : "NOT ready"}, ${h.idle})`,
  );
  log(`${P} model hosts: ${hosts.join("; ") || "none"}`);
}

async function planTarget(s: Session): Promise<TargetPlan> {
  const ref = s.flags.ref;
  const sha = await resolveCommit(s.git, ref);
  if (sha === null) throw new UpdateError(`cannot resolve target ${ref}`);
  const cur = s.checkout.sha;
  const fastForward = await isAncestor(s.git, cur, sha);
  const main = await resolveCommit(s.git, `refs/heads/${DEPLOY_BRANCH}`);
  const divergedMain = main !== null && !(await isAncestor(s.git, main, sha)) ? main : null;
  const { count, commits } = await commitsBetween(s.git, cur, sha, 40);
  return {
    ref,
    sha,
    newCommits: count,
    commits,
    depsChanged: depsChanged(await changedFiles(s.git, cur, sha)),
    fastForward,
    divergedMain,
    upToDate: cur === sha && s.checkout.branch === DEPLOY_BRANCH,
    ci: await ciState(s.deps.exec, s.deps.which, s.ghRepo, sha),
  };
}

function logPlan(s: Session, plan: TargetPlan): void {
  const { log } = s.deps;
  log(`${P} target ${plan.ref} = ${short(plan.sha)} (${String(plan.newCommits)} new commit(s))`);
  for (const c of plan.commits) log(`  ${short(c.sha)} ${c.subject}`);
  if (plan.newCommits > plan.commits.length) {
    log(`  … and ${String(plan.newCommits - plan.commits.length)} more`);
  }
  log(
    `${P} ${plan.depsChanged ? "dependency changes: bun install will run (needs the npm registry)" : "no dependency changes"}`,
  );
  log(`${P} CI check on target: ${plan.ci}`);
}

/** Why --apply must not proceed. Empty = go. */
export function applyRefusals(i: {
  insideUnit: string | null;
  serviceProblems: readonly string[];
  dirty: readonly string[];
  repo: string;
  fastForward: boolean;
  divergedMain: string | null;
  ref: string;
  ci: string;
  allowRedCi: boolean;
  health: readonly string[];
}): string[] {
  const out = commonRefusals(i);
  if (!i.fastForward) {
    out.push(`target ${i.ref} does not contain the current checkout (not a fast-forward)`);
  }
  if (i.divergedMain !== null) {
    out.push(
      `local branch ${DEPLOY_BRANCH} (${short(i.divergedMain)}) has commits ${i.ref} does not contain; the update would move ${DEPLOY_BRANCH} off them (merge, move or delete that branch first)`,
    );
  }
  if (i.ci !== "success" && !i.allowRedCi) {
    out.push(`target CI is '${i.ci}' (use --allow-red-ci to override)`);
  }
  if (i.health.length > 0) {
    out.push(`unhealthy before the update; fix that first: ${i.health.join("; ")}`);
  }
  return out;
}

/** Refusals shared by --apply and --rollback. */
export function commonRefusals(i: {
  insideUnit: string | null;
  serviceProblems: readonly string[];
  dirty: readonly string[];
  repo: string;
}): string[] {
  const out: string[] = [];
  if (i.insideUnit !== null) {
    out.push(
      `running inside ${i.insideUnit}, which this update restarts; run it from a terminal or as its own unit: systemd-run --user --unit llamactl-update --collect <bun> <checkout>/packages/cli/src/bin.ts update --apply`,
    );
  }
  out.push(...i.serviceProblems);
  if (i.dirty.length > 0) out.push(`tracked local changes in ${i.repo}: ${i.dirty.join(", ")}`);
  return out;
}

function deployContext(s: Session, signal: AbortSignal): DeployContext {
  const { manager, controller, agent } = s.services;
  if (manager === null || controller === null || agent === null || s.agentEndpoint === null) {
    throw new UpdateError("services are not resolved");
  }
  return {
    deps: s.deps,
    git: s.git,
    repo: s.repo,
    manager,
    controller,
    agent,
    agentEndpoint: s.agentEndpoint,
    hostsEnv: s.stateEnv,
    snapshot: s.hosts,
    install: buildInstallCommand({ bun: s.bun, platform: s.deps.platform, which: s.deps.which }),
    controllerLog: s.controllerLog,
    timeouts: DEFAULT_TIMEOUTS,
    lock: heavyLock(s),
    signal,
  };
}

function heavyLock(s: Session): DeployContext["lock"] {
  if (s.heavyLock === null) return null;
  if (s.deps.which("flock") === null) {
    s.deps.log(`${P} WARNING: flock not found; not taking the heavy-job lock ${s.heavyLock}`);
    return null;
  }
  return { path: s.heavyLock, handle: null };
}

/**
 * Wait for the heavy-job lock before anything is stopped, when this run
 * installs. Returns why it could not be taken, or null when it is held (or
 * not needed).
 */
async function takeHeavyLock(
  s: Session,
  ctx: DeployContext,
  needed: boolean,
): Promise<string | null> {
  if (!needed || ctx.lock === null) return null;
  const { path } = ctx.lock;
  s.deps.log(
    `${P} waiting for the heavy-job lock ${path} (up to ${String(HEAVY_LOCK_WAIT_SEC)} s); nothing is stopped while waiting`,
  );
  ctx.lock.handle = await s.deps.acquireLock(path, HEAVY_LOCK_WAIT_SEC, ctx.signal);
  if (ctx.lock.handle !== null) return null;
  if (ctx.signal.aborted) return INTERRUPTED;
  return `could not take the heavy-job lock ${path} within ${String(HEAVY_LOCK_WAIT_SEC)} s (another heavy job holds it); nothing was changed`;
}

/** Trap SIGINT/SIGTERM for the duration of `run`: the procedure stops after its current step. */
async function withSignals(
  s: Session,
  run: (signal: AbortSignal) => Promise<number>,
): Promise<number> {
  const ac = new AbortController();
  const off = s.deps.onSignal((sig) => {
    if (!ac.signal.aborted) {
      s.deps.log(
        `${P} ${sig}: stopping after the current step; the controller is started again before exiting`,
      );
    }
    ac.abort();
  });
  try {
    return await run(ac.signal);
  } finally {
    off();
  }
}

function lockNotTaken(s: Session, report: Report, why: string): number {
  if (why === INTERRUPTED) {
    report.result = "interrupted";
    report.error = `${INTERRUPTED} while waiting for the heavy-job lock; nothing was changed`;
    return EXIT_INTERRUPTED;
  }
  return refuse(s, report, [why]);
}

function interrupted(s: Session, report: Report, sha: string): number {
  history(s, failedLine(new Date(s.deps.now()).toISOString(), sha, INTERRUPTED));
  report.result = "interrupted";
  report.error = `${INTERRUPTED}; the controller is running again, but the checkout may be anywhere between the two refs: run llamactl update --check, then --rollback if needed`;
  return EXIT_INTERRUPTED;
}

/** Run a deploy phase, then make sure the controller runs whatever happened. */
async function guarded(
  ctx: DeployContext,
  report: Report,
  run: () => Promise<number>,
): Promise<number> {
  try {
    return await run();
  } finally {
    report.finalStart = await ensureControllerRunning(ctx);
    if (report.finalStart?.ok === false) {
      report.error = `${report.error ?? "update failed"}; ${report.finalStart.detail}`;
    }
  }
}

function statusHint(s: Session): string {
  const names = [s.services.controller?.name, s.services.agent?.name].filter(
    (n) => n !== undefined,
  );
  if (s.services.kind === "launchd") {
    return names.map((n) => `launchctl print gui/${String(s.deps.uid)}/${n}`).join("; ");
  }
  return `systemctl --user status ${names.join(" ")}`;
}

function history(s: Session, line: string): void {
  try {
    s.deps.appendFile(s.historyPath, line);
  } catch (err) {
    s.deps.log(`${P} WARNING: could not write ${s.historyPath}: ${(err as Error).message}`);
  }
}

function refuse(s: Session, report: Report, refusals: string[]): number {
  report.refusals = refusals;
  report.result = "refused";
  for (const r of refusals) s.deps.log(`${P} refusing: ${r}`);
  return 1;
}

async function runCheck(s: Session, report: Report): Promise<number> {
  const plan = await planTarget(s);
  report.target = plan;
  logPlan(s, plan);
  report.result = plan.upToDate ? "up-to-date" : "check";
  if (plan.upToDate) {
    s.deps.log(`${P} already up to date`);
    return 0;
  }
  report.refusals = applyRefusals(refusalInput(s, plan));
  for (const r of report.refusals) s.deps.log(`${P} --apply would refuse: ${r}`);
  s.deps.log(`${P} check only; run with --apply to update`);
  return 0;
}

function refusalInput(s: Session, plan: TargetPlan): Parameters<typeof applyRefusals>[0] {
  return {
    insideUnit: s.insideUnit,
    serviceProblems: s.services.problems,
    dirty: s.checkout.dirty,
    repo: s.repo,
    fastForward: plan.fastForward,
    divergedMain: plan.divergedMain,
    ref: plan.ref,
    ci: plan.ci,
    allowRedCi: s.flags.allowRedCi,
    health: healthProblems(s),
  };
}

function failedStep(outcome: DeployOutcome): string {
  const last = outcome.results.at(-1);
  return last === undefined ? "?" : `${last.step}: ${last.detail}`;
}

async function runApply(s: Session, report: Report): Promise<number> {
  const plan = await planTarget(s);
  report.target = plan;
  logPlan(s, plan);
  if (plan.upToDate) {
    report.result = "up-to-date";
    s.deps.log(`${P} already up to date`);
    return 0;
  }
  const refusals = applyRefusals(refusalInput(s, plan));
  if (refusals.length > 0) return refuse(s, report, refusals);
  return await withSignals(s, async (signal) => {
    const ctx = deployContext(s, signal);
    const lockProblem = await takeHeavyLock(s, ctx, plan.depsChanged);
    if (lockProblem !== null) return lockNotTaken(s, report, lockProblem);
    const from: HistoryRef = { branch: s.checkout.branch, sha: s.checkout.sha };
    history(s, applyStartLine(new Date(s.deps.now()).toISOString(), from, plan.sha));
    return await guarded(ctx, report, async () => await applyDeploy(s, report, ctx, from, plan));
  });
}

async function applyDeploy(
  s: Session,
  report: Report,
  ctx: DeployContext,
  from: HistoryRef,
  plan: TargetPlan,
): Promise<number> {
  const steps = buildDeploySteps({
    sha: plan.sha,
    mode: { kind: "main" },
    depsChanged: plan.depsChanged,
    waitIdleSec: s.flags.waitIdleSec,
    restartAgent: true,
    lock: ctx.lock !== null,
  });
  const outcome = await runDeploy(steps, ctx);
  report.steps = outcome.results;
  if (outcome.ok) {
    history(s, okLine(new Date(s.deps.now()).toISOString(), plan.sha));
    report.result = "applied";
    s.deps.log(`${P} done: ${short(plan.sha)} is live. Roll back with: llamactl update --rollback`);
    return 0;
  }
  if (outcome.interrupted) return interrupted(s, report, plan.sha);
  return await autoRollback(s, report, ctx, from, plan, outcome);
}

async function autoRollback(
  s: Session,
  report: Report,
  ctx: DeployContext,
  from: HistoryRef,
  plan: TargetPlan,
  forward: DeployOutcome,
): Promise<number> {
  s.deps.log(
    `${P} update failed (${failedStep(forward)}); rolling back to ${formatHistoryRef(from)}`,
  );
  const mode = await restoreMode(s.git, from);
  const steps = buildDeploySteps({
    sha: from.sha,
    mode,
    depsChanged: plan.depsChanged,
    waitIdleSec: s.flags.waitIdleSec,
    restartAgent: forward.agentRestartAttempted,
    lock: ctx.lock !== null,
  });
  const back = await runDeploy(steps, ctx);
  report.rollbackSteps = back.results;
  if (back.interrupted) return interrupted(s, report, plan.sha);
  report.result = "failed";
  const now = new Date(s.deps.now()).toISOString();
  if (!back.ok) {
    history(s, failedLine(now, plan.sha, `update and rollback failed (${failedStep(back)})`));
    report.error = `update to ${short(plan.sha)} failed and the rollback is unhealthy too (${failedStep(back)}); check: ${statusHint(s)}`;
    return 1;
  }
  history(s, rolledBackLine(now, from));
  report.error = `update to ${short(plan.sha)} failed verification (${failedStep(forward)}); rolled back to ${formatHistoryRef({ branch: from.branch, sha: short(from.sha) })}`;
  return 1;
}

async function resolveRollbackTarget(s: Session): Promise<HistoryRef> {
  const arg = s.flags.rollbackRef;
  const recorded =
    arg === null ? defaultRollbackTarget(s.deps.readFile(s.historyPath) ?? "") : null;
  if (arg === null && recorded === null) {
    throw new UpdateError(
      `no rollback target: ${s.historyPath} records no previous update (pass a branch@sha or sha)`,
    );
  }
  const parsed = recorded ?? (arg?.includes("@") === true ? parseHistoryRef(arg) : null);
  const rev = parsed?.sha ?? arg ?? "";
  const sha = await resolveCommit(s.git, rev);
  if (sha === null) throw new UpdateError(`cannot resolve rollback target ${rev}`);
  if (parsed !== null) return { branch: parsed.branch, sha };
  const isBranch = arg !== null && (await resolveCommit(s.git, `refs/heads/${arg}`)) !== null;
  return { branch: isBranch ? arg : null, sha };
}

function alreadyAt(s: Session, sha: string, mode: BranchMode): boolean {
  if (s.checkout.sha !== sha) return false;
  switch (mode.kind) {
    case "main":
      return s.checkout.branch === DEPLOY_BRANCH;
    case "branch":
      return s.checkout.branch === mode.name;
    case "detach":
      return s.checkout.branch === null;
  }
}

async function runRollback(s: Session, report: Report): Promise<number> {
  const target = await resolveRollbackTarget(s);
  report.rollbackTarget = target;
  const mode = await restoreMode(s.git, target);
  s.deps.log(
    `${P} rollback target: ${formatHistoryRef({ branch: target.branch, sha: short(target.sha) })}`,
  );
  if (alreadyAt(s, target.sha, mode)) {
    report.result = "up-to-date";
    s.deps.log(`${P} already at the rollback target`);
    return 0;
  }
  const refusals = commonRefusals({
    insideUnit: s.insideUnit,
    serviceProblems: s.services.problems,
    dirty: s.checkout.dirty,
    repo: s.repo,
  });
  if (refusals.length > 0) return refuse(s, report, refusals);
  const changed = depsChanged(await changedFiles(s.git, s.checkout.sha, target.sha));
  return await withSignals(s, async (signal) => {
    const ctx = deployContext(s, signal);
    const lockProblem = await takeHeavyLock(s, ctx, changed);
    if (lockProblem !== null) return lockNotTaken(s, report, lockProblem);
    const from: HistoryRef = { branch: s.checkout.branch, sha: s.checkout.sha };
    history(s, rollbackStartLine(new Date(s.deps.now()).toISOString(), from, target));
    const steps = buildDeploySteps({
      sha: target.sha,
      mode,
      depsChanged: changed,
      waitIdleSec: s.flags.waitIdleSec,
      restartAgent: true,
      lock: ctx.lock !== null,
    });
    return await guarded(
      ctx,
      report,
      async () => await rollbackDeploy(s, report, ctx, steps, target),
    );
  });
}

async function rollbackDeploy(
  s: Session,
  report: Report,
  ctx: DeployContext,
  steps: ReturnType<typeof buildDeploySteps>,
  target: HistoryRef,
): Promise<number> {
  const outcome = await runDeploy(steps, ctx);
  report.steps = outcome.results;
  if (outcome.interrupted) return interrupted(s, report, target.sha);
  const now = new Date(s.deps.now()).toISOString();
  if (!outcome.ok) {
    history(s, failedLine(now, target.sha, `rollback failed (${failedStep(outcome)})`));
    report.result = "failed";
    report.error = `rollback to ${short(target.sha)} is unhealthy (${failedStep(outcome)}); check: ${statusHint(s)}`;
    return 1;
  }
  history(s, okLine(now, target.sha));
  report.result = "rolled-back";
  s.deps.log(
    `${P} rolled back to ${short(target.sha)}; update again with: llamactl update --apply`,
  );
  return 0;
}

async function runMode(flags: UpdateFlags, deps: UpdateDeps, report: Report): Promise<number> {
  const s = await openSession(flags, deps);
  fillSessionReport(report, s);
  logState(s);
  switch (flags.mode) {
    case "check":
      return await runCheck(s, report);
    case "apply":
      return await runApply(s, report);
    case "rollback":
      return await runRollback(s, report);
  }
}

export async function runUpdate(
  args: readonly string[],
  overrides: Partial<UpdateDeps> = {},
): Promise<number> {
  const parsed = parseUpdateFlags(args);
  const base = { ...defaultUpdateDeps(), ...overrides };
  if ("error" in parsed) {
    if (parsed.error === "help") {
      base.stdout(UPDATE_USAGE);
      return 0;
    }
    base.stderr(`${P} ${parsed.error}\n\n${UPDATE_USAGE}`);
    return 2;
  }
  // Under --json, stdout carries only the final report.
  const deps: UpdateDeps =
    parsed.json && overrides.log === undefined
      ? {
          ...base,
          log: (line): void => {
            base.stderr(`${line}\n`);
          },
        }
      : base;
  const report = newReport(parsed.mode);
  let code: number;
  try {
    code = await runMode(parsed, deps, report);
  } catch (err) {
    if (!(err instanceof UpdateError)) throw err;
    report.result = "error";
    report.error = err.message;
    code = 1;
  }
  if (report.error !== null) deps.stderr(`${P} ERROR: ${report.error}\n`);
  if (parsed.json) deps.stdout(`${JSON.stringify(report, null, 2)}\n`);
  return code;
}
