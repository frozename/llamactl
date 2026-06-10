import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  appendFleetJournal,
  defaultFleetJournalPath,
  type FleetExecutionEntry,
  type FleetJournalEntry,
  type FleetProposalEntry,
  type FleetSnapshotEntry,
  readAuditEntries,
  readSupervisorStatus,
} from "@llamactl/fleet-supervisor";
import { toTextContent } from "@nova/mcp-shared";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { FleetAggregator } from "../../../fleet-supervisor/src/aggregator.js";
import { defaultFleetAuditPath } from "../../../fleet-supervisor/src/journal.js";
import { createPeerFetch } from "../../../fleet-supervisor/src/peer-fetch.js";
import { listPeers } from "../../../remote/src/config/peers.js";

const CLI_BIN_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../cli/src/bin.ts");
let cliBinChecked = false;
function ensureCliBin(): void {
  if (cliBinChecked) return;
  if (!existsSync(CLI_BIN_PATH)) {
    throw new Error(`llamactl CLI not found at ${CLI_BIN_PATH}`);
  }
  cliBinChecked = true;
}

const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_TIMEOUT_MS_ADMIT = 300_000;
const MAX_TIMEOUT_MS_EXECUTE = 120_000;
const MAX_TIMEOUT_FOLLOWUP_MS = 5_000;
const KILL_TIMEOUT_MS = 2_000;
const OUTPUT_TRUNCATION_SENTINEL = "[output truncated]";
const deprecatedToolWarnings = new Set<string>();

function readProcessOutput(chunks: Buffer[]): string {
  const merged = Buffer.concat(chunks);
  if (merged.length <= MAX_OUTPUT_BYTES) return merged.toString();

  const suffix = Buffer.from(`\\n${OUTPUT_TRUNCATION_SENTINEL}`);
  const trimTo = Math.max(0, MAX_OUTPUT_BYTES - suffix.length);
  return Buffer.concat([merged.subarray(0, trimTo), suffix]).toString();
}

function warnDeprecatedToolAlias(oldName: string, newName: string): void {
  if (deprecatedToolWarnings.has(oldName)) return;
  deprecatedToolWarnings.add(oldName);
  console.error(`[llamactl-mcp] deprecated: ${oldName} -> ${newName}; will be removed`);
}

function appendAudit(
  tool: string,
  input: Record<string, unknown>,
  outcome: "success" | "error" | "denied",
  detail: unknown = {},
): void {
  try {
    appendFleetJournal(
      {
        kind: "mcp-audit",
        ts: new Date().toISOString(),
        tool,
        input,
        outcome,
        detail,
      } as unknown as FleetJournalEntry,
      defaultFleetAuditPath(),
    );
  } catch {
    // Best-effort audit write.
  }
}

interface RunProcessResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: number;
  timedOut: boolean;
}

function toTimeoutMs(value: number | undefined, maxMs: number): number {
  if (typeof value !== "number" || value <= 0) return maxMs;
  return Math.min(value, maxMs);
}

