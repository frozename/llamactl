// #284 (DF-11): read-only `llamactl residency status` and `residency plan`,
// plus the #278 (DF-05) operator `residency force-unload`. Status routes one
// residencyStatus.query through the dispatcher, bounded by the exported
// withNodeQueryDeadline helper, and renders the serving process's NodeRun policy,
// memory budget, node-local residency store, lifecycle rows, lease/drain state,
// bound sessions, the advisory idle-eviction window and the read-only ranking
// read-out (resident set and drain charges as the unified proxy's ranker sees
// them); it never wakes a model and never mutates. plan is the read-only
// dry-run profile switch: it routes one residencyPlan.query and renders budget
// source, victims, replacements, protected workloads or a refusal reason; a
// refusal is a successful dry-run answer and exits 0, never starting, stopping,
// loading or writing the store.
// apply-profile is the dry-run-by-default profile switch (wired: it records an
// operation and stops/starts workloads when run with --execute --yes).
// cancel-operation requests an abort of one of those in-flight switches by
// operationId; it is process-local and destructive. force-unload is the other
// deliberate mutation here: it drives a workload through
// the lease fence, revoking active leases and auditing any revocation as an
// operator override (an idle unload, with no leases held, writes no lease audit
// row). evict-idle is the operator-initiated idle eviction (#519): dry by
// default (one residencyEvictIdle query), and with --yes it stamps the durable
// idle hold on each targeted LOCAL manifest before the fenced stop, keeping it
// only on rows that come back evicted; release-idle clears that hold. Workloads
// with no local manifest are never targeted (there is nothing to hold).
// release-session (#520) is the per-session counterpart of force-unload: it
// drops one session binding by id through residencyReleaseSession — never
// draining, revoking leases or stopping the workload — so the DF-05 leases of
// in-flight requests stay held and LeasesActive still fences their stop.

import type { NodeClient, noderunSchema } from "@llamactl/remote";

import { workloadReconciler, workloadStore } from "@llamactl/remote";

import {
  getAuthenticatedAgentClientByName,
  getGlobals,
  getNodeClientByName,
} from "../dispatcher.js";
import { required } from "../required.js";
import { formatResidencyKnobs } from "./noderun-helpers.js";
import { withNodeQueryDeadline } from "./workload.js";

const USAGE = `Usage: llamactl residency <subcommand>

Subcommands:
  status --node <name> [--json]   Read-only residency status: NodeRun policy, memory budget, the serving process's residency store, its per-model lifecycle rows and exclusive-group violations, its per-workload lease/drain state, its bound sessions (refs, idle-timeout expiry), the advisory idle-eviction window, and the read-only ranking read-out (resident preference, resident set and drain charges). Never wakes a model or mutates state.
  plan --node <name> --to <profile> [--from <profile>] [--json]   Read-only dry-run profile switch: budget source, victims, replacements, protected workloads or refusal. Never starts, stops, loads or writes the store.
  apply-profile --node <name> --to <profile> [--from <profile>] [--managed] [--json]   Dry-run by default. Use --managed on a managed owner. Add --execute --yes to run the switch and record an operation.
  load <workload> --node <name> [--execute --yes] [--json]   Preview loading an enabled workload on its managed owner. Execution uses the owner admission and readiness gates.
  unload <workload> --node <name> [--wait-seconds <1-60>] [--execute --yes] [--json]   Preview stopping an idle, unprotected workload on its managed owner. A wait drains active leases before stopping. Execution leaves the desired manifest enabled, so eligible workloads can load again.
  cancel-operation <operationId> --yes [--node <name>] [--json]   Request an abort of an in-flight profile switch started by apply-profile --execute --yes in the process serving <node> (an agent serve process); it stops before its next step boundary. Process-local: a switch run in-process by a local-endpoint CLI invocation cannot be cancelled from another CLI invocation. Requires --yes.
  force-unload <workload> --reason <text> --yes [--node <name>] [--json]   Operator override of the stop fence: revoke active leases (audited as an operator override), then stop the workload. Destructive; requires --yes. Reports the released session ids when a session registry is installed.
  evict-idle --node <name> [--yes] [--json]   Operator-initiated idle eviction: dry by default (one residencyEvictIdle query reports the window and which residents would be evicted). Add --yes to stamp the durable idle hold on each targeted local manifest and run the fenced stop, keeping the hold only on workloads that come back evicted. Workloads with no local manifest are reported skipped (NotHeld) and never targeted. Destructive with --yes.
  release-idle <workload> [--json]   Clear the durable idle hold from a local ModelRun or ModelHost manifest so the reconciler may start it again. Reports whether the hold was released, absent, or the manifest does not exist.
  release-session <sessionId> --yes [--force] [--node <name>] [--json]   Operator release of one session binding by id: drops only the binding; the DF-05 leases of in-flight requests stay held, so LeasesActive still fences their stop. An idle binding drops; an in-flight binding refuses unless --force is given. Requires --yes.

Example:
  llamactl residency status --node <name> [--json]
  llamactl residency plan --node <name> --to <profile> [--json]
  llamactl residency apply-profile --node <name> --to <profile> [--from <profile>] [--managed] [--execute --yes]
  llamactl residency cancel-operation <operationId> --yes
  llamactl residency force-unload <workload> --reason <text> --yes
  llamactl residency evict-idle --node <name> [--yes] [--json]
  llamactl residency release-idle <workload> [--json]
  llamactl residency release-session <sessionId> --yes [--node <name>]
`;

export type ResidencyStatusView = Awaited<ReturnType<NodeClient["residencyStatus"]["query"]>>;

export type ResidencyPlanView = Awaited<ReturnType<NodeClient["residencyPlan"]["query"]>>;

export type ResidencyForceUnloadView = Awaited<
  ReturnType<NodeClient["residencyForceUnload"]["mutate"]>
>;

type ResidencyApplyProfileRefusalView = {
  reason: string;
  detail: string;
  retryAfterMs?: number;
  workloads?: string[];
};

export type ResidencyApplyProfileView = Omit<
  Awaited<ReturnType<NodeClient["residencyApplyProfile"]["mutate"]>>,
  "refusal"
> & {
  refusal?: ResidencyApplyProfileRefusalView;
};

export type ResidencyCancelOperationView = Awaited<
  ReturnType<NodeClient["residencyCancelOperation"]["mutate"]>
>;

// #519 evict-idle view: tRPC strips `| undefined` from optional row fields, so
// the schema-authored result is not assignable to the client view under
// exactOptionalPropertyTypes. Re-declare the widened row/result locally; the
// runtime payload always carries the same keys.
type EvictIdleKind = "modelrun" | "modelhost";
type EvictIdleRow = {
  workload: string;
  action: "would-evict" | "evicted" | "skipped";
  kind?: EvictIdleKind;
  idleSinceMs?: number;
  dueAtMs?: number;
  reason?: string;
  detail?: string;
};
type EvictIdleResult =
  | { ok: false; reason: string }
  | { ok: true; dryRun: boolean; windowSeconds: number; rows: EvictIdleRow[] };

// #519 ranking view: an agent older than the cooldown/tier read-out omits
// cooldownCharged/drainTier/degradedTier/loadCredited even though the
// current schema always carries them. Re-declare the ranking section
// locally with those fields optional (the same way the evict-idle row
// above is re-declared), so the renderer reads them without tripping
// no-unnecessary-condition.
type RankingCharge = { model: string; untilMs: number };
type RankingLoadCredit = { model: string; expectedReadyAtMs: number };
type RankingUnavailableReason =
  | "NotServingNode"
  | "UnifiedProxyOff"
  | "StoreAbsent"
  | "StoreUnreadable"
  | "LifecycleUnreadable";
type RankingSectionRender =
  | { status: "disabled"; scope: "serving-process" }
  | { status: "unavailable"; scope: "serving-process"; reason: RankingUnavailableReason }
  | {
      status: "available";
      scope: "serving-process";
      advisory: true;
      residentPreference: number;
      coldLoadPenaltyMs: number;
      resident: string[];
      drainCharged: string[];
      cooldownCharged?: RankingCharge[];
      drainTier?: string[];
      degradedTier?: string[];
      loadCredited?: RankingLoadCredit[];
    };

