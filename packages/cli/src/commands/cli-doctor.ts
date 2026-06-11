/**
 * `llamactl agent cli <subcommand>` — tooling around the CLI
 * subscription backends declared in kubeconfig agent nodes.
 *
 * Subcommands (v1):
 *   doctor [--node=<name>] [--json]
 *     Probe every declared CLI binding on the target agent (or
 *     every agent when `--node` is absent). Reports
 *     `{state, latencyMs, error?}` per binding. Non-zero exit if
 *     any binding is unhealthy — quality-gate semantics for CI.
 */
import {
  type ClusterNode,
  type Config,
  createCliSubprocessProvider,
  config as kubecfg,
  resolveNodeKind,
} from "@llamactl/remote";

import { required } from "../required.js";

const USAGE = `Usage: llamactl agent cli <subcommand>

Subcommands:
  doctor [--node=<name>] [--json]
      Probe every declared CLI binding and report health. Exits 0
      when every probe is healthy, 2 when any fails, 1 on usage
      error.
`;

export async function runAgentCli(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "doctor":
      return await runDoctor(rest);
    case undefined:
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown agent cli subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}

interface DoctorOpts {
  node: string | undefined;
  json: boolean;
}

function parseDoctor(args: string[]): DoctorOpts | { error: string } {
  let node: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = required(args[i]);
    if (a === "--node" || a === "-n") node = args[++i];
    else if (a.startsWith("--node=")) node = a.slice("--node=".length);
    else if (a === "--json") json = true;
    else if (a === "-h" || a === "--help") return { error: "help" };
    else return { error: `Unknown flag: ${a}` };
  }
  return { node, json };
}

export interface DoctorResult {
  agent: string;
  binding: string;
  preset: string;
  state: "healthy" | "degraded" | "unhealthy" | "unknown";
  latencyMs: number | null;
  error?: string;
}

function resolveDoctorAgents(nodeFilter: string | undefined): ClusterNode[] | { error: string } {
  let cfg: Config;
  try {
    cfg = kubecfg.loadConfig();
  } catch (err) {
    return { error: `agent cli doctor: ${(err as Error).message}\n` };
  }

  const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
  if (!ctx) {
    return { error: `agent cli doctor: no current context\n` };
  }
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  if (!cluster) {
    return { error: `agent cli doctor: cluster '${ctx.cluster}' not found\n` };
  }

  const agents = cluster.nodes.filter(
    (n): n is ClusterNode =>
      resolveNodeKind(n) === "agent" && (!nodeFilter || n.name === nodeFilter),
  );
  if (agents.length === 0) {
    return {
      error: `agent cli doctor: no agent nodes match${nodeFilter ? ` --node=${nodeFilter}` : ""}\n`,
    };
  }
  return agents;
}

async function probeCliBinding(
  agent: ClusterNode,
  binding: NonNullable<ClusterNode["cli"]>[number],
): Promise<DoctorResult> {
  const provider = createCliSubprocessProvider({
    agentName: agent.name,
    binding,
  });
  if (!provider.healthCheck) {
    return {
      agent: agent.name,
      binding: binding.name,
      preset: binding.preset,
      state: "unknown",
      latencyMs: null,
      error: "healthCheck not implemented",
    };
  }
  try {
    const h = await provider.healthCheck();
    const entry: DoctorResult = {
      agent: agent.name,
      binding: binding.name,
      preset: binding.preset,
      state: h.state,
      latencyMs: typeof h.latencyMs === "number" ? h.latencyMs : null,
    };
    if (h.error) entry.error = h.error;
    return entry;
  } catch (err) {
    return {
      agent: agent.name,
      binding: binding.name,
      preset: binding.preset,
      state: "unhealthy",
      latencyMs: null,
      error: (err as Error).message,
    };
  }
}

async function collectDoctorResults(agents: ClusterNode[]): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];
  for (const agent of agents) {
    for (const binding of agent.cli ?? []) {
      results.push(await probeCliBinding(agent, binding));
    }
  }
  return results;
}

function printDoctorResults(results: DoctorResult[], json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ results })}\n`);
    return;
  }
  if (results.length === 0) {
    process.stdout.write("(no CLI bindings declared on any agent)\n");
    return;
  }
  for (const r of results) {
    const mark = r.state === "healthy" ? "ok" : r.state;
    const latency = r.latencyMs !== null ? `${String(r.latencyMs)}ms` : "—";
    process.stdout.write(
      `[${mark}] ${r.agent}.${r.binding} (${r.preset}) · ${latency}${r.error ? ` · ${r.error}` : ""}\n`,
    );
  }
}

async function runDoctor(args: string[]): Promise<number> {
  const parsed = parseDoctor(args);
  if ("error" in parsed) {
    if (parsed.error === "help") {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }

  const agents = resolveDoctorAgents(parsed.node);
  if ("error" in agents) {
    process.stderr.write(agents.error);
    return 1;
  }

  const results = await collectDoctorResults(agents);
  printDoctorResults(results, parsed.json);

  const anyBad = results.some((r) => r.state !== "healthy");
  return anyBad ? 2 : 0;
}
