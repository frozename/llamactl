// #284 (DF-11): read-only `llamactl residency status`. It routes one
// residencyStatus.query through the dispatcher, bounded by the exported
// withNodeQueryDeadline helper, and renders the serving process's NodeRun
// policy, memory budget and node-local residency store. It never wakes a
// model and never mutates state.

import type { NodeClient, noderunSchema } from "@llamactl/remote";

import { getGlobals, getNodeClientByName } from "../dispatcher.js";
import { required } from "../required.js";
import { withNodeQueryDeadline } from "./workload.js";

const USAGE = `Usage: llamactl residency <subcommand>

Subcommands:
  status --node <name> [--json]   Read-only residency status: NodeRun policy, memory budget and the serving process's residency store. Never wakes a model or mutates state.

Example:
  llamactl residency status --node <name> [--json]
`;

export type ResidencyStatusView = Awaited<ReturnType<NodeClient["residencyStatus"]["query"]>>;

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
  lines.push(
    `Note:       store is the serving process's node-local store, not ${s.node}'s coordinator state`,
  );
  return lines.join("\n") + "\n";
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
  process.stderr.write(`Unknown residency subcommand: ${sub}\n${USAGE}`);
  return 1;
}