export type ResidencyReleaseSessionView = Awaited<
  ReturnType<NodeClient["residencyReleaseSession"]["mutate"]>
>;

export interface ResidencyDeps {
  getNodeClientByName?: typeof getNodeClientByName;
  workloadsDir?: string;
  now?: () => Date;
}

// tRPC output typing strips `| undefined` from optional properties, so the
// schema-authored ResidencyStatus is not assignable to ResidencyStatusView
// under exactOptionalPropertyTypes. Re-widen policy.residency from the NodeRun
// schema so both the client view and the assembled payload render.
type ResidencyRenderInput = Omit<ResidencyStatusView, "policy" | "ranking"> & {
  policy: { present: false } | { present: true; residency: noderunSchema.NodeRunResidency };
  ranking?: RankingSectionRender;
};

export function renderResidencyStatus(s: ResidencyRenderInput, nowMs: number = Date.now()): string {
  const lines: string[] = [];
  lines.push(`Node:       ${s.node}`);
  lines.push(`NodeRun:    ${s.nodeRun.present ? "present" : "absent"}`);
  lines.push(`Policy:     ${s.policy.present ? JSON.stringify(s.policy.residency) : "none"}`);
  pushEffectivePolicyLine(lines, s.effectivePolicy);
  if (s.knobScopeWarnings !== undefined && s.knobScopeWarnings.length > 0) {
    for (const w of s.knobScopeWarnings) {
      lines.push(`Warning:    ${w}`);
    }
  }
  lines.push(`Budget:     ${s.budget.memoryGiB.toFixed(1)} GiB (source: ${s.budget.source})`);
  if (!s.store.present) {
    lines.push(`Store:      not present at ${s.store.path} (scope: serving-process)`);
  } else if ("error" in s.store) {
    lines.push(`Store:      error at ${s.store.path}: ${s.store.error} (scope: serving-process)`);
  } else {
    lines.push(`Store:      ${s.store.path} (scope: serving-process)`);
    lines.push(`Nonterminal: ${String(s.store.nonterminalCount)}`);
    for (const op of s.store.nonterminal) {
      lines.push(
        `  ${op.operationId}  ${op.model}  ${op.phase} -> ${op.targetState}  ${op.reservationGiB.toFixed(1)} GiB`,
      );
    }
  }
  pushLifecycleLines(lines, s.lifecycle);
  pushIdleEvictionLines(lines, s.idleEviction, nowMs);
  pushSwitchGateLines(lines, s.switchGates, nowMs);
  pushRankingLines(lines, s.ranking, nowMs);
  pushManagedLines(lines, s.managed);
  pushLeaseLines(lines, s.leases);
  pushSessionLines(lines, s.sessions);
  lines.push(
    `Note:       store is the serving process's node-local store, not ${s.node}'s coordinator state`,
  );
  return lines.join("\n") + "\n";
}

function pushManagedLines(lines: string[], managed: ResidencyRenderInput["managed"]): void {
  if (managed === undefined) return;
  const { profile, budgetGiB, claims, execution } = managed;
  const selected = profile.kind === "selected" ? profile.profile : profile.kind;
  const budget = budgetGiB === null ? "unknown" : `${budgetGiB.toFixed(1)} GiB`;
  lines.push(
    `Managed:    ${managed.ownerNodeId} · ${selected} · ledger ${managed.ledger} · ${budget}`,
  );
  for (const claim of claims) {
    const hold = claim.inferenceHold === undefined ? "" : `  inference hold ${claim.inferenceHold}`;
    lines.push(`  ${claim.workload}  ${claim.state}  ${claim.allocationGiB.toFixed(1)} GiB${hold}`);
  }
  for (const group of execution ?? []) {
    lines.push(
      `  ${group.group}  ${String(group.executing)} active  ${String(group.queued)} queued${group.fenced ? "  fenced" : ""}`,
    );
  }
}

function pushLifecycleLines(lines: string[], lifecycle: ResidencyRenderInput["lifecycle"]): void {
  if (lifecycle === undefined) {
    return;
  }
  if (lifecycle.status === "unavailable") {
    const detail =
      lifecycle.reason === "StoreUnreadable" ? "store unreadable" : "lifecycle rows unreadable";
    lines.push(`Lifecycle:  unavailable (${detail}; scope: serving-process)`);
    return;
  }
  lines.push(
    `Lifecycle:  ${String(lifecycle.workloads.length)} workload(s) (scope: serving-process)`,
  );
  for (const w of lifecycle.workloads) {
    lines.push(`  ${w.model}  ${w.state}  group ${w.group ?? "-"}  version ${String(w.version)}`);
  }
  if (lifecycle.exclusiveViolations.length === 0) {
    lines.push("Exclusive:  no violations");
    return;
  }
  for (const v of lifecycle.exclusiveViolations) {
    lines.push(`Exclusive:  violation in ${v.group}: ${v.members.join(", ")}`);
  }
}

function pushLeaseLines(lines: string[], leases: ResidencyRenderInput["leases"]): void {
  if (leases.status === "unavailable") {
    lines.push(`Leases:     unavailable (no lease registry installed; scope: serving-process)`);
    return;
  }
  lines.push(`Leases:     ${String(leases.workloads.length)} workload(s) (scope: serving-process)`);
  for (const w of leases.workloads) {
    lines.push(
      `  ${w.workload}  ${w.phase}  epoch ${String(w.epoch)}  active ${String(w.activeLeaseCount)}  waiters ${String(w.waiters)}`,
    );
  }
  lines.push(
    `Audit:      ${String(leases.recentAudit.length)} of ${String(leases.auditCount)} forced unload(s)`,
  );
  for (const a of leases.recentAudit) {
    lines.push(
      `  ${a.workload}  epoch ${String(a.epoch)}  revoked ${String(a.revokedCount)}  reason ${a.reason ?? "-"}`,
    );
  }
}

function pushEffectivePolicyLine(
  lines: string[],
  effective: ResidencyRenderInput["effectivePolicy"],
): void {
  if (effective === undefined) {
    return;
  }
  lines.push(`Effective:  ${formatResidencyKnobs(effective)}`);
}

function pushSessionLines(lines: string[], sessions: ResidencyRenderInput["sessions"]): void {
  if (sessions === undefined) {
    return;
  }
  if (sessions.status === "unavailable") {
    lines.push(
      `Sessions:   unavailable (${SESSIONS_UNAVAILABLE[sessions.reason]}; scope: ${sessions.scope})`,
    );
    return;
  }
  lines.push(
    `Sessions:   ${String(sessions.sessions.length)} bound (idle timeout ${formatMs(sessions.idleTimeoutMs)}; scope: ${sessions.scope})`,
  );
  // refs > 0 means the session is in flight (no expiry); refs 0 always
  // carries the remaining idle-timeout window.
  for (const s of sessions.sessions) {
    const state = s.expiresInMs === null ? "in flight" : `expires in ${formatMs(s.expiresInMs)}`;
    lines.push(`  ${s.workload}  ${s.sessionId}  refs ${String(s.refs)}  ${state}`);
  }
}

type SessionsUnavailableReason = Extract<
  NonNullable<ResidencyRenderInput["sessions"]>,
  { status: "unavailable" }
>["reason"];

const SESSIONS_UNAVAILABLE: Record<SessionsUnavailableReason, string> = {
  NoRegistry: "no session registry installed",
  SessionsUnknown: "session registry unreadable",
  SnapshotUnsupported: "session registry has no snapshot",
};

