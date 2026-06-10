import { env as envMod } from "@llamactl/core";
import { listPeers, workloadStore } from "@llamactl/remote";

import {
  appendFleetJournal,
  createMigrationController,
  createPeerFetch,
  DEFAULT_PRESSURE_THRESHOLDS,
  defaultFleetJournalPath,
  type FleetJournalEntry,
  readAuditEntries,
  readRecentMovesFromJournal,
  readSupervisorStatus,
  redactEndpoint,
  runExecutor,
  startSupervisorLoop,
  type SupervisorLoopOptions,
  type WorkloadTarget,
} from "../../../fleet-supervisor/src/index.js";
import { readSchedulerLease } from "../../../remote/src/config/peers.js";
import { getGlobals } from "../dispatcher.js";
import { isRecord } from "../runtime-shape.js";
import { setWorkloadEnabled } from "./setEnabled.js";

const USAGE = `llamactl supervisor — fleet observability + severity-gated remediation

USAGE:

  llamactl supervisor serve [flags]
  llamactl supervisor tick  [flags]    (alias for --once)
  llamactl supervisor status [flags]   (show current pressure state)
  llamactl supervisor audit [flags]    (show recent MCP write-tool audit entries)

FLAGS:
  --interval=<s>              Seconds between ticks. Default 30.
  --once                      One tick then exit.
  --journal=<path>            Override journal path.
                              Default $DEV_STORAGE/fleet-supervisor/journal.jsonl
                              (falls back to ~/.llamactl/fleet-supervisor/journal.jsonl
                              when DEV_STORAGE is unset).
  --node=<name>               Node label. Consumed as a llamactl-global flag
                              (see 'llamactl --help'); supervisor reads it from
                              the dispatcher. Default 'local'.
  --headroom-mb=<n>           Pressure free_mb threshold. Default 512.
  --compressor-mb=<n>         Pressure compressor_mb threshold. Default 2048.
  --consecutive-ticks=<n>     Pressure consecutive-tick window. Default 3.
  --clear-ticks=<n>           Pressure clear-tick hysteresis window. Default 5.
  --p95-degraded-ms=<n>       Per-workload p95 degradation threshold. Default 5000.
  --consecutive-errors=<n>    Per-workload consecutive-errors threshold. Default 3.
  --no-workloads              Skip workload probing (mem-only mode).
  --workload=<name@url>       Add a workload target (repeatable).
                              Format: name@url, e.g. mlx-qwen36-35b@http://127.0.0.1:8096
  --kind=ModelHost|ModelRun   Kind for subsequent --workload entries. Default ModelHost.
  --quiet                     Suppress per-tick stderr summary.

STATUS FLAGS:
  --json                      Emit JSON instead of human format.
  --limit=<n>                 How many recent pressure-status entries to show. Default 20.


AUDIT FLAGS:
  --audit-path=<path>          Override audit path. Default $HOME/.llamactl/fleet-supervisor/audit.jsonl.
  --tool=<name>           Filter to one tool (exact match).
  --outcome=<denied|success|error>
                          Filter by outcome.
  --since=<iso-ts>        Entries with ts >= this value.
  --limit=<n>             Default 50, cap 500.
  --json                  Emit JSON instead of human format.

EXECUTOR FLAGS (opt-in — no actions taken without these):
  --auto                      Enable the proposal executor after each tick.
  --severity-threshold=<1|2|3>
                              Execute proposals at or below this tier. Default 2.
                              Tier 2 = mark-degraded (auto-safe).
                              Tier 3 = evict / restart (destructive).
  --execute=<proposalId>      Execute one specific proposal by ID regardless of
                              --auto or tier (manual one-shot override).

EXAMPLES:
  llamactl supervisor serve --once
  llamactl supervisor tick --auto --severity-threshold=2
  llamactl supervisor status
  llamactl supervisor status --json --limit=5
`;

