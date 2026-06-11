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

async function runSupervisorStatus(flags: Flags, journalPath: string): Promise<number> {
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

async function runSupervisorAudit(flags: Flags): Promise<number> {
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

function buildSupervisorLoopOptions(
  flags: Flags,
  journalPath: string,
  once: boolean,
): SupervisorLoopOptions {
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

  return {
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
}

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
    return await runSupervisorStatus(flags, journalPath);
  }

  if (sub === "audit") {
    return await runSupervisorAudit(flags);
  }

  const once = sub === "tick" || flags.once;
  const loopOpts = buildSupervisorLoopOptions(flags, journalPath, once);

  if (!flags.quiet) {
    const wlSummary =
      flags.workloads.length === 0
        ? "(mem-only)"
        : flags.workloads.map((w) => `${w.name}@${redactEndpoint(w.endpoint)}`).join(", ");
    process.stderr.write(
      `supervisor: node=${flags.node} interval=${String(flags.intervalMs)}ms once=${String(once)} workloads=${wlSummary}\n`,
    );
    process.stderr.write(`supervisor: journal=${journalPath}\n`);
    if (loopOpts.onTick !== undefined) {
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

interface AuditFlags {
  json: boolean;
  limit?: number;
  auditPath?: string;
  tool?: string;
  outcome?: "denied" | "success" | "error";
  since?: string;
}

function parseAuditFlags(raw: string, current: AuditFlags): void {
  if (raw.startsWith("--limit=")) {
    current.limit = num(raw, "--limit=", 0) || undefined;
    return;
  }
  if (raw.startsWith("--audit-path=")) {
    current.auditPath = raw.slice("--audit-path=".length);
    return;
  }
  if (raw.startsWith("--audit=")) {
    if (!warnedDeprecatedAuditFlagNames.has("--audit")) {
      console.error("supervisor audit: --audit is deprecated; use --audit-path");
      warnedDeprecatedAuditFlagNames.add("--audit");
    }
    current.auditPath = raw.slice("--audit=".length);
    return;
  }
  if (raw.startsWith("--tool=")) {
    current.tool = raw.slice("--tool=".length);
    return;
  }
  if (raw.startsWith("--outcome=")) {
    const v = raw.slice("--outcome=".length);
    if (v === "denied" || v === "success" || v === "error") current.outcome = v;
    return;
  }
  if (raw.startsWith("--since=")) {
    current.since = raw.slice("--since=".length);
    return;
  }
}

function parsePressureFlags(
  raw: string,
  current: {
    intervalMs: number;
    journal?: string;
    node: string;
    headroomMb: number;
    compressorMb: number;
    consecutiveTicks: number;
    clearTicks?: number;
    p95DegradedMs: number;
    consecutiveErrors: number;
  },
): void {
  if (raw.startsWith("--interval=")) {
    current.intervalMs = num(raw, "--interval=", 30) * 1000;
    return;
  }
  if (raw.startsWith("--journal=")) {
    current.journal = raw.slice("--journal=".length);
    return;
  }
  if (raw.startsWith("--node=")) {
    current.node = raw.slice("--node=".length);
    return;
  }
  if (raw.startsWith("--headroom-mb=")) {
    current.headroomMb = num(raw, "--headroom-mb=", 512);
    return;
  }
  if (raw.startsWith("--compressor-mb=")) {
    current.compressorMb = num(raw, "--compressor-mb=", 2048);
    return;
  }
  if (raw.startsWith("--consecutive-ticks=")) {
    current.consecutiveTicks = num(raw, "--consecutive-ticks=", 3);
    return;
  }
  if (raw.startsWith("--clear-ticks=")) {
    const v = Number(raw.slice("--clear-ticks=".length));
    if (!Number.isFinite(v) || v < 0)
      throw new Error("supervisor: clear-ticks must be finite non-negative");
    current.clearTicks = v;
    return;
  }
  if (raw.startsWith("--p95-degraded-ms=")) {
    current.p95DegradedMs = num(raw, "--p95-degraded-ms=", 5000);
    return;
  }
  if (raw.startsWith("--consecutive-errors=")) {
    current.consecutiveErrors = num(raw, "--consecutive-errors=", 3);
    return;
  }
}

function parseFlags(argv: string[]): Flags {
  let once = false;
  let kind: "ModelHost" | "ModelRun" = "ModelHost";
  const workloads: WorkloadTarget[] = [];
  let noWorkloads = false;
  let quiet = false;
  let auto = false;
  let severityThreshold: 1 | 2 | 3 = 2;
  let executeId: string | undefined;

  const audit: AuditFlags = { json: false };
  const pressure = {
    intervalMs: 30_000,
    journal: undefined as string | undefined,
    node: "local",
    headroomMb: 512,
    compressorMb: 2048,
    consecutiveTicks: 3,
    clearTicks: undefined as number | undefined,
    p95DegradedMs: 5000,
    consecutiveErrors: 3,
  };

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
      audit.json = true;
      continue;
    }
    if (
      raw.startsWith("--limit=") ||
      raw.startsWith("--audit-path=") ||
      raw.startsWith("--audit=") ||
      raw.startsWith("--tool=") ||
      raw.startsWith("--outcome=") ||
      raw.startsWith("--since=")
    ) {
      parseAuditFlags(raw, audit);
      continue;
    }
    if (
      raw.startsWith("--interval=") ||
      raw.startsWith("--journal=") ||
      raw.startsWith("--node=") ||
      raw.startsWith("--headroom-mb=") ||
      raw.startsWith("--compressor-mb=") ||
      raw.startsWith("--consecutive-ticks=") ||
      raw.startsWith("--clear-ticks=") ||
      raw.startsWith("--p95-degraded-ms=") ||
      raw.startsWith("--consecutive-errors=")
    ) {
      parsePressureFlags(raw, pressure);
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
    intervalMs: pressure.intervalMs,
    once,
    journal: pressure.journal,
    node: pressure.node,
    headroomMb: pressure.headroomMb,
    compressorMb: pressure.compressorMb,
    consecutiveTicks: pressure.consecutiveTicks,
    clearTicks: pressure.clearTicks,
    p95DegradedMs: pressure.p95DegradedMs,
    consecutiveErrors: pressure.consecutiveErrors,
    workloads: noWorkloads ? [] : workloads,
    noWorkloadsConflict: noWorkloads && workloads.length > 0,
    quiet,
    auto,
    severityThreshold,

    executeId,
    json: audit.json,
    limit: audit.limit,
    auditPath: audit.auditPath,
    tool: audit.tool,
    outcome: audit.outcome,
    since: audit.since,
  };
}