function pushIdleEvictionLines(
  lines: string[],
  idle: ResidencyRenderInput["idleEviction"],
  nowMs: number,
): void {
  if (idle === undefined) {
    return;
  }
  if (idle.status === "disabled") {
    lines.push(`Idle evict: disabled (scope: ${idle.scope})`);
    return;
  }
  if (idle.status === "unavailable") {
    lines.push(
      `Idle evict: unavailable (${IDLE_EVICTION_UNAVAILABLE[idle.reason]}; scope: ${idle.scope})`,
    );
    return;
  }
  lines.push(
    `Idle evict: window ${String(idle.idleEvictSeconds)}s, ${String(idle.workloads.length)} ready workload(s) (advisory; scope: ${idle.scope})`,
  );
  for (const w of idle.workloads) {
    const sessionHold = w.sessionHold;
    let state: string;
    if (w.due) {
      state = "due";
    } else if (w.minResidencyUntilMs !== undefined) {
      state = `held MinResidency for ${formatMs(Math.max(0, w.minResidencyUntilMs - nowMs))}`;
    } else if (sessionHold?.reason === "SessionsActive") {
      state = `held SessionsActive: ${sessionHold.sessions.join(", ")}`;
    } else if (sessionHold?.reason === "SessionsUnknown") {
      state = "held SessionsUnknown";
    } else if (w.dueAtMs === null) {
      state = "not due (activity unknown)";
    } else if (w.dueAtMs > nowMs) {
      state = `not due (due in ${formatMs(w.dueAtMs - nowMs)})`;
    } else {
      state = "not due (leased or draining)";
    }
    lines.push(`  ${w.workload}  ${state}  leases ${String(w.activeLeaseCount)}`);
  }
}

type IdleEvictionUnavailableReason = Extract<
  NonNullable<ResidencyRenderInput["idleEviction"]>,
  { status: "unavailable" }
>["reason"];

const IDLE_EVICTION_UNAVAILABLE: Record<IdleEvictionUnavailableReason, string> = {
  NotServingNode: "not the serving node",
  LeasesUnavailable: "no lease registry installed",
  StoreUnreadable: "store unreadable",
  LifecycleUnreadable: "lifecycle rows unreadable",
};

function pushSwitchGateLines(
  lines: string[],
  gates: ResidencyRenderInput["switchGates"],
  nowMs: number,
): void {
  if (gates === undefined) {
    return;
  }
  if (gates.status === "disabled") {
    lines.push(`Switch gates: disabled (scope: ${gates.scope})`);
    return;
  }
  if (gates.status === "unavailable") {
    lines.push(
      `Switch gates: unavailable (${SWITCH_GATES_UNAVAILABLE[gates.reason]}; scope: ${gates.scope})`,
    );
    return;
  }
  lines.push(
    `Switch gates: cooldown ${String(gates.switchCooldownSeconds)}s, min residency ${String(gates.minResidencySeconds)}s (advisory; scope: ${gates.scope})`,
  );
  pushSwitchCooldownLine(lines, gates, nowMs);
  for (const w of gates.workloads) {
    const state = w.held
      ? `held MinResidency for ${formatMs(Math.max(0, w.minResidencyUntilMs - nowMs))}`
      : "min residency met";
    lines.push(`  ${w.workload}  ${state}`);
  }
}

type SwitchGatesAvailable = Extract<
  NonNullable<ResidencyRenderInput["switchGates"]>,
  { status: "available" }
>;

function pushSwitchCooldownLine(lines: string[], gates: SwitchGatesAvailable, nowMs: number): void {
  if (gates.switchCooldownSeconds === 0) {
    lines.push("  cooldown: off");
  } else if (gates.cooldownActive && gates.cooldownUntilMs !== null) {
    lines.push(`  cooldown: active for ${formatMs(Math.max(0, gates.cooldownUntilMs - nowMs))}`);
  } else if (gates.lastSwitchAtMs === null) {
    lines.push("  cooldown: clear (no recorded switch)");
  } else {
    lines.push("  cooldown: clear");
  }
}

type SwitchGatesUnavailableReason = Extract<
  NonNullable<ResidencyRenderInput["switchGates"]>,
  { status: "unavailable" }
>["reason"];

const SWITCH_GATES_UNAVAILABLE: Record<SwitchGatesUnavailableReason, string> = {
  NotServingNode: "not the serving node",
  StoreUnreadable: "store unreadable",
  LifecycleUnreadable: "lifecycle rows unreadable",
};

function pushRankingLines(
  lines: string[],
  ranking: ResidencyRenderInput["ranking"],
  nowMs: number,
): void {
  if (ranking === undefined) {
    return;
  }
  if (ranking.status === "disabled") {
    lines.push(`Ranking: disabled (scope: ${ranking.scope})`);
    return;
  }
  if (ranking.status === "unavailable") {
    lines.push(
      `Ranking: unavailable (${RANKING_UNAVAILABLE[ranking.reason]}; scope: ${ranking.scope})`,
    );
    return;
  }
  lines.push(
    `Ranking: resident preference ${String(ranking.residentPreference)}, cold-load penalty ${String(ranking.coldLoadPenaltyMs)}ms (advisory; scope: ${ranking.scope})`,
  );
  lines.push(`  resident: ${ranking.resident.length === 0 ? "none" : ranking.resident.join(", ")}`);
  if (ranking.drainCharged.length > 0) {
    lines.push(`  drain charged: ${ranking.drainCharged.join(", ")}`);
  }
  const loadCredited = ranking.loadCredited ?? [];
  if (loadCredited.length > 0) {
    const entries = loadCredited.map(
      (e) => `${e.model} ready in ${formatMs(Math.max(0, e.expectedReadyAtMs - nowMs))}`,
    );
    lines.push(`  load credited: ${entries.join(", ")}`);
  }
  const cooldownCharged = ranking.cooldownCharged ?? [];
  if (cooldownCharged.length > 0) {
    const entries = cooldownCharged.map(
      (e) => `${e.model} for ${formatMs(Math.max(0, e.untilMs - nowMs))}`,
    );
    lines.push(`  cooldown charged: ${entries.join(", ")}`);
  }
  const drainTier = ranking.drainTier ?? [];
  if (drainTier.length > 0) {
    lines.push(`  drain tier: ${drainTier.join(", ")}`);
  }
  const degradedTier = ranking.degradedTier ?? [];
  if (degradedTier.length > 0) {
    lines.push(`  degraded tier: ${degradedTier.join(", ")}`);
  }
}

const RANKING_UNAVAILABLE: Record<RankingUnavailableReason, string> = {
  NotServingNode: "not the serving node",
  UnifiedProxyOff: "unified proxy off",
  StoreAbsent: "no residency store",
  StoreUnreadable: "store unreadable",
  LifecycleUnreadable: "lifecycle rows unreadable",
};