export async function runSupervisor(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return sub ? 0 : 1;
  }
  if (sub !== "serve" && sub !== "tick" && sub !== "status" && sub !== "audit") {
    console.error(`Unknown supervisor subcommand: ${sub}`);
    console.error(USAGE);
    return 1;
  }
  let flags: Flags;
  try {
    flags = parseFlags(rest);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }

  if (sub === "serve" || sub === "tick") {
    // TODO: Re-resolve on each tick once we have low-overhead cache + invalidation.
    flags.workloads = resolveWorkloadTargetsAtStartup(flags.workloads, process.env);
  }

  const globalNode = getGlobals().nodeName;
  if (globalNode) flags.node = globalNode;
  const journalPath = flags.journal ?? defaultFleetJournalPath();

  if (sub === "status") {
    const report = await readSupervisorStatus({
      journalPath,
      node: flags.node,
      limit: flags.limit,
    });

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
      return 0;
    }

    if (report.nodes.length === 0) {
      process.stdout.write(`No entries found in journal: ${journalPath}\n`);
      return 0;
    }

    for (const node of report.nodes) {
      if (node.state === "NORMAL") {
        process.stdout.write(`node ${node.name}: NORMAL (no recent pressure event)\n`);
        process.stdout.write("\n");
      } else {
        const mins = Math.floor(node.durationMs / 60000);
        process.stdout.write(
          `node ${node.name}: HIGH for ${String(mins)}m (since ${String(node.enteredAt)})\n`,
        );
        process.stdout.write(
          `  clear progress: ${String(node.consecutiveClearTicks)}/${String(node.clearTicksNeeded)}\n`,
        );
        process.stdout.write(
          `  free_mb=${String(node.free_mb)} (breach: ${node.headroomBreach ? "yes" : "no"}) compressor_mb=${String(node.compressor_mb)} (breach: ${node.compressorBreach ? "yes" : "no"})\n`,
        );
        process.stdout.write(`  last ${String(node.recent.length)} pressure-status:\n`);
        for (const recent of node.recent) {
          const t = new Date(recent.ts).toLocaleTimeString("en-US", { hour12: false });
          const hits = [];
          if (recent.headroomBreach) hits.push("headroom");
          if (recent.compressorBreach) hits.push("compressor");
          const hitsStr = hits.length > 0 ? hits.join(",") : "(none)";
          process.stdout.write(
            `    ${t}  free=${String(recent.free_mb)}  comp=${String(recent.compressor_mb)}  clear=${String(recent.consecutiveClearTicks)}/${String(recent.clearTicksNeeded)}  hits=${hitsStr}\n`,
          );
        }
        process.stdout.write("\n");
      }
    }
    return 0;
  }

  if (sub === "audit") {
    const res = await readAuditEntries({
      auditPath: flags.auditPath,
      tool: flags.tool,
      outcome: flags.outcome,
      since: flags.since,
      limit: flags.limit ?? 50,
    });

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return 0;
    }

    if (res.malformedLines > 0) {
      process.stdout.write(`audit: ${String(res.malformedLines)} malformed lines skipped\n`);
    }
    process.stdout.write(
      `audit: ${res.auditPath}  total=${String(res.total)} entries=${String(res.entries.length)}\n\n`,
    );

    const summarize = (obj: unknown): string => {
      if (!isRecord(obj) || Object.keys(obj).length === 0) return "{}";

      let out = "";
      if ("proposalId" in obj) out += `proposalId:"${String(obj.proposalId)}" `;
      if ("name" in obj) out += `name:"${String(obj.name)}" `;
      if ("error" in obj && typeof obj.error === "string")
        out += `error:"${obj.error.slice(0, 40)}" `;
      if ("auto" in obj) out += `auto:${String(obj.auto)} `;
      if ("memMb" in obj) out += `memMb=${String(obj.memMb)} `;
      if ("action" in obj && typeof obj.action === "string") out += `action:"${obj.action}" `;

      out = out.trim();
      if (!out) {
        const str = JSON.stringify(obj);
        return str.length > 80 ? str.slice(0, 80) + "..." : str;
      }
      return "{" + out + "}";
    };

    for (const e of res.entries) {
      const inStr = summarize(e.input);
      let detStr = "";
      // Entries come from unvalidated JSONL — a legacy/foreign line may
      // carry a missing/null/primitive detail, so guard before reading.
      if (isRecord(e.detail) && typeof e.detail.error === "string" && e.detail.error) {
        detStr = e.detail.error;
      } else {
        detStr = summarize(e.detail);
      }

      process.stdout.write(
        `${e.ts}  ${e.outcome.padEnd(7)}  ${e.tool.padEnd(30)}  input=${inStr}  detail=${detStr}\n`,
      );
    }
    return 0;
  }

  const once = sub === "tick" || flags.once;
  const writeJournal = (entry: FleetJournalEntry): void => {
    appendFleetJournal(entry, journalPath);
  };

  const migrationEnabled = process.env.LLAMACTL_FLEET_MOVE_ENABLED === "1";
  const migrationController = migrationEnabled
    ? createMigrationController({
        peers: listPeers({ currentNodeName: flags.node }).map((peer) => peer.id),
        fetchSnapshot: async (node) => {
          const peer = listPeers({ currentNodeName: flags.node }).find(
            (candidate) => candidate.id === node,
          );
          if (!peer) {
            throw new Error(`unknown peer: ${node}`);
          }
          const fetchSnapshot = createPeerFetch(peer);
          const snapshot = await fetchSnapshot();
          if (!snapshot) {
            throw new Error(`peer ${node} returned no snapshot`);
          }
          return {
            node: snapshot.node,
            schedulerLeaseHolder: readSchedulerLease(journalPath)?.holder ?? flags.node,
            pressureState: "NORMAL",
            nodeMem: { freeMb: snapshot.node_mem.free_mb },
            workloads: snapshot.workloads.map((workload) => ({
              name: workload.name,
              reachable: workload.reachable,
            })),
          };
        },
        readRecentMoves: () => readRecentMovesFromJournal(journalPath),
        leaseholder: readSchedulerLease(journalPath)?.holder ?? flags.node,
        getNowMs: () => Date.now(),
      })
    : null;

  const executorEnabled = flags.auto || flags.executeId !== undefined;

  const loopOpts: SupervisorLoopOptions = {
    node: flags.node,
    workloads: flags.workloads,
    once,
    intervalMs: flags.intervalMs,
    writeJournal,
    pressureThresholds: {
      headroomMinMb: flags.headroomMb,
      compressorWarnMb: flags.compressorMb,
      consecutiveTicks: flags.consecutiveTicks,
      clearTicks: flags.clearTicks ?? DEFAULT_PRESSURE_THRESHOLDS.clearTicks,
    },
    degradationThresholds: {
      consecutiveErrorsForDegraded: flags.consecutiveErrors,
      p95DegradedMs: flags.p95DegradedMs,
    },
    migrationController,
    onTick: executorEnabled
      ? async (): Promise<void> => {
          const results = await runExecutor({
            node: flags.node,
            auto: flags.auto,
            severityThreshold: flags.severityThreshold,
            executeId: flags.executeId,
            journalPath,
            writeJournal,
            disable: async (name) => {
              const r = await setWorkloadEnabled(name, false);
              if (r.message && !flags.quiet)
                process.stderr.write(`supervisor: executor: ${r.message}`);
              return r.code;
            },
            enable: async (name) => {
              const r = await setWorkloadEnabled(name, true);
              if (r.message && !flags.quiet)
                process.stderr.write(`supervisor: executor: ${r.message}`);
              return r.code;
            },
          });
          if (!flags.quiet && results.length > 0) {
            for (const r of results) {
              process.stderr.write(
                // eslint-disable-next-line eqeqeq -- Preserve existing CLI/test semantics while clearing strict lint debt.
                `supervisor: executor: ${r.status} proposal=${r.proposalId} action=${r.action.type}${r.reason ? ` reason=${r.reason}` : ""}${r.exitCode != null ? ` exitCode=${String(r.exitCode)}` : ""}\n`,
              );
            }
          }
        }
      : undefined,
  };

  if (!flags.quiet) {
    const wlSummary =
      flags.workloads.length === 0
        ? "(mem-only)"
        : flags.workloads.map((w) => `${w.name}@${redactEndpoint(w.endpoint)}`).join(", ");
    process.stderr.write(
      `supervisor: node=${flags.node} interval=${String(flags.intervalMs)}ms once=${String(once)} workloads=${wlSummary}\n`,
    );
    process.stderr.write(`supervisor: journal=${journalPath}\n`);
    if (executorEnabled) {
      process.stderr.write(
        `supervisor: executor=on auto=${String(flags.auto)} threshold=${String(flags.severityThreshold)}${flags.executeId ? ` executeId=${flags.executeId}` : ""}\n`,
      );
    }
  }
  if (flags.noWorkloadsConflict) {
    process.stderr.write(
      "supervisor: warning — both --no-workloads and --workload= were passed; --no-workloads wins, workloads ignored.\n",
    );
  }

  const handle = startSupervisorLoop(loopOpts);
  if (!once) {
    process.on("SIGINT", () => {
      handle.stop();
    });
    process.on("SIGTERM", () => {
      handle.stop();
    });
  }
  await handle.done;
  return 0;
}

