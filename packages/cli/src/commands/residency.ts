// #284 (DF-11): read-only `llamactl residency status` and `residency plan`,
// plus the #278 (DF-05) operator `residency force-unload`. Status routes one
// residencyStatus.query through the dispatcher, bounded by the exported
// withNodeQueryDeadline helper, and renders the serving process's NodeRun policy,
// memory budget and node-local residency store; it never wakes a model and never
// mutates. plan is the read-only dry-run profile switch: it routes one
// residencyPlan.query and renders budget source, victims, replacements,
// protected workloads or a refusal reason; a refusal is a successful dry-run
// answer and exits 0, never starting, stopping, loading or writing the store.
// apply-profile is the dry-run-by-default profile switch (wired: it records an
// operation and stops/starts workloads when run with --execute --yes).
// cancel-operation requests an abort of one of those in-flight switches by
// operationId; it is process-local and destructive. force-unload is the other
// deliberate mutation here: it drives a workload through
// the lease fence, revoking active leases and auditing any revocation as an
// operator override (an idle unload, with no leases held, writes no lease audit
// row). release-session (#520) is the per-session counterpart: it drops one
// session binding by id through residencyReleaseSession — never draining,
// revoking leases or stopping the workload — so the DF-05 leases of in-flight
// requests stay held and LeasesActive still fences their stop.

import type { NodeClient, noderunSchema } from "@llamactl/remote";

import { getGlobals, getNodeClientByName } from "../dispatcher.js";
import { required } from "../required.js";
import { withNodeQueryDeadline } from "./workload.js";

const USAGE = `Usage: llamactl residency <subcommand>

Subcommands:
  status --node <name> [--json]   Read-only residency status: NodeRun policy, memory budget, the serving process's residency store, its per-model lifecycle rows and exclusive-group violations, its per-workload lease/drain state, and its bound sessions (refs, idle-timeout expiry). Never wakes a model or mutates state.
  plan --node <name> --to <profile> [--from <profile>] [--json]   Read-only dry-run profile switch: budget source, victims, replacements, protected workloads or refusal. Never starts, stops, loads or writes the store.
  apply-profile --node <name> --to <profile> [--from <profile>] [--json]   Dry-run by default: plan and report the profile switch without touching the store. Add --execute --yes to run the switch for real (stops and starts workloads, records an operation).
  cancel-operation <operationId> --yes [--node <name>] [--json]   Request an abort of an in-flight profile switch started by apply-profile --execute --yes in the process serving <node> (an agent serve process); it stops before its next step boundary. Process-local: a switch run in-process by a local-endpoint CLI invocation cannot be cancelled from another CLI invocation. Requires --yes.
  force-unload <workload> --reason <text> --yes [--node <name>] [--json]   Operator override of the stop fence: revoke active leases (audited as an operator override), then stop the workload. Destructive; requires --yes. Reports the released session ids when a session registry is installed.
  release-session <sessionId> --yes [--force] [--node <name>] [--json]   Operator release of one session binding by id: drops only the binding; the DF-05 leases of in-flight requests stay held, so LeasesActive still fences their stop. An idle binding drops; an in-flight binding refuses unless --force is given. Requires --yes.

Example:
  llamactl residency status --node <name> [--json]
  llamactl residency plan --node <name> --to <profile> [--json]
  llamactl residency apply-profile --node <name> --to <profile> [--from <profile>] [--execute --yes]
  llamactl residency cancel-operation <operationId> --yes
  llamactl residency force-unload <workload> --reason <text> --yes
  llamactl residency release-session <sessionId> --yes [--node <name>]
`;

export type ResidencyStatusView = Awaited<ReturnType<NodeClient["residencyStatus"]["query"]>>;

export type ResidencyPlanView = Awaited<ReturnType<NodeClient["residencyPlan"]["query"]>>;

export type ResidencyForceUnloadView = Awaited<
  ReturnType<NodeClient["residencyForceUnload"]["mutate"]>
>;

export type ResidencyApplyProfileView = Awaited<
  ReturnType<NodeClient["residencyApplyProfile"]["mutate"]>
>;

export type ResidencyCancelOperationView = Awaited<
  ReturnType<NodeClient["residencyCancelOperation"]["mutate"]>
>;

export type ResidencyReleaseSessionView = Awaited<
  ReturnType<NodeClient["residencyReleaseSession"]["mutate"]>
>;

export interface ResidencyDeps {
  getNodeClientByName?: typeof getNodeClientByName;
}

// tRPC output typing strips `| undefined` from optional properties, so the
// schema-authored ResidencyStatus is not assignable to ResidencyStatusView
// under exactOptionalPropertyTypes. Re-widen policy.residency from the NodeRun
// schema so both the client view and the assembled payload render.
type ResidencyRenderInput = Omit<ResidencyStatusView, "policy"> & {
  policy: { present: false } | { present: true; residency: noderunSchema.NodeRunResidency };
};

export function renderResidencyStatus(s: ResidencyRenderInput): string {
  const lines: string[] = [];
  lines.push(`Node:       ${s.node}`);
  lines.push(`NodeRun:    ${s.nodeRun.present ? "present" : "absent"}`);
  lines.push(`Policy:     ${s.policy.present ? JSON.stringify(s.policy.residency) : "none"}`);
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
  pushLeaseLines(lines, s.leases);
  pushSessionLines(lines, s.sessions);
  lines.push(
    `Note:       store is the serving process's node-local store, not ${s.node}'s coordinator state`,
  );
  return lines.join("\n") + "\n";
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

function formatMs(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60)}m`;
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
    process.stdout.write(renderResidencyStatus(status));
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
    lines.push(renderResidencyPlanLabel(`  ${step.action}:`, `${step.workload} (${step.status})`));
  }
  return `${lines.join("\n")}\n`;
}

type ResidencyApplyProfileInput = Parameters<NodeClient["residencyApplyProfile"]["mutate"]>[0];

async function callResidencyApplyProfile(
  client: NodeClient,
  node: string,
  execute: boolean,
  input: ResidencyApplyProfileInput,
): Promise<ResidencyApplyProfileView> {
  if (execute) {
    return await client.residencyApplyProfile.mutate(input);
  }
  return await withNodeQueryDeadline(node, () => client.residencyApplyProfile.mutate(input));
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
    const client = (deps.getNodeClientByName ?? getNodeClientByName)(node);
    const result = await callResidencyApplyProfile(client, node, parsed.execute, input);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }
    if (!result.ok) {
      const reason = result.refusal?.reason ?? result.outcome;
      const detail = result.refusal?.detail ?? "";
      process.stderr.write(`residency apply-profile: ${reason}: ${detail}\n`);
      return 1;
    }
    process.stdout.write(
      renderResidencyApplyProfile({ node, to: parsed.to, from: from ?? null }, result),
    );
    return 0;
  } catch (err) {
    process.stderr.write(`residency apply-profile: ${(err as Error).message}\n`);
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
  if (sub === "cancel-operation") {
    return await runResidencyCancelOperation(rest, deps);
  }
  if (sub === "force-unload") {
    return await runResidencyForceUnload(rest, deps);
  }
  if (sub === "release-session") {
    return await runResidencyReleaseSession(rest, deps);
  }
  process.stderr.write(`Unknown residency subcommand: ${sub}\n${USAGE}`);
  return 1;
}