function formatMs(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60)}m`;
}

export function formatRefusalRetry(retryAfterMs: number | null | undefined): string | null {
  if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
    return null;
  }
  return formatMs(Math.ceil(retryAfterMs));
}

type StatusFlags = { json: boolean; node: string | undefined } | { exit: number };

function parseStatusArgs(args: string[]): StatusFlags {
  let json = false;
  let node: string | undefined;
  let i = 0;
  while (i < args.length) {
    const arg = required(args[i]);
    if (arg === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      return { exit: 0 };
    }
    if (arg === "--node") {
      const value = args[i + 1];
      if (value === undefined) {
        process.stderr.write("residency status: --node requires a value\n");
        return { exit: 1 };
      }
      node = value;
      i += 2;
      continue;
    }
    if (arg.startsWith("--node=")) {
      node = arg.slice("--node=".length);
      i += 1;
      continue;
    }
    process.stderr.write(`residency status: unknown argument ${arg}\n`);
    return { exit: 1 };
  }
  return { json, node };
}

async function runResidencyStatus(args: string[], deps: ResidencyDeps): Promise<number> {
  const parsed = parseStatusArgs(args);
  if ("exit" in parsed) return parsed.exit;
  const node = parsed.node ?? getGlobals().nodeName ?? "";
  if (node === "") {
    process.stderr.write(`residency status: --node <name> is required\n${USAGE}`);
    return 1;
  }
  if (node === "all") {
    process.stderr.write("residency status: --node all is not supported; name one node\n");
    return 1;
  }
  try {
    const client = (deps.getNodeClientByName ?? getNodeClientByName)(node);
    const status = await withNodeQueryDeadline(node, () => client.residencyStatus.query({ node }));
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(renderResidencyStatus(status, (deps.now?.() ?? new Date()).getTime()));
    return 0;
  } catch (err) {
    process.stderr.write(`residency status: ${(err as Error).message}\n`);
    return 1;
  }
}

function renderResidencyPlanLabel(label: string, value: string): string {
  return `${label.padEnd(14)}${value}`;
}

function joinPlanList(items: readonly string[]): string {
  return items.length === 0 ? "none" : items.join(", ");
}

export function renderResidencyPlan(
  req: { node: string; to: string; from: string | null },
  plan: ResidencyPlanView,
): string {
  const lines: string[] = [];
  lines.push(renderResidencyPlanLabel("Node:", req.node));
  lines.push(renderResidencyPlanLabel("Switch:", `${req.from ?? "(current)"} -> ${req.to}`));
  lines.push(
    renderResidencyPlanLabel("Mode:", "dry-run (no starts, stops, loads or store writes)"),
  );
  if (plan.budget !== undefined) {
    lines.push(
      renderResidencyPlanLabel(
        "Budget:",
        `${plan.budget.memoryGiB.toFixed(1)} GiB (source: ${plan.budget.source})`,
      ),
    );
  }
  if (plan.ok) {
    lines.push(renderResidencyPlanLabel("Result:", plan.noop ? "ok (noop)" : "ok"));
    lines.push(renderResidencyPlanLabel("Victims:", joinPlanList(plan.victims)));
    lines.push(renderResidencyPlanLabel("Replacements:", joinPlanList(plan.replacements)));
    lines.push(renderResidencyPlanLabel("Protected:", joinPlanList(plan.protected)));
    lines.push(renderResidencyPlanLabel("Retained:", joinPlanList(plan.retained)));
    lines.push(renderResidencyPlanLabel("Skipped:", joinPlanList(plan.skipped)));
    lines.push(renderResidencyPlanLabel("Before:", `${plan.beforeGiB.toFixed(1)} GiB`));
    lines.push(renderResidencyPlanLabel("After:", `${plan.afterGiB.toFixed(1)} GiB`));
    lines.push(renderResidencyPlanLabel("Peak:", `${plan.peakGiB.toFixed(1)} GiB`));
    if (plan.storeAppliesToNode === false) {
      lines.push(
        renderResidencyPlanLabel(
          "Note:",
          `the in-flight store state for ${req.node} was not observed by this serving process`,
        ),
      );
    }
  } else {
    lines.push(renderResidencyPlanLabel("Result:", `refused (${plan.reason})`));
    lines.push(renderResidencyPlanLabel("Detail:", plan.detail));
    lines.push(renderResidencyPlanLabel("Workloads:", joinPlanList(plan.workloads)));
    const retry = formatRefusalRetry(plan.retryAfterMs);
    if (retry !== null) {
      lines.push(renderResidencyPlanLabel("Retry in:", retry));
    }
  }
  return `${lines.join("\n")}\n`;
}

type PlanFlagKey = "node" | "to" | "from";

interface MutablePlanFlags {
  json: boolean;
  node: string | undefined;
  to: string;
  from: string | undefined;
}

type PlanFlags = MutablePlanFlags | { exit: number };

function applyPlanArg(args: string[], i: number, flags: MutablePlanFlags): ArgStep {
  const arg = required(args[i]);
  if (arg === "--json") {
    flags.json = true;
    return { consumed: 1 };
  }
  if (arg === "-h" || arg === "--help") {
    process.stdout.write(USAGE);
    return { exit: 0 };
  }
  const eq = arg.indexOf("=");
  const flag = eq === -1 ? arg : arg.slice(0, eq);
  if (flag === "--node" || flag === "--to" || flag === "--from") {
    const key = flag.slice(2) as PlanFlagKey;
    if (eq !== -1) {
      flags[key] = arg.slice(eq + 1);
      return { consumed: 1 };
    }
    const next = args[i + 1];
    if (next === undefined) {
      process.stderr.write(`residency plan: ${flag} requires a value\n`);
      return { exit: 1 };
    }
    flags[key] = next;
    return { consumed: 2 };
  }
  process.stderr.write(`residency plan: unknown argument ${arg}\n`);
  return { exit: 1 };
}

function parsePlanArgs(args: string[]): PlanFlags {
  const flags: MutablePlanFlags = { json: false, node: undefined, to: "", from: undefined };
  let i = 0;
  while (i < args.length) {
    const step = applyPlanArg(args, i, flags);
    if ("exit" in step) return step;
    i += step.consumed;
  }
  return flags;
}

async function runResidencyPlan(args: string[], deps: ResidencyDeps): Promise<number> {
  const parsed = parsePlanArgs(args);
  if ("exit" in parsed) return parsed.exit;

  const node = parsed.node ?? getGlobals().nodeName ?? "";
  if (node === "") {
    process.stderr.write(`residency plan: --node <name> is required\n${USAGE}`);
    return 1;
  }
  if (node === "all") {
    process.stderr.write("residency plan: --node all is not supported; name one node\n");
    return 1;
  }
  const to = parsed.to;
  if (to === "") {
    process.stderr.write("residency plan: --to <profile> is required\n");
    return 1;
  }
  const from = parsed.from;

  try {
    const client = (deps.getNodeClientByName ?? getNodeClientByName)(node);
    const input = { node, to, ...(from !== undefined ? { from } : {}) };
    const plan = await withNodeQueryDeadline(node, () => client.residencyPlan.query(input));
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(renderResidencyPlan({ node, to, from: from ?? null }, plan));
    return 0;
  } catch (err) {
    process.stderr.write(`residency plan: ${(err as Error).message}\n`);
    return 1;
  }
}

type ApplyProfileMutableFlags = {
  json: boolean;
  node: string | undefined;
  to: string;
  from: string | undefined;
  execute: boolean;
  yes: boolean;
  managed: boolean;
};

type ApplyProfileFlags = ApplyProfileMutableFlags | { exit: number };

function applyProfileArg(args: string[], i: number, flags: ApplyProfileMutableFlags): ArgStep {
  const arg = required(args[i]);
  if (arg === "--json") {
    flags.json = true;
    return { consumed: 1 };
  }
  if (arg === "--execute") {
    flags.execute = true;
    return { consumed: 1 };
  }
  if (arg === "--yes") {
    flags.yes = true;
    return { consumed: 1 };
  }
  if (arg === "--managed") {
    flags.managed = true;
    return { consumed: 1 };
  }
  if (arg === "-h" || arg === "--help") {
    process.stdout.write(USAGE);
    return { exit: 0 };
  }
  const eq = arg.indexOf("=");
  const flag = eq === -1 ? arg : arg.slice(0, eq);
  if (flag === "--node" || flag === "--to" || flag === "--from") {
    const key = flag.slice(2) as "node" | "to" | "from";
    if (eq !== -1) {
      flags[key] = arg.slice(eq + 1);
      return { consumed: 1 };
    }
    const next = args[i + 1];
    if (next === undefined) {
      process.stderr.write(`residency apply-profile: ${flag} requires a value\n`);
      return { exit: 1 };
    }
    flags[key] = next;
    return { consumed: 2 };
  }
  process.stderr.write(`residency apply-profile: unknown argument ${arg}\n`);
  return { exit: 1 };
}

function parseApplyProfileArgs(args: string[]): ApplyProfileFlags {
  const flags: ApplyProfileMutableFlags = {
    json: false,
    node: undefined,
    to: "",
    from: undefined,
    execute: false,
    yes: false,
    managed: false,
  };
  let i = 0;
  while (i < args.length) {
    const step = applyProfileArg(args, i, flags);
    if ("exit" in step) return step;
    i += step.consumed;
  }
  return flags;
}

export function renderResidencyApplyProfile(
  req: { node: string; to: string; from: string | null },
  r: ResidencyApplyProfileView,
): string {
  const lines: string[] = [];
  lines.push(renderResidencyPlanLabel("Node:", req.node));
  lines.push(renderResidencyPlanLabel("Switch:", `${req.from ?? "(current)"} -> ${req.to}`));
  lines.push(
    renderResidencyPlanLabel(
      "Mode:",
      r.dryRun
        ? "dry-run (no starts, stops, loads or store writes)"
        : "execute (stops and starts run)",
    ),
  );
  lines.push(renderResidencyPlanLabel("Outcome:", r.outcome));
  if (r.operationId !== undefined && r.operationId !== null) {
    lines.push(renderResidencyPlanLabel("Operation:", r.operationId));
  }
  if (r.inFlightOperationId !== undefined && r.inFlightOperationId !== null) {
    lines.push(renderResidencyPlanLabel("InFlight:", r.inFlightOperationId));
  }
  for (const step of r.steps) {
    const detail = step.detail !== undefined ? `; ${step.detail}` : "";
    lines.push(
      renderResidencyPlanLabel(`  ${step.action}:`, `${step.workload} (${step.status}${detail})`),
    );
  }
  return `${lines.join("\n")}\n`;
}

type ResidencyApplyProfileInput = Parameters<NodeClient["residencyApplyProfile"]["mutate"]>[0];

async function callResidencyApplyProfile(
  node: string,
  managed: boolean,
  input: ResidencyApplyProfileInput,
  deps: ResidencyDeps,
): Promise<ResidencyApplyProfileView> {
  const client =
    deps.getNodeClientByName?.(node) ??
    (managed ? getAuthenticatedAgentClientByName(node, getGlobals()) : getNodeClientByName(node));
  const apply = (): Promise<ResidencyApplyProfileView> =>
    managed
      ? client.residencyApplyManagedProfile.mutate({ ...input, version: 1 })
      : client.residencyApplyProfile.mutate(input);
  return input.dryRun === false ? await apply() : await withNodeQueryDeadline(node, apply);
}

function validateApplyProfileArgs(parsed: ApplyProfileMutableFlags): { node: string } | string {
  const resolved = parsed.node ?? getGlobals().nodeName ?? "";
  if (resolved === "") return `residency apply-profile: --node <name> is required\n${USAGE}`;
  if (resolved === "all")
    return "residency apply-profile: --node all is not supported; name one node";
  if (parsed.to === "") return "residency apply-profile: --to <profile> is required";
  if (parsed.execute && !parsed.yes) {
    return "residency apply-profile: refusing --execute without --yes (a profile switch stops and starts workloads)";
  }
  return { node: resolved };
}

// A wet switch that failed on a session-bound victim carries the refusal in the
// failed step's detail rather than a top-level refusal; surface that line. A
// refusal, when present, always takes precedence over a failed step detail.
function applyProfileFailureLine(result: ResidencyApplyProfileView): string {
  if (result.refusal === undefined) {
    for (const step of result.steps) {
      if (step.status === "failed" && step.detail !== undefined) {
        return `residency apply-profile: ${result.outcome}: ${step.action} ${step.workload}: ${step.detail}\n`;
      }
    }
  }
  const reason = result.refusal?.reason ?? result.outcome;
  const detail = result.refusal?.detail ?? "";
  const workloads = result.refusal?.workloads;
  const workloadText =
    workloads !== undefined && workloads.length > 0 ? `; workloads: ${workloads.join(", ")}` : "";
  const retry = formatRefusalRetry(result.refusal?.retryAfterMs);
  const retryText = retry === null ? "" : `; retry in ${retry}`;
  return `residency apply-profile: ${reason}: ${detail}${workloadText}${retryText}\n`;
}

async function runResidencyApplyProfile(args: string[], deps: ResidencyDeps): Promise<number> {
  const parsed = parseApplyProfileArgs(args);
  if ("exit" in parsed) return parsed.exit;

  const target = validateApplyProfileArgs(parsed);
  if (typeof target === "string") {
    process.stderr.write(`${target}\n`);
    return 1;
  }
  const node = target.node;
  const from = parsed.from;
  const base = { node, to: parsed.to, ...(from !== undefined ? { from } : {}) };
  const input: ResidencyApplyProfileInput = parsed.execute
    ? { ...base, dryRun: false, confirm: true }
    : { ...base, dryRun: true };

  try {
    const result = await callResidencyApplyProfile(node, parsed.managed, input, deps);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }
    if (!result.ok) {
      process.stderr.write(applyProfileFailureLine(result));
      return 1;
    }
    process.stdout.write(
      renderResidencyApplyProfile({ node, to: parsed.to, from: from ?? null }, result),
    );
    return 0;
  } catch (err) {
    const reason =
      parsed.managed && isMissingProcedure(err)
        ? "ManagedProfileUnavailable: the agent does not support managed profile version 1"
        : (err as Error).message;
    process.stderr.write(`residency apply-profile: ${reason}\n`);
    return 1;
  }
}

interface CancelOperationFlags {
  operationId: string | undefined;
  yes: boolean;
  json: boolean;
  node: string | undefined;
}

function applyCancelOperationArg(args: string[], i: number, flags: CancelOperationFlags): ArgStep {
  const arg = required(args[i]);
  if (arg === "--json") {
    flags.json = true;
    return { consumed: 1 };
  }
  if (arg === "--yes") {
    flags.yes = true;
    return { consumed: 1 };
  }
  if (arg === "-h" || arg === "--help") {
    process.stdout.write(USAGE);
    return { exit: 0 };
  }
  if (arg === "--node") {
    const next = args[i + 1];
    if (next === undefined) {
      process.stderr.write("residency cancel-operation: --node requires a value\n");
      return { exit: 1 };
    }
    flags.node = next;
    return { consumed: 2 };
  }
  if (arg.startsWith("--node=")) {
    flags.node = arg.slice("--node=".length);
    return { consumed: 1 };
  }
  if (arg.startsWith("--")) {
    process.stderr.write(`residency cancel-operation: unknown argument ${arg}\n`);
    return { exit: 1 };
  }
  flags.operationId ??= arg;
  return { consumed: 1 };
}

function parseCancelOperationArgs(args: string[]): CancelOperationFlags | { exit: number } {
  const flags: CancelOperationFlags = {
    operationId: undefined,
    yes: false,
    json: false,
    node: undefined,
  };
  let i = 0;
  while (i < args.length) {
    const step = applyCancelOperationArg(args, i, flags);
    if ("exit" in step) return step;
    i += step.consumed;
  }
  return flags;
}

function cancelOperationUsageError(flags: CancelOperationFlags): string | null {
  if ((flags.operationId ?? "") === "") {
    return `an operation id is required: llamactl residency cancel-operation <operationId> --yes\n${USAGE}`;
  }
  if (!flags.yes) {
    return "refusing without --yes (cancelling aborts an in-flight profile switch at its next step boundary)";
  }
  return null;
}

function renderCancelOperation(
  json: boolean,
  operationId: string,
  result: ResidencyCancelOperationView,
): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  if (!result.ok) {
    process.stderr.write(`residency cancel-operation: ${result.outcome}: ${result.detail}\n`);
    return 1;
  }
  process.stdout.write(
    `Cancel requested for operation ${operationId}: abort delivered; the profile switch stops before its next step boundary (a step already running completes; check residency status for the recorded outcome)\n`,
  );
  return 0;
}

async function runResidencyCancelOperation(args: string[], deps: ResidencyDeps): Promise<number> {
  const parsed = parseCancelOperationArgs(args);
  if ("exit" in parsed) return parsed.exit;

  const usageError = cancelOperationUsageError(parsed);
  if (usageError !== null) {
    process.stderr.write(`residency cancel-operation: ${usageError}\n`);
    return 1;
  }
  const operationId = parsed.operationId ?? "";

  const node = parsed.node ?? getGlobals().nodeName ?? "";
  if (node === "") {
    process.stderr.write(`residency cancel-operation: --node <name> is required\n${USAGE}`);
    return 1;
  }
  if (node === "all") {
    process.stderr.write(
      "residency cancel-operation: --node all is not supported; name one node\n",
    );
    return 1;
  }

  try {
    const client = (deps.getNodeClientByName ?? getNodeClientByName)(node);
    const result = await client.residencyCancelOperation.mutate({
      operationId,
      confirm: true,
    });
    return renderCancelOperation(parsed.json, operationId, result);
  } catch (err) {
    process.stderr.write(`residency cancel-operation: ${(err as Error).message}\n`);
    return 1;
  }
}

interface ForceUnloadFlags {
  workload: string | undefined;
  reason: string | undefined;
  yes: boolean;
  json: boolean;
  node: string | undefined;
}

type ArgStep = { consumed: number } | { exit: number };

function applyForceUnloadArg(args: string[], i: number, flags: ForceUnloadFlags): ArgStep {
  const arg = required(args[i]);
  const next = args[i + 1];
  if (arg === "--json") {
    flags.json = true;
    return { consumed: 1 };
  }
  if (arg === "--yes") {
    flags.yes = true;
    return { consumed: 1 };
  }
  if (arg === "-h" || arg === "--help") {
    process.stdout.write(USAGE);
    return { exit: 0 };
  }
  if (arg === "--reason") {
    flags.reason = next ?? "";
    return { consumed: 2 };
  }
  if (arg.startsWith("--reason=")) {
    flags.reason = arg.slice("--reason=".length);
    return { consumed: 1 };
  }
  if (arg === "--node") {
    if (next === undefined) {
      process.stderr.write("residency force-unload: --node requires a value\n");
      return { exit: 1 };
    }
    flags.node = next;
    return { consumed: 2 };
  }
  if (arg.startsWith("--node=")) {
    flags.node = arg.slice("--node=".length);
    return { consumed: 1 };
  }
  if (arg.startsWith("--")) {
    process.stderr.write(`residency force-unload: unknown argument ${arg}\n`);
    return { exit: 1 };
  }
  flags.workload ??= arg;
  return { consumed: 1 };
}

function parseForceUnloadArgs(args: string[]): ForceUnloadFlags | { exit: number } {
  const flags: ForceUnloadFlags = {
    workload: undefined,
    reason: undefined,
    yes: false,
    json: false,
    node: undefined,
  };
  let i = 0;
  while (i < args.length) {
    const step = applyForceUnloadArg(args, i, flags);
    if ("exit" in step) return step;
    i += step.consumed;
  }
  return flags;
}

function forceUnloadUsageError(flags: ForceUnloadFlags): string | null {
  const workload = flags.workload ?? "";
  if (workload === "") {
    return `a workload is required: llamactl residency force-unload <workload> --reason <text> --yes\n${USAGE}`;
  }
  const reason = (flags.reason ?? "").trim();
  if (reason === "") {
    return "--reason <text> is required";
  }
  if (reason.length > 200) {
    return "--reason must be at most 200 characters";
  }
  if (!flags.yes) {
    return `refusing without --yes (a forced unload revokes active leases on ${workload})`;
  }
  return null;
}

function renderForceUnload(r: ResidencyForceUnloadView): string {
  if (!r.ok) {
    return `Forced unload refused: ${r.reason}\n`;
  }
  const head =
    `Forced unload: ${r.workload} (kind ${r.kind}, epoch ${String(r.epoch)}, ` +
    `revoked ${String(r.revoked.length)} lease(s), source ${r.source}, reason ${r.reason})`;
  const lines = [head];
  if (r.revoked.length === 0) {
    lines.push("Forced unload: revoked 0 lease(s); no lease audit row written");
  }
  // An agent older than #722 omits releasedSessions from the payload even
  // though the current type always carries it, so check at runtime.
  const released: unknown = r.releasedSessions;
  if (Array.isArray(released) && released.length > 0) {
    lines.push(
      `Forced unload: released ${String(released.length)} session(s): ${released.join(", ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function runResidencyForceUnload(args: string[], deps: ResidencyDeps): Promise<number> {
  const parsed = parseForceUnloadArgs(args);
  if ("exit" in parsed) return parsed.exit;

  const usageError = forceUnloadUsageError(parsed);
  if (usageError !== null) {
    process.stderr.write(`residency force-unload: ${usageError}\n`);
    return 1;
  }
  const workload = parsed.workload ?? "";
  const reason = (parsed.reason ?? "").trim();

  const node = parsed.node ?? getGlobals().nodeName ?? "";
  if (node === "") {
    process.stderr.write(`residency force-unload: --node <name> is required\n${USAGE}`);
    return 1;
  }
  if (node === "all") {
    process.stderr.write("residency force-unload: --node all is not supported; name one node\n");
    return 1;
  }

  try {
    const client = (deps.getNodeClientByName ?? getNodeClientByName)(node);
    const result = await client.residencyForceUnload.mutate({ workload, reason, confirm: true });
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }
    if (!result.ok) {
      process.stderr.write(`residency force-unload: ${result.reason}: ${result.detail}\n`);
      return 1;
    }
    process.stdout.write(renderForceUnload(result));
    return 0;
  } catch (err) {
    process.stderr.write(`residency force-unload: ${(err as Error).message}\n`);
    return 1;
  }
}