function makeResultError(
  message: string,
  result: RunProcessResult,
): { ok: false; error: string; code?: number; timedOut: boolean; stdout: string; stderr: string } {
  return {
    ok: false,
    error: message,
    code: result.code,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function getRunProcessFailureMessage(result: RunProcessResult): string {
  if (result.timedOut) return "command timed out";
  if (result.stderr) return result.stderr.trim();
  if (result.stdout) return result.stdout.trim();
  return `command failed with code ${String(result.code ?? -1)}`;
}

function runProcess(
  spawnFn: SpawnFn,
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<RunProcessResult> {
  return new Promise((resolve) => {
    const proc = spawnFn(cmd, args, { cwd: process.cwd() });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let killTimeout: ReturnType<typeof setTimeout> | undefined;

    const resolveResult = (value: RunProcessResult): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      resolveResult({
        ok: false,
        code: -1,
        stdout: readProcessOutput(stdoutChunks),
        stderr: readProcessOutput(stderrChunks),
        timedOut: true,
      });
      proc.kill();
      killTimeout = setTimeout(() => {
        proc.kill("SIGKILL");
      }, KILL_TIMEOUT_MS);
    }, timeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    proc.on("close", (code) => {
      if (settled) {
        if (killTimeout) clearTimeout(killTimeout);
        return;
      }
      clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      resolveResult({
        ok: code === 0,
        code: code ?? -1,
        stdout: readProcessOutput(stdoutChunks),
        stderr: readProcessOutput(stderrChunks),
        timedOut,
      });
    });

    proc.on("error", (err: Error) => {
      if (settled) return;
      clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      resolveResult({
        ok: false,
        code: -1,
        stdout: readProcessOutput(stdoutChunks),
        stderr: `${readProcessOutput(stderrChunks)}${readProcessOutput(stderrChunks) ? "\\n" : ""}${err.message}`,
        timedOut: false,
      });
    });
  });
}

type SpawnFn = typeof spawn;

type DetectExistingSupervisor = () => Promise<{ running: boolean; pid?: number }>;

interface FleetToolDeps {
  spawn?: SpawnFn;
  detectExistingSupervisor?: DetectExistingSupervisor;
}

async function detectExistingSupervisorDefault(
  spawnFn: SpawnFn,
): Promise<{ running: boolean; pid?: number }> {
  const result = await runProcess(
    spawnFn,
    "pgrep",
    ["-f", "supervisor serve"],
    MAX_TIMEOUT_FOLLOWUP_MS,
  );
  if (!result.ok) return { running: false };
  const first = result.stdout.trim().split("\n")[0];
  if (!first) return { running: false };
  const pid = Number.parseInt(first, 10);
  if (Number.isNaN(pid)) return { running: false };
  return { running: true, pid };
}

const admitMeasureInFlight = new Set<string>();

function snapshotInput(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object") return {};
  return input as Record<string, unknown>;
}

const pressureStatusInputSchema = {
  journalPath: z.string().optional(),
  node: z.string().optional(),
  limit: z.number().optional(),
};

async function handleFleetPressureStatus({
  journalPath,
  node,
  limit,
}: {
  journalPath?: string;
  node?: string;
  limit?: number;
}): Promise<{ content: { type: "text"; text: string }[] }> {
  const path = journalPath ?? defaultFleetJournalPath();
  const report = await readSupervisorStatus({ journalPath: path, node, limit });
  return toTextContent(report);
}

const auditInputSchema = {
  auditPath: z.string().optional(),
  tool: z.string().optional(),
  outcome: z.enum(["denied", "success", "error"]).optional(),
  since: z.string().optional(),
  limit: z.number().optional(),
};

async function handleFleetAudit({
  auditPath,
  tool,
  outcome,
  since,
  limit,
}: {
  auditPath?: string;
  tool?: string;
  outcome?: "denied" | "success" | "error";
  since?: string;
  limit?: number;
}): Promise<{ content: { type: "text"; text: string }[] }> {
  const result = await readAuditEntries({ auditPath, tool, outcome, since, limit });
  return toTextContent(result);
}

function handleFleetPressure({ node, journalPath }: { node?: string; journalPath?: string }): {
  content: { type: "text"; text: string }[];
} {
  const path = journalPath ?? defaultFleetJournalPath();
  const entries = readJournal(path);

  const knownNodes = new Set<string>();
  const latestTransition = new Map<string, { state: string; ts: string }>();

  for (const e of entries) {
    if (node !== undefined && e.node !== node) continue;
    if (e.kind === "fleet-snapshot") {
      knownNodes.add(e.node);
    } else if (
      e.kind === "fleet-transition" &&
      e.subjectKind === "node" &&
      (e.signal === "pressure" || e.signal === "pressure-cleared")
    ) {
      const cur = latestTransition.get(e.node);
      if (!cur || e.ts > cur.ts) {
        latestTransition.set(e.node, { state: e.to, ts: e.ts });
      }
    }
  }
  for (const node of latestTransition.keys()) knownNodes.add(node);

  const nodes = [...knownNodes].map((nodeName) => {
    const t = latestTransition.get(nodeName);
    return {
      name: nodeName,
      state: t?.state === "HIGH" ? "HIGH" : "NORMAL",
      lastTransitionAt: t?.ts ?? null,
    };
  });

  return toTextContent({ nodes });
}

async function handleAdmitMeasure(
  spawnFn: SpawnFn,
  input: { workload: string; node?: string; timeoutMs?: number },
): Promise<{ content: { type: "text"; text: string }[] }> {
  const { workload, node, timeoutMs } = input;
  const snapshot = snapshotInput({ workload, node });
  const key = `${workload}:${node ?? ""}`;
  if (admitMeasureInFlight.has(key)) {
    const outcome = {
      ok: false,
      error: "admit measure already running for this workload",
      preview: snapshot,
    };
    appendAudit("llamactl_admit_measure", snapshot, "denied", outcome);
    return toTextContent(outcome);
  }
  admitMeasureInFlight.add(key);
  const boundedTimeoutMs = toTimeoutMs(timeoutMs, MAX_TIMEOUT_MS_ADMIT);
  try {
    ensureCliBin();
    const args = [CLI_BIN_PATH, "admit", "measure", workload];
    if (node) args.push(`--node=${node}`);
    const result = await runProcess(spawnFn, "bun", args, boundedTimeoutMs);
    if (!result.ok) {
      const error = makeResultError(getRunProcessFailureMessage(result), result);
      const outcome = { ...error, preview: snapshot };
      appendAudit("llamactl_admit_measure", snapshot, "error", outcome);
      return toTextContent(error);
    }
    appendAudit("llamactl_admit_measure", snapshot, "success", result);
    return toTextContent(result);
  } finally {
    admitMeasureInFlight.delete(key);
  }
}

async function handleSupervisorExecute(
  spawnFn: SpawnFn,
  detectExistingSupervisor: DetectExistingSupervisor,
  input: {
    proposalId?: string;
    auto?: boolean;
    severityThreshold?: number;
    node?: string;
    confirm?: boolean;
    timeoutMs?: number;
  },
): Promise<{ content: { type: "text"; text: string }[] }> {
  const { proposalId, auto, severityThreshold, node, confirm, timeoutMs } = input;
  const hasProposalId = proposalId !== undefined;
  const hasAuto = auto === true;
  if (hasProposalId === hasAuto) {
    const outcome = {
      ok: false,
      error: "must specify exactly one of proposalId or auto",
      preview: snapshotInput({ proposalId, auto, severityThreshold, node }),
    };
    appendAudit(
      "llamactl_supervisor_execute",
      snapshotInput({ proposalId, auto, severityThreshold, node }),
      "denied",
      outcome,
    );
    return toTextContent(outcome);
  }
  if (confirm !== true) {
    const preview = snapshotInput({ proposalId, auto, severityThreshold, node });
    const outcome = {
      ok: false,
      error: "destructive operation requires confirm:true",
      preview,
    };
    appendAudit("llamactl_supervisor_execute", preview, "denied", outcome);
    return toTextContent(outcome);
  }

  const running = await detectExistingSupervisor();
  if (running.running) {
    const preview = snapshotInput({ proposalId, auto, severityThreshold, node });
    const outcome = {
      ok: false,
      error: "supervisor execute blocked by running supervisor",
      preview: { ...preview, runningPid: running.pid },
    };
    appendAudit("llamactl_supervisor_execute", preview, "denied", outcome);
    return toTextContent(outcome);
  }

  ensureCliBin();
  const args = [CLI_BIN_PATH, "supervisor", "tick"];
  if (node) args.push(`--node=${node}`);
  if (hasAuto) {
    args.push("--auto");
    if (severityThreshold !== undefined) {
      args.push("--severity-threshold=" + severityThreshold.toString());
    }
  } else {
    args.push("--execute=" + (proposalId ?? ""));
  }
  const boundedTimeoutMs = toTimeoutMs(timeoutMs, MAX_TIMEOUT_MS_EXECUTE);
  const result = await runProcess(spawnFn, "bun", args, boundedTimeoutMs);
  const preview = snapshotInput({ proposalId, auto, severityThreshold, node });
  if (!result.ok) {
    const outcome = makeResultError(getRunProcessFailureMessage(result), result);
    appendAudit("llamactl_supervisor_execute", preview, "error", outcome);
    return toTextContent({
      ...outcome,
      preview,
    });
  }

  appendAudit("llamactl_supervisor_execute", preview, "success", result);
  return toTextContent({ ...result, preview });
}

export function registerFleetTools(server: McpServer, deps?: FleetToolDeps): void {
  const spawnFn = deps?.spawn ?? spawn;
  const detectExistingSupervisor =
    deps?.detectExistingSupervisor ??
    ((): Promise<{ running: boolean; pid?: number }> => detectExistingSupervisorDefault(spawnFn));

  server.registerTool(
    "llamactl_fleet_snapshot",
    {
      title: "Fleet snapshot",
      description:
        "Return the latest fleet snapshot per node from the fleet-supervisor journal. When node is set, returns at most one snapshot for that node.",
      inputSchema: {
        node: z.string().optional(),
        all: z.boolean().optional(),
        journalPath: z.string().optional(),
      },
    },
    async ({ node, all, journalPath }) => {
      if (all) {
        const peers = listPeers();
        const aggregator = new FleetAggregator({
          peers,
          fetchSnapshot: (peer): Promise<FleetSnapshotEntry | null> => createPeerFetch(peer)(),
        });
        await aggregator.pollNow();
        return toTextContent({ snapshots: aggregator.getAll() });
      }
      const path = journalPath ?? defaultFleetJournalPath();
      const entries = readJournal(path);
      return toTextContent({ snapshots: collectLatestSnapshots(entries, node) });
    },
  );

  server.registerTool(
    "llamactl_fleet_pressure",
    {
      title: "Fleet pressure state",
      description:
        "Current pressure state (NORMAL | HIGH) per node, derived from fleet-transition entries where subjectKind=node and signal in (pressure, pressure-cleared). Nodes that never transitioned appear as NORMAL with lastTransitionAt: null.",
      inputSchema: {
        node: z.string().optional(),
        journalPath: z.string().optional(),
      },
    },
    (input) => handleFleetPressure(input),
  );

  server.registerTool(
    "llamactl_fleet_audit",
    {
      title: "Fleet supervisor audit",
      description:
        "Read recent MCP write-tool audit entries from the fleet-supervisor audit log. Supports filters by tool name, outcome, and timestamp.",
      inputSchema: auditInputSchema,
    },
    handleFleetAudit,
  );

  server.registerTool(
    "llamactl_fleet_supervisor_audit",
    {
      title: "Fleet supervisor audit (deprecated)",
      description:
        "[DEPRECATED — use llamactl_fleet_audit] Backward-compatible alias for llamactl_fleet_audit.",
      inputSchema: auditInputSchema,
    },
    (input) => {
      warnDeprecatedToolAlias("llamactl_fleet_supervisor_audit", "llamactl_fleet_audit");
      return handleFleetAudit(input);
    },
  );

  server.registerTool(
    "llamactl_fleet_pressure_status",
    {
      title: "Fleet supervisor status",
      description:
        "Current pressure status per node derived from the fleet-supervisor journal: state, time-in-state, clear-tick progress, latest breach flags, and recent fleet-pressure-status entries. Complementary to llamactl_fleet_pressure (transition-derived current state). This tool returns richer periodic fields: time-in-state, clear-tick progress, latest breach flags, and recent fleet-pressure-status journal entries.",
      inputSchema: pressureStatusInputSchema,
    },
    handleFleetPressureStatus,
  );

  server.registerTool(
    "llamactl_fleet_supervisor_status",
    {
      title: "Fleet supervisor status (deprecated)",
      description:
        "[DEPRECATED — use llamactl_fleet_pressure_status] Backward-compatible alias for llamactl_fleet_pressure_status.",
      inputSchema: pressureStatusInputSchema,
    },
    (input) => {
      warnDeprecatedToolAlias("llamactl_fleet_supervisor_status", "llamactl_fleet_pressure_status");
      return handleFleetPressureStatus(input);
    },
  );

  server.registerTool(
    "llamactl_fleet_proposals",
    {
      title: "Fleet proposals",
      description:
        "List fleet proposals from the journal. pendingOnly=true (default) returns only proposals with no matching fleet-execution entry. Ordered most-recent-first; limit applied after filtering.",
      inputSchema: {
        node: z.string().optional(),
        pendingOnly: z.boolean().optional(),
        sinceIsoTs: z.string().optional(),
        limit: z.number().optional(),
        journalPath: z.string().optional(),
      },
    },
    ({ node, pendingOnly = true, limit = 50, sinceIsoTs, journalPath }) => {
      const path = journalPath ?? defaultFleetJournalPath();
      const entries = readJournal(path);
      const proposals = collectProposals(entries, { node, pendingOnly, sinceIsoTs });
      const total = proposals.length;
      return toTextContent({ proposals: proposals.slice(0, limit), total });
    },
  );

  server.registerTool(
    "llamactl_fleet_executions",
    {
      title: "Fleet executions",
      description:
        "List fleet executor actions from the journal. Ordered most-recent-first; total is post-filter pre-limit count.",
      inputSchema: {
        node: z.string().optional(),
        sinceIsoTs: z.string().optional(),
        limit: z.number().optional(),
        journalPath: z.string().optional(),
      },
    },
    ({ node, sinceIsoTs, limit = 50, journalPath }) => {
      const path = journalPath ?? defaultFleetJournalPath();
      const entries = readJournal(path);

      const executions: FleetExecutionEntry[] = [];
      for (const e of entries) {
        if (e.kind !== "fleet-execution") continue;
        if (node !== undefined && e.node !== node) continue;
        if (sinceIsoTs !== undefined && e.ts < sinceIsoTs) continue;
        executions.push(e);
      }

      executions.sort((a, b) => b.ts.localeCompare(a.ts));
      const total = executions.length;
      return toTextContent({ executions: executions.slice(0, limit), total });
    },
  );

  server.registerTool(
    "llamactl_fleet_journal_tail",
    {
      title: "Fleet journal tail",
      description:
        "Return raw recent journal entries, optionally filtered by node and/or entry kind. Returns the last `limit` (default 20) matching entries in chronological order.",
      inputSchema: {
        node: z.string().optional(),
        kinds: z
          .array(
            z.enum([
              "fleet-snapshot",
              "fleet-heartbeat",
              "fleet-transition",
              "fleet-proposal",
              "fleet-execution",
              "fleet-pressure-status",
              "fleet-placement",
              "fleet-move",
              "fleet-lease-election",
            ]),
          )
          .optional(),
        limit: z.number().optional(),
        journalPath: z.string().optional(),
      },
    },
    ({ node, kinds, limit = 20, journalPath }) => {
      const path = journalPath ?? defaultFleetJournalPath();
      const entries = readJournal(path);
      const kindSet = kinds ? new Set(kinds) : null;

      const filtered = entries.filter((e) => {
        if (node !== undefined && e.node !== node) return false;
        if (kindSet && !kindSet.has(e.kind)) return false;
        return true;
      });

      return toTextContent({ entries: filtered.slice(-limit) });
    },
  );

  server.registerTool(
    "llamactl_admit_measure",
    {
      title: "Admit Measure",
      description: "Probe peak RSS for a workload via `admit measure`.",
      inputSchema: {
        workload: z.string(),
        node: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
      },
    },
    (input) => handleAdmitMeasure(spawnFn, input),
  );

  server.registerTool(
    "llamactl_supervisor_execute",
    {
      title: "Supervisor Execute",
      description: "Execute a supervisor proposal or run auto mode (single tick via --once).",
      inputSchema: {
        proposalId: z.string().optional(),
        auto: z.boolean().optional(),
        severityThreshold: z.number().int().min(1).max(3).optional(),
        node: z.string().optional(),
        confirm: z.boolean().optional(),
        timeoutMs: z.number().int().positive().optional(),
      },
    },
    (input) => handleSupervisorExecute(spawnFn, detectExistingSupervisor, input),
  );
}

function readJournal(journalPath: string): FleetJournalEntry[] {
  if (!existsSync(journalPath)) return [];
  const raw = readFileSync(journalPath, "utf8");
  const entries: FleetJournalEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as FleetJournalEntry);
    } catch {
      console.warn("[fleet-tools] skipping malformed journal line:", trimmed.slice(0, 80));
    }
  }
  return entries;
}

export function collectLatestSnapshots(
  entries: FleetJournalEntry[],
  node?: string,
): FleetSnapshotEntry[] {
  const latest = new Map<string, FleetSnapshotEntry>();
  for (const e of entries) {
    if (e.kind !== "fleet-snapshot") continue;
    if (node !== undefined && e.node !== node) continue;
    const cur = latest.get(e.node);
    if (!cur || e.ts > cur.ts) latest.set(e.node, e);
  }
  return [...latest.values()];
}

export function collectProposals(
  entries: FleetJournalEntry[],
  opts: { node?: string; pendingOnly?: boolean; sinceIsoTs?: string } = {},
): FleetProposalEntry[] {
  const executedIds = new Set<string>();
  for (const e of entries) {
    if (e.kind === "fleet-execution") executedIds.add(e.proposalId);
  }

  const out: FleetProposalEntry[] = [];
  for (const e of entries) {
    if (e.kind !== "fleet-proposal") continue;
    if (opts.node !== undefined && e.node !== opts.node) continue;
    if (opts.sinceIsoTs !== undefined && e.ts < opts.sinceIsoTs) continue;
    if ((opts.pendingOnly ?? true) && executedIds.has(e.proposalId)) continue;
    out.push(e);
  }
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return out;
}