interface Flags {
  intervalMs: number;
  once: boolean;
  journal?: string;
  node: string;
  headroomMb: number;
  compressorMb: number;
  consecutiveTicks: number;
  clearTicks?: number;
  p95DegradedMs: number;
  consecutiveErrors: number;
  workloads: WorkloadTarget[];
  noWorkloadsConflict: boolean;
  quiet: boolean;
  auto: boolean;
  severityThreshold: 1 | 2 | 3;
  executeId?: string;

  json: boolean;
  limit?: number;
  auditPath?: string;
  tool?: string;
  outcome?: "denied" | "success" | "error";
  since?: string;
}

interface ResolveWorkloadUrlDeps {
  loadWorkloadByName?: typeof workloadStore.loadWorkloadByName;
  loadWorkloadByNameAny?: (name: string) => { spec: { useProxy?: boolean } };
  resolveInternalProxyEndpoint?: typeof envMod.resolveInternalProxyEndpoint;
  warn?: (message: string) => void;
}

interface ResolveWorkloadTargetsAtStartupDeps extends ResolveWorkloadUrlDeps {
  info?: (message: string) => void;
}

export function resolveWorkloadUrl(
  name: string,
  fallbackUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: ResolveWorkloadUrlDeps = {},
): string {
  const loadWorkloadByNameAny =
    deps.loadWorkloadByNameAny ??
    ((workloadName: string): { spec: { useProxy?: boolean } } =>
      (deps.loadWorkloadByName
        ? deps.loadWorkloadByName(workloadName)
        : workloadStore.loadWorkloadByName(workloadName)) as { spec: { useProxy?: boolean } });
  const resolveInternalProxyEndpoint =
    deps.resolveInternalProxyEndpoint ?? envMod.resolveInternalProxyEndpoint;
  const warn = deps.warn ?? ((message: string): boolean => process.stderr.write(`${message}\n`));

  try {
    const manifest = loadWorkloadByNameAny(name);
    if (manifest.spec.useProxy === true) {
      return resolveInternalProxyEndpoint(env);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(
      `[supervisor] workload=${name} failed to read deployed spec (${message}); using configured URL ${fallbackUrl}`,
    );
  }

  return fallbackUrl;
}

export function resolveWorkloadTargetsAtStartup(
  workloads: WorkloadTarget[],
  env: NodeJS.ProcessEnv = process.env,
  deps: ResolveWorkloadTargetsAtStartupDeps = {},
): WorkloadTarget[] {
  const info = deps.info ?? ((message: string): boolean => process.stderr.write(`${message}\n`));
  const loggedOverrides = new Map<string, string>();

  return workloads.map((target) => {
    const resolvedEndpoint = resolveWorkloadUrl(target.name, target.endpoint, env, deps);
    if (resolvedEndpoint === target.endpoint) return target;

    const signature = `${target.endpoint}->${resolvedEndpoint}`;
    const prev = loggedOverrides.get(target.name);
    if (prev !== signature) {
      info(
        `[supervisor] workload=${target.name} routing via proxy ${resolvedEndpoint} (was ${target.endpoint})`,
      );
      loggedOverrides.set(target.name, signature);
    }
    return { ...target, endpoint: resolvedEndpoint };
  });
}

const warnedDeprecatedAuditFlagNames = new Set<string>();

function num(raw: string, prefix: string, fallback: number): number {
  const v = Number(raw.slice(prefix.length));
  if (!Number.isFinite(v) || v < 0) {
    throw new Error(
      `supervisor: ${prefix.replace(/=$/, "")} must be finite non-negative (got ${raw.slice(prefix.length)})`,
    );
  }
  return v || fallback;
}

function parseFlags(argv: string[]): Flags {
  let intervalMs = 30_000;
  let once = false;
  let journal: string | undefined;
  let node = "local";
  let headroomMb = 512;
  let compressorMb = 2048;
  let consecutiveTicks = 3;
  let clearTicks: number | undefined;
  let p95DegradedMs = 5000;
  let consecutiveErrors = 3;
  let kind: "ModelHost" | "ModelRun" = "ModelHost";
  const workloads: WorkloadTarget[] = [];
  let noWorkloads = false;
  let quiet = false;
  let auto = false;
  let severityThreshold: 1 | 2 | 3 = 2;
  let executeId: string | undefined;

  let json = false;
  let limit: number | undefined;
  let auditPath: string | undefined;
  let tool: string | undefined;
  let outcome: "denied" | "success" | "error" | undefined;
  let since: string | undefined;

  for (const raw of argv) {
    if (raw === "--once") {
      once = true;
      continue;
    }
    if (raw === "--no-workloads") {
      noWorkloads = true;
      continue;
    }
    if (raw === "--quiet") {
      quiet = true;
      continue;
    }
    if (raw === "--auto") {
      auto = true;
      continue;
    }
    if (raw === "--json") {
      json = true;
      continue;
    }
    if (raw.startsWith("--limit=")) {
      limit = num(raw, "--limit=", 0) || undefined;
      continue;
    }
    if (raw.startsWith("--audit-path=")) {
      auditPath = raw.slice("--audit-path=".length);
      continue;
    }
    if (raw.startsWith("--audit=")) {
      if (!warnedDeprecatedAuditFlagNames.has("--audit")) {
        console.error("supervisor audit: --audit is deprecated; use --audit-path");
        warnedDeprecatedAuditFlagNames.add("--audit");
      }
      auditPath = raw.slice("--audit=".length);
      continue;
    }
    if (raw.startsWith("--tool=")) {
      tool = raw.slice("--tool=".length);
      continue;
    }
    if (raw.startsWith("--outcome=")) {
      const v = raw.slice("--outcome=".length);
      if (v === "denied" || v === "success" || v === "error") outcome = v;
      continue;
    }
    if (raw.startsWith("--since=")) {
      since = raw.slice("--since=".length);
      continue;
    }
    if (raw.startsWith("--interval=")) {
      intervalMs = num(raw, "--interval=", 30) * 1000;
      continue;
    }
    if (raw.startsWith("--journal=")) {
      journal = raw.slice("--journal=".length);
      continue;
    }
    if (raw.startsWith("--node=")) {
      node = raw.slice("--node=".length);
      continue;
    }
    if (raw.startsWith("--headroom-mb=")) {
      headroomMb = num(raw, "--headroom-mb=", 512);
      continue;
    }
    if (raw.startsWith("--compressor-mb=")) {
      compressorMb = num(raw, "--compressor-mb=", 2048);
      continue;
    }
    if (raw.startsWith("--consecutive-ticks=")) {
      consecutiveTicks = num(raw, "--consecutive-ticks=", 3);
      continue;
    }
    if (raw.startsWith("--clear-ticks=")) {
      const v = Number(raw.slice("--clear-ticks=".length));
      if (!Number.isFinite(v) || v < 0)
        throw new Error("supervisor: clear-ticks must be finite non-negative");
      clearTicks = v;
      continue;
    }
    if (raw.startsWith("--p95-degraded-ms=")) {
      p95DegradedMs = num(raw, "--p95-degraded-ms=", 5000);
      continue;
    }
    if (raw.startsWith("--consecutive-errors=")) {
      consecutiveErrors = num(raw, "--consecutive-errors=", 3);
      continue;
    }
    if (raw.startsWith("--severity-threshold=")) {
      const v = Number(raw.slice("--severity-threshold=".length));
      if (v === 1 || v === 2 || v === 3) severityThreshold = v;
      continue;
    }
    if (raw.startsWith("--execute=")) {
      executeId = raw.slice("--execute=".length);
      continue;
    }
    if (raw.startsWith("--kind=")) {
      const v = raw.slice("--kind=".length);
      if (v === "ModelHost" || v === "ModelRun") kind = v;
      continue;
    }
    if (raw.startsWith("--workload=")) {
      const v = raw.slice("--workload=".length);
      const [name, endpoint] = v.split("@", 2);
      if (name && endpoint) workloads.push({ name, endpoint, kind });
      continue;
    }
  }

  return {
    intervalMs,
    once,
    journal,
    node,
    headroomMb,
    compressorMb,
    consecutiveTicks,
    clearTicks,
    p95DegradedMs,
    consecutiveErrors,
    workloads: noWorkloads ? [] : workloads,
    noWorkloadsConflict: noWorkloads && workloads.length > 0,
    quiet,
    auto,
    severityThreshold,

    executeId,
    json,
    limit,
    auditPath,
    tool,
    outcome,
    since,
  };
}