interface EvictIdleFlags {
  yes: boolean;
  json: boolean;
  node: string | undefined;
}

function applyEvictIdleArg(args: string[], i: number, flags: EvictIdleFlags): ArgStep {
  const arg = required(args[i]);
  if (arg === "--json") {
    flags.json = true;
    return { consumed: 1 };
  }
  if (arg === "--yes") {
    flags.yes = true;
    return { consumed: 1 };
  }
  if (arg === "-h" || arg === "--help") {
    process.stdout.write(USAGE);
    return { exit: 0 };
  }
  if (arg === "--node") {
    const next = args[i + 1];
    if (next === undefined) {
      process.stderr.write("residency evict-idle: --node requires a value\n");
      return { exit: 1 };
    }
    flags.node = next;
    return { consumed: 2 };
  }
  if (arg.startsWith("--node=")) {
    flags.node = arg.slice("--node=".length);
    return { consumed: 1 };
  }
  process.stderr.write(`residency evict-idle: unknown argument ${arg}\n`);
  return { exit: 1 };
}

function parseEvictIdleArgs(args: string[]): EvictIdleFlags | { exit: number } {
  const flags: EvictIdleFlags = { yes: false, json: false, node: undefined };
  let i = 0;
  while (i < args.length) {
    const step = applyEvictIdleArg(args, i, flags);
    if ("exit" in step) return step;
    i += step.consumed;
  }
  return flags;
}

