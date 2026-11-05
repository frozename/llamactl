// frozename/llamactl#249: render the per-ModelHost engine throughput the fleet
// supervisor appends to each fleet-snapshot. Reads only journaled data (local
// journal + peer snapshots) — it never wakes a model or issues inference.

import type { ThroughputDistribution, WorkloadThroughputStats } from "@llamactl/fleet-supervisor";

import {
  findThroughputMatch,
  gatherSnapshots,
  NO_SNAPSHOT_REASON,
  resolveWorkloadStatusDeps,
  type ThroughputMatch,
  type WorkloadStatusDeps,
} from "./workload-snapshots.js";
import { runTop } from "./workload-top.js";

const USAGE = `Usage: llamactl workload <subcommand>

Subcommands:
  status <name> --metrics [--json]   Show journaled engine throughput sampled
                                     by the fleet supervisor (decode/prefill
                                     tok/s, busy slots, deferral). Reads only
                                     the fleet journal — never wakes a model.
  top [--watch[=<seconds>]] [--json] Live per-ModelHost throughput (decode/
                                     prefill tok/s, mean busy slots, deferred
                                     share, counter resets). Reads only the
                                     fleet journal — never wakes a model.
`;

function formatAvailability(status: { available: boolean; reason?: string }): string {
  if (status.available) return "available";
  if (status.reason === undefined || status.reason === "") return "unavailable";
  return `unavailable (${status.reason})`;
}

function formatDistribution(dist: ThroughputDistribution): string {
  return `median ${dist.median.toFixed(1)} (p10 ${dist.p10.toFixed(1)}, p90 ${dist.p90.toFixed(1)}, n=${String(dist.count)})`;
}

function formatMeanBusySlots(stats: WorkloadThroughputStats): string {
  if (stats.meanBusySlots === null) return "mean busy slots: unavailable";
  const mean = `mean busy slots: ${stats.meanBusySlots.toFixed(2)}`;
  return stats.maxBusySlots === null ? mean : `${mean} (max ${String(stats.maxBusySlots)})`;
}

function statsLines(stats: WorkloadThroughputStats | null): string[] {
  if (stats === null) {
    return [
      "samples: unavailable",
      "window: unavailable",
      "counter resets: unavailable",
      "decode tok/s: unavailable",
      "prefill tok/s: unavailable",
      "mean busy slots: unavailable",
      "deferred share: unavailable",
      "decode by busy slots: unavailable",
    ];
  }
  const lines: string[] = [];
  lines.push(`samples: ${String(stats.sampleCount)} (${String(stats.intervalCount)} intervals)`);
  lines.push(
    stats.firstSampleAt !== null && stats.lastSampleAt !== null
      ? `window: ${stats.firstSampleAt} .. ${stats.lastSampleAt}`
      : "window: unavailable",
  );
  lines.push(`counter resets: ${String(stats.counterResets)}`);
  lines.push(
    stats.decodeTokPerSec === null
      ? "decode tok/s: unavailable"
      : `decode tok/s: ${formatDistribution(stats.decodeTokPerSec)}`,
  );
  lines.push(
    stats.prefillTokPerSec === null
      ? "prefill tok/s: unavailable"
      : `prefill tok/s: ${formatDistribution(stats.prefillTokPerSec)}`,
  );
  lines.push(formatMeanBusySlots(stats));
  lines.push(
    stats.deferredShare === null
      ? "deferred share: unavailable"
      : `deferred share: ${(stats.deferredShare * 100).toFixed(1)}%`,
  );
  const buckets = Object.entries(stats.decodeByBusySlots).sort(([a], [b]) => Number(a) - Number(b));
  if (buckets.length === 0) {
    lines.push("decode by busy slots: unavailable");
  } else {
    lines.push("decode by busy slots:");
    for (const [key, dist] of buckets) {
      lines.push(`  ${key}: ${formatDistribution(dist)}`);
    }
  }
  return lines;
}

function writeHuman(match: ThroughputMatch): void {
  const { entry } = match;
  const lines: string[] = [
    `workload: ${entry.workload}`,
    `node: ${match.node}`,
    `sampled: ${entry.sampledAt} (snapshot ${match.snapshotTs})`,
    entry.revision === null ? "revision: unavailable" : `revision: ${entry.revision}`,
    `metrics: ${formatAvailability(entry.metrics)}`,
    `slots: ${formatAvailability(entry.slots)}`,
    ...statsLines(entry.stats),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function writeAvailableJson(match: ThroughputMatch): void {
  const { entry } = match;
  process.stdout.write(
    `${JSON.stringify(
      {
        available: true,
        workload: entry.workload,
        node: match.node,
        snapshotTs: match.snapshotTs,
        sampledAt: entry.sampledAt,
        revision: entry.revision,
        metrics: entry.metrics,
        slots: entry.slots,
        stats: entry.stats,
      },
      null,
      2,
    )}\n`,
  );
}

function writeUnavailableJson(name: string, reason: string): void {
  process.stdout.write(
    `${JSON.stringify({ workload: name, available: false, reason }, null, 2)}\n`,
  );
}

type StatusArgs = { name: string; metrics: boolean; json: boolean } | { error: string };

function parseStatusArgs(rest: string[]): StatusArgs {
  let name: string | null = null;
  let metrics = false;
  let json = false;
  for (const arg of rest) {
    if (arg === "--metrics") {
      metrics = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("-")) return { error: `status: unknown flag ${arg}` };
    if (name !== null) return { error: `status: unexpected extra argument ${arg}` };
    name = arg;
  }
  if (name === null) return { error: "status: <name> is required" };
  return { name, metrics, json };
}

async function runStatus(rest: string[], deps: WorkloadStatusDeps): Promise<number> {
  const parsed = parseStatusArgs(rest);
  if ("error" in parsed) {
    process.stderr.write(`workload ${parsed.error}\n${USAGE}`);
    return 1;
  }
  const { name, metrics, json } = parsed;
  if (!metrics) {
    process.stderr.write(
      "workload status currently supports only --metrics; use `llamactl describe workload <name>` for live status\n",
    );
    return 1;
  }

  const snapshots = await gatherSnapshots(resolveWorkloadStatusDeps(deps));
  if (snapshots.length === 0) {
    process.stderr.write(`workload status: ${NO_SNAPSHOT_REASON}\n`);
    if (json) writeUnavailableJson(name, NO_SNAPSHOT_REASON);
    return 1;
  }

  const match = findThroughputMatch(snapshots, name);
  if (match === null) {
    const reason = `no engine throughput data for workload ${name} (the fleet supervisor is not recording engine throughput, or the workload is not a ModelHost on an engine exposing /metrics)`;
    process.stderr.write(`workload status: ${reason}\n`);
    if (json) writeUnavailableJson(name, reason);
    return 1;
  }

  if (json) writeAvailableJson(match);
  else writeHuman(match);
  return 0;
}

export async function runWorkload(args: string[], deps: WorkloadStatusDeps = {}): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined) {
    process.stderr.write(USAGE);
    return 1;
  }
  if (sub === "--help" || sub === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (sub === "top") {
    return await runTop(rest, deps);
  }
  if (sub !== "status") {
    process.stderr.write(`Unknown workload subcommand: ${sub}\n${USAGE}`);
    return 1;
  }
  return await runStatus(rest, deps);
}
