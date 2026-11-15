// #284 (DF-11): read-only `llamactl residency status`, plus the #278 (DF-05)
// operator `residency force-unload`. Status routes one residencyStatus.query
// through the dispatcher, bounded by the exported withNodeQueryDeadline helper,
// and renders the serving process's NodeRun policy, memory budget and node-local
// residency store; it never wakes a model and never mutates. force-unload is the
// one deliberate mutation here: it drives a workload through the lease fence,
// revoking active leases and auditing any revocation as an operator override
// (an idle unload, with no leases held, writes no lease audit row).

import type { NodeClient, noderunSchema } from "@llamactl/remote";

import { getGlobals, getNodeClientByName } from "../dispatcher.js";
import { required } from "../required.js";
import { withNodeQueryDeadline } from "./workload.js";

const USAGE = `Usage: llamactl residency <subcommand>

Subcommands:
  status --node <name> [--json]   Read-only residency status: NodeRun policy, memory budget, the serving process's residency store and its per-workload lease/drain state. Never wakes a model or mutates state.
  force-unload <workload> --reason <text> --yes [--node <name>] [--json]   Operator override of the stop fence: revoke active leases (audited as an operator override), then stop the workload. Destructive; requires --yes.

Example:
  llamactl residency status --node <name> [--json]
  llamactl residency force-unload <workload> --reason <text> --yes
`;

export type ResidencyStatusView = Awaited<ReturnType<NodeClient["residencyStatus"]["query"]>>;

export type ResidencyForceUnloadView = Awaited<
  ReturnType<NodeClient["residencyForceUnload"]["mutate"]>
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
  pushLeaseLines(lines, s.leases);
  lines.push(
    `Note:       store is the serving process's node-local store, not ${s.node}'s coordinator state`,
  );
  return lines.join("\n") + "\n";
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
  if (sub === "force-unload") {
    return await runResidencyForceUnload(rest, deps);
  }
  process.stderr.write(`Unknown residency subcommand: ${sub}\n${USAGE}`);
  return 1;
}