function localManifestKind(name: string, dir: string): EvictIdleKind | null {
  try {
    return workloadStore.loadWorkloadByNameAny(name, dir).kind === "ModelHost"
      ? "modelhost"
      : "modelrun";
  } catch {
    return null;
  }
}

function notHeldRow(workload: string, dir: string): EvictIdleRow {
  return {
    workload,
    action: "skipped",
    reason: "NotHeld",
    detail: `no ModelRun or ModelHost manifest named ${workload} in ${dir}; run evict-idle where the controller's store lives`,
  };
}

function renderEvictIdleRow(row: EvictIdleRow): string {
  const cols = [row.workload];
  if (row.action === "skipped") {
    cols.push("skipped");
    if (row.reason !== undefined) cols.push(row.reason);
    if (row.detail !== undefined) cols.push(row.detail);
  } else {
    cols.push(row.action);
    if (row.kind !== undefined) cols.push(row.kind);
  }
  return `  ${cols.join("  ")}`;
}

function renderEvictIdle(
  dryRun: boolean,
  windowSeconds: number,
  rows: readonly EvictIdleRow[],
): string {
  const head = dryRun
    ? `Idle eviction (dry run): window ${String(windowSeconds)}s`
    : `Idle eviction: window ${String(windowSeconds)}s`;
  const lines = [head];
  if (rows.length === 0) {
    lines.push("  no ready workloads");
  } else {
    for (const row of rows) lines.push(renderEvictIdleRow(row));
  }
  return `${lines.join("\n")}\n`;
}

type EvictCandidate = { workload: string; kind: EvictIdleKind };

// Split the dry rows into local targets (a manifest the controller's store can
// hold) and NotHeld rows (no local manifest, so eviction cannot take). The
// display rows keep would-evict rows verbatim and substitute NotHeld.
function classifyEvictRows(
  rows: readonly EvictIdleRow[],
  dir: string,
): { display: EvictIdleRow[]; notHeld: EvictIdleRow[]; candidates: EvictCandidate[] } {
  const display: EvictIdleRow[] = [];
  const notHeld: EvictIdleRow[] = [];
  const candidates: EvictCandidate[] = [];
  for (const row of rows) {
    if (row.action !== "would-evict") {
      display.push(row);
      continue;
    }
    const kind = localManifestKind(row.workload, dir);
    if (kind === null) {
      const skipped = notHeldRow(row.workload, dir);
      notHeld.push(skipped);
      display.push(skipped);
      continue;
    }
    candidates.push({ workload: row.workload, kind });
    display.push(row);
  }
  return { display, notHeld, candidates };
}

function emitEvictView(
  json: boolean,
  dryRun: boolean,
  windowSeconds: number,
  rows: readonly EvictIdleRow[],
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun, windowSeconds, rows }, null, 2)}\n`);
    return;
  }
  process.stdout.write(renderEvictIdle(dryRun, windowSeconds, rows));
}

function stampEvictHolds(
  candidates: readonly EvictCandidate[],
  stampIso: string,
  dir: string,
): string[] {
  const stamped: string[] = [];
  for (const candidate of candidates) {
    if (workloadReconciler.stampIdleEvictionHold(candidate.workload, stampIso, dir) !== null) {
      stamped.push(candidate.workload);
    }
  }
  return stamped;
}

function clearEvictHolds(workloads: readonly string[], dir: string): void {
  for (const workload of workloads) workloadReconciler.clearIdleEvictionHold(workload, dir);
}

// Keep the hold only on rows that came back evicted; a skipped/refused/failed
// stop means the workload still runs, so its stamp is rolled back.
function keepOnlyEvictedHolds(
  candidates: readonly EvictCandidate[],
  rows: readonly EvictIdleRow[],
  dir: string,
): void {
  const byWorkload = new Map(rows.map((row) => [row.workload, row] as const));
  for (const candidate of candidates) {
    if (byWorkload.get(candidate.workload)?.action !== "evicted") {
      workloadReconciler.clearIdleEvictionHold(candidate.workload, dir);
    }
  }
}

async function runWetEvict(
  client: NodeClient,
  node: string,
  dir: string,
  stampIso: string,
  candidates: readonly EvictCandidate[],
  notHeld: readonly EvictIdleRow[],
  json: boolean,
): Promise<number> {
  const stamped = stampEvictHolds(candidates, stampIso, dir);
  let wet: EvictIdleResult;
  try {
    wet = await client.residencyEvictIdle.mutate({
      node,
      targets: candidates.map((candidate) => ({
        workload: candidate.workload,
        kind: candidate.kind,
      })),
    });
  } catch (err) {
    clearEvictHolds(stamped, dir);
    process.stderr.write(`residency evict-idle: ${(err as Error).message}\n`);
    return 1;
  }
  if (!wet.ok) {
    clearEvictHolds(stamped, dir);
    process.stderr.write(`residency evict-idle: ${wet.reason}\n`);
    return 1;
  }
  keepOnlyEvictedHolds(candidates, wet.rows, dir);
  emitEvictView(json, false, wet.windowSeconds, [...wet.rows, ...notHeld]);
  return wet.rows.some((row) => row.reason === "StopFailed") ? 1 : 0;
}

async function runResidencyEvictIdle(args: string[], deps: ResidencyDeps): Promise<number> {
  const parsed = parseEvictIdleArgs(args);
  if ("exit" in parsed) return parsed.exit;

  const node = parsed.node ?? getGlobals().nodeName ?? "";
  if (node === "") {
    process.stderr.write(`residency evict-idle: --node <name> is required\n${USAGE}`);
    return 1;
  }
  if (node === "all") {
    process.stderr.write("residency evict-idle: --node all is not supported; name one node\n");
    return 1;
  }
  const dir = deps.workloadsDir ?? workloadStore.defaultWorkloadsDir();
  const now = deps.now ?? ((): Date => new Date());
  const client = (deps.getNodeClientByName ?? getNodeClientByName)(node);

  let dry: EvictIdleResult;
  try {
    dry = await withNodeQueryDeadline(node, () => client.residencyEvictIdle.mutate({ node }));
  } catch (err) {
    process.stderr.write(`residency evict-idle: ${(err as Error).message}\n`);
    return 1;
  }
  if (!dry.ok) {
    process.stderr.write(`residency evict-idle: ${dry.reason}\n`);
    return 1;
  }

  const { display, notHeld, candidates } = classifyEvictRows(dry.rows, dir);
  if (!parsed.yes || candidates.length === 0) {
    emitEvictView(parsed.json, true, dry.windowSeconds, display);
    return 0;
  }
  return await runWetEvict(
    client,
    node,
    dir,
    now().toISOString(),
    candidates,
    notHeld,
    parsed.json,
  );
}

interface ReleaseIdleFlags {
  workload: string | undefined;
  json: boolean;
}

function applyReleaseIdleArg(args: string[], i: number, flags: ReleaseIdleFlags): ArgStep {
  const arg = required(args[i]);
  if (arg === "--json") {
    flags.json = true;
    return { consumed: 1 };
  }
  if (arg === "-h" || arg === "--help") {
    process.stdout.write(USAGE);
    return { exit: 0 };
  }
  if (arg.startsWith("--")) {
    process.stderr.write(`residency release-idle: unknown argument ${arg}\n`);
    return { exit: 1 };
  }
  flags.workload ??= arg;
  return { consumed: 1 };
}

function parseReleaseIdleArgs(args: string[]): ReleaseIdleFlags | { exit: number } {
  const flags: ReleaseIdleFlags = { workload: undefined, json: false };
  let i = 0;
  while (i < args.length) {
    const step = applyReleaseIdleArg(args, i, flags);
    if ("exit" in step) return step;
    i += step.consumed;
  }
  return flags;
}

function renderReleaseIdle(workload: string, outcome: "cleared" | "not-held"): string {
  return outcome === "cleared"
    ? `released idle hold on ${workload}\n`
    : `${workload} has no idle hold\n`;
}

function runResidencyReleaseIdle(args: string[], deps: ResidencyDeps): number {
  const parsed = parseReleaseIdleArgs(args);
  if ("exit" in parsed) return parsed.exit;

  const workload = parsed.workload ?? "";
  if (workload === "") {
    process.stderr.write(
      `residency release-idle: a workload is required: llamactl residency release-idle <workload>\n${USAGE}`,
    );
    return 1;
  }
  const dir = deps.workloadsDir ?? workloadStore.defaultWorkloadsDir();
  const outcome = workloadReconciler.clearIdleEvictionHold(workload, dir);
  if (outcome === "missing") {
    process.stderr.write(`residency release-idle: no ModelRun or ModelHost named ${workload}\n`);
    return 1;
  }
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ workload, outcome }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(renderReleaseIdle(workload, outcome));
  return 0;
}

interface ReleaseSessionFlags {
  sessionId: string | undefined;
  force: boolean;
  yes: boolean;
  json: boolean;
  node: string | undefined;
}

function applyReleaseSessionArg(args: string[], i: number, flags: ReleaseSessionFlags): ArgStep {
  const arg = required(args[i]);
  const next = args[i + 1];
  if (arg === "--json") {
    flags.json = true;
    return { consumed: 1 };
  }
  if (arg === "--yes") {
    flags.yes = true;
    return { consumed: 1 };
  }
  if (arg === "--force") {
    flags.force = true;
    return { consumed: 1 };
  }
  if (arg === "-h" || arg === "--help") {
    process.stdout.write(USAGE);
    return { exit: 0 };
  }
  if (arg === "--node") {
    if (next === undefined) {
      process.stderr.write("residency release-session: --node requires a value\n");
      return { exit: 1 };
    }
    flags.node = next;
    return { consumed: 2 };
  }
  if (arg.startsWith("--node=")) {
    flags.node = arg.slice("--node=".length);
    return { consumed: 1 };
  }
  if (arg.startsWith("--")) {
    process.stderr.write(`residency release-session: unknown argument ${arg}\n`);
    return { exit: 1 };
  }
  flags.sessionId ??= arg;
  return { consumed: 1 };
}

function parseReleaseSessionArgs(args: string[]): ReleaseSessionFlags | { exit: number } {
  const flags: ReleaseSessionFlags = {
    sessionId: undefined,
    force: false,
    yes: false,
    json: false,
    node: undefined,
  };
  let i = 0;
  while (i < args.length) {
    const step = applyReleaseSessionArg(args, i, flags);
    if ("exit" in step) return step;
    i += step.consumed;
  }
  return flags;
}

function releaseSessionUsageError(flags: ReleaseSessionFlags): string | null {
  const sessionId = flags.sessionId ?? "";
  if (sessionId === "") {
    return `a session id is required: llamactl residency release-session <sessionId> --yes\n${USAGE}`;
  }
  if (!flags.yes) {
    return `refusing without --yes (releasing session ${sessionId} lets its workload be unloaded)`;
  }
  return null;
}

function renderReleaseSession(r: Extract<ResidencyReleaseSessionView, { ok: true }>): string {
  const inFlight = `${String(r.refs)} in-flight request(s)`;
  const forced = r.forced ? ", forced; their leases stay held" : "";
  return `Released session ${r.sessionId} (workload ${r.workload}, ${inFlight}${forced})\n`;
}

async function runResidencyReleaseSession(args: string[], deps: ResidencyDeps): Promise<number> {
  const parsed = parseReleaseSessionArgs(args);
  if ("exit" in parsed) return parsed.exit;

  const usageError = releaseSessionUsageError(parsed);
  if (usageError !== null) {
    process.stderr.write(`residency release-session: ${usageError}\n`);
    return 1;
  }
  const sessionId = parsed.sessionId ?? "";

  const node = parsed.node ?? getGlobals().nodeName ?? "";
  if (node === "") {
    process.stderr.write(`residency release-session: --node <name> is required\n${USAGE}`);
    return 1;
  }
  if (node === "all") {
    process.stderr.write("residency release-session: --node all is not supported; name one node\n");
    return 1;
  }

  try {
    const client = (deps.getNodeClientByName ?? getNodeClientByName)(node);
    const result = await client.residencyReleaseSession.mutate({
      sessionId,
      force: parsed.force,
      confirm: true,
    });
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }
    if (!result.ok) {
      process.stderr.write(`residency release-session: ${result.reason}: ${result.detail}\n`);
      return 1;
    }
    process.stdout.write(renderReleaseSession(result));
    return 0;
  } catch (err) {
    process.stderr.write(`residency release-session: ${(err as Error).message}\n`);
    return 1;
  }
}

type ResidencyControlAction = "load" | "unload";
type ResidencyControlInput = Parameters<NodeClient["residencyControl"]["mutate"]>[0];

function controlArgs(
  action: ResidencyControlAction,
  args: string[],
): { json: boolean; input: ResidencyControlInput } | string {
  const [workload, ...flags] = args;
  if (workload === undefined || workload.startsWith("-")) return "a workload name is required";
  let node = getGlobals().nodeName ?? "";
  let execute = false;
  let confirm = false;
  let json = false;
  let waitSeconds: number | undefined;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index] ?? "";
    switch (flag) {
      case "--node":
        node = flags[++index] ?? "";
        if (node.startsWith("-")) return "--node requires a value";
        break;
      case "--execute":
        execute = true;
        break;
      case "--yes":
        confirm = true;
        break;
      case "--json":
        json = true;
        break;
      case "--wait-seconds":
        waitSeconds = Number(flags[++index]);
        break;
      default:
        return `unknown argument ${flag}`;
    }
  }
  if (node === "") return "--node <name> is required";
  if (node === "all") return "name one managed node";
  if (execute && !confirm) return "--execute requires --yes";
  return controlWait(
    { json, input: { workload, node, action, dryRun: !execute, confirm } },
    waitSeconds,
  );
}

function controlWait(
  parsed: { json: boolean; input: ResidencyControlInput },
  waitSeconds: number | undefined,
): ReturnType<typeof controlArgs> {
  if (waitSeconds === undefined) return parsed;
  if (
    parsed.input.action !== "unload" ||
    !Number.isSafeInteger(waitSeconds) ||
    waitSeconds < 1 ||
    waitSeconds > 60
  ) {
    return "--wait-seconds requires unload and an integer from 1 to 60";
  }
  return { ...parsed, input: { ...parsed.input, drainTimeoutMs: waitSeconds * 1000 } };
}

function isMissingProcedure(error: unknown): boolean {
  const data = typeof error === "object" && error !== null && "data" in error ? error.data : null;
  return typeof data === "object" && data !== null && "code" in data && data.code === "NOT_FOUND";
}

function controlTransportReason(error: unknown): string {
  return isMissingProcedure(error) ? "ManagedControlUnavailable" : "ControlTransportError";
}

async function runResidencyControl(
  action: ResidencyControlAction,
  args: string[],
  deps: ResidencyDeps,
): Promise<number> {
  const parsed = controlArgs(action, args);
  if (typeof parsed === "string") {
    process.stderr.write(`residency ${action}: ${parsed}\n`);
    return 1;
  }
  const { json, input } = parsed;
  try {
    const client = (deps.getNodeClientByName ?? getNodeClientByName)(input.node);
    const result = input.dryRun
      ? await withNodeQueryDeadline(input.node, () => client.residencyControl.mutate(input))
      : await client.residencyControl.mutate(input);
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (result.ok) {
      process.stdout.write(
        `residency ${action} ${result.workload} on ${result.node}: ${result.outcome}\n`,
      );
    } else process.stderr.write(`residency ${action}: ${result.reason}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    const reason = controlTransportReason(error);
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, action, node: input.node, workload: input.workload, reason }, null, 2)}\n`,
      );
    } else process.stderr.write(`residency ${action}: ${reason}\n`);
    return 1;
  }
}

export async function runResidency(args: string[], deps: ResidencyDeps = {}): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined) {
    process.stderr.write(USAGE);
    return 1;
  }
  if (sub === "-h" || sub === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (sub === "status") {
    return await runResidencyStatus(rest, deps);
  }
  if (sub === "plan") {
    return await runResidencyPlan(rest, deps);
  }
  if (sub === "apply-profile") {
    return await runResidencyApplyProfile(rest, deps);
  }
  if (sub === "load" || sub === "unload") {
    return await runResidencyControl(sub, rest, deps);
  }
  if (sub === "cancel-operation") {
    return await runResidencyCancelOperation(rest, deps);
  }
  if (sub === "force-unload") {
    return await runResidencyForceUnload(rest, deps);
  }
  if (sub === "evict-idle") {
    return await runResidencyEvictIdle(rest, deps);
  }
  if (sub === "release-idle") {
    return runResidencyReleaseIdle(rest, deps);
  }
  if (sub === "release-session") {
    return await runResidencyReleaseSession(rest, deps);
  }
  process.stderr.write(`Unknown residency subcommand: ${sub}\n${USAGE}`);
  return 1;
}
