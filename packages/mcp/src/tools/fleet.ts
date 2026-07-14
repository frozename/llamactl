import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";

import { listPeers } from "@llamactl/core/config/peers";
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
import { FleetAggregator } from "@llamactl/fleet-supervisor/aggregator";
import { defaultFleetAuditPath } from "@llamactl/fleet-supervisor/journal";
import { createPeerFetch } from "@llamactl/fleet-supervisor/peer-fetch";
import { toTextContent } from "@nova/mcp-shared";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { z } from "zod";

import { existsSync, readFileSync } from "../safe-fs.js";

// Resolve the CLI bin path lazily, not at module load. `createRequire().resolve`
// of a workspace package throws inside a `bun build --compile` binary (the
// workspace layout isn't present in $bunfs), which would crash the agent binary
// at startup — fleet.ts is in the static import graph of every command. Deferring
// the resolve into the call path means the throw only happens if the fleet tools
// actually shell out to the CLI, which never occurs in the compiled agent.
let resolvedCliBinPath: string | undefined;
function ensureCliBin(): string {
  if (resolvedCliBinPath !== undefined) return resolvedCliBinPath;
  const binPath = createRequire(import.meta.url).resolve("@llamactl/cli/bin");
  if (!existsSync(binPath)) {
    throw new Error(`llamactl CLI not found at ${binPath}`);
  }
  resolvedCliBinPath = binPath;
  return binPath;
}

const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_ADMIT_CONCURRENT = 2;
const MAX_TIMEOUT_MS_ADMIT = 300_000;
const MAX_TIMEOUT_MS_EXECUTE = 120_000;
const MAX_TIMEOUT_FOLLOWUP_MS = 5_000;
const KILL_TIMEOUT_MS = 2_000;
const OUTPUT_TRUNCATION_SENTINEL = "[output truncated]";
const deprecatedToolWarnings = new Set<string>();
const DEFAULT_MAX_EXECUTION_ATTEMPTS = 3;

interface ExecutionRetryState {
  terminal: boolean;
  pending: boolean;
  attempt: number;
  maxAttempts: number;
}

type FleetExecutionEntryWithRetryFields = FleetExecutionEntry & {
  attempt?: unknown;
  maxAttempts?: unknown;
};

function asPositiveFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function parseFailureAttemptState(
  entry: FleetExecutionEntryWithRetryFields,
): ExecutionRetryState | null {
  const attempt = asPositiveFiniteNumber(entry.attempt);
  const maxAttempts = asPositiveFiniteNumber(entry.maxAttempts ?? DEFAULT_MAX_EXECUTION_ATTEMPTS);
  if (
    attempt === null ||
    maxAttempts === null ||
    !Number.isInteger(attempt) ||
    attempt <= 0 ||
    maxAttempts <= 0
  ) {
    return null;
  }
  return {
    terminal: attempt >= maxAttempts,
    pending: attempt < maxAttempts,
    attempt,
    maxAttempts,
  };
}

function getExecutionRetryState(
  proposalId: string,
  entries: FleetJournalEntry[],
): ExecutionRetryState {
  const proposalEntries = entries.filter(
    (entry): entry is FleetExecutionEntryWithRetryFields =>
      entry.kind === "fleet-execution" && entry.proposalId === proposalId,
  );

  if (
    proposalEntries.some(
      (entry) =>
        entry.status === "executed" || entry.status === "skipped" || entry.attempt === undefined,
    )
  ) {
    return {
      terminal: true,
      pending: false,
      attempt: 0,
      maxAttempts: DEFAULT_MAX_EXECUTION_ATTEMPTS,
    };
  }

  const retryCandidates = proposalEntries
    .filter(
      (entry): entry is FleetExecutionEntry =>
        entry.status === "failed" && entry.attempt !== undefined,
    )
    .map((entry) => parseFailureAttemptState(entry))
    .filter((candidate): candidate is ExecutionRetryState => candidate !== null)
    .sort((a, b) => b.attempt - a.attempt);

  if (retryCandidates.length === 0) {
    return {
      terminal: false,
      pending: true,
      attempt: 0,
      maxAttempts: DEFAULT_MAX_EXECUTION_ATTEMPTS,
    };
  }

  const [latest] = retryCandidates;
  if (latest === undefined) {
    return {
      terminal: false,
      pending: true,
      attempt: 0,
      maxAttempts: DEFAULT_MAX_EXECUTION_ATTEMPTS,
    };
  }

  return {
    terminal: latest.terminal,
    pending: latest.pending,
    attempt: latest.attempt,
    maxAttempts: latest.maxAttempts,
  };
}

function isProposalPending(proposalId: string, entries: FleetJournalEntry[]): boolean {
  const retryState = getExecutionRetryState(proposalId, entries);
  return !retryState.terminal && retryState.pending;
}

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

type ToolContent = { content: { type: "text"; text: string }[] };

function registerDeprecatedAlias(
  server: McpServer,
  oldName: string,
  newName: string,
  title: string,
  inputSchema: z.ZodRawShape,
  handler: (input: never) => ToolContent | Promise<ToolContent>,
): void {
  // The alias schema is identical to the primary tool's schema, so the
  // SDK-inferred callback arg matches the shared handler's input type; the
  // SDK's ToolCallback generic is too constrained to express that directly.
  const wrapped = ((input: never) => {
    warnDeprecatedToolAlias(oldName, newName);
    return handler(input);
  }) as unknown as ToolCallback<z.ZodRawShape>;
  server.registerTool(
    oldName,
    {
      title: `${title} (deprecated)`,
      description: `[DEPRECATED — use ${newName}] Backward-compatible alias for ${newName}.`,
      inputSchema,
    },
    wrapped,
  );
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
    ...(result.code !== undefined ? { code: result.code } : {}),
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
const supervisorExecuteInFlight = new Set<string>();

function snapshotInput(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object") return {};
  return input as Record<string, unknown>;
}

const pressureStatusInputSchema = {
  journalPath: z.string().optional(),
  node: z.string().optional(),
  limit: z.number().int().nonnegative().optional(),
};

async function handleFleetPressureStatus({
  journalPath,
  node,
  limit,
}: {
  journalPath?: string | undefined;
  node?: string | undefined;
  limit?: number | undefined;
}): Promise<{ content: { type: "text"; text: string }[] }> {
  const path = journalPath ?? defaultFleetJournalPath();
  const report = await readSupervisorStatus({
    journalPath: path,
    ...(node !== undefined ? { node } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  return toTextContent(report);
}

const auditInputSchema = {
  auditPath: z.string().optional(),
  tool: z.string().optional(),
  outcome: z.enum(["denied", "success", "error"]).optional(),
  since: z.string().optional(),
  limit: z.number().int().nonnegative().optional(),
};

const snapshotInputSchema = {
  node: z.string().optional(),
  all: z.boolean().optional(),
  journalPath: z.string().optional(),
};

const pressureInputSchema = {
  node: z.string().optional(),
  journalPath: z.string().optional(),
};

const proposalsInputSchema = {
  node: z.string().optional(),
  pendingOnly: z.boolean().optional(),
  sinceIsoTs: z.string().optional(),
  limit: z.number().int().nonnegative().optional(),
  journalPath: z.string().optional(),
};

const executionsInputSchema = {
  node: z.string().optional(),
  sinceIsoTs: z.string().optional(),
  limit: z.number().int().nonnegative().optional(),
  journalPath: z.string().optional(),
};

const journalTailInputSchema = {
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
  limit: z.number().int().nonnegative().optional(),
  journalPath: z.string().optional(),
};

const SAFE_WORKLOAD_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const admitMeasureInputSchema = {
  workload: z.string(),
  node: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  confirm: z.boolean().optional(),
};

const supervisorExecuteInputSchema = {
  proposalId: z.string().optional(),
  auto: z.boolean().optional(),
  severityThreshold: z.number().int().min(1).max(3).optional(),
  node: z.string().optional(),
  confirm: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
};

async function handleFleetAudit({
  auditPath,
  tool,
  outcome,
  since,
  limit,
}: {
  auditPath?: string | undefined;
  tool?: string | undefined;
  outcome?: "denied" | "success" | "error" | undefined;
  since?: string | undefined;
  limit?: number | undefined;
}): Promise<{ content: { type: "text"; text: string }[] }> {
  const result = await readAuditEntries({
    ...(auditPath !== undefined ? { auditPath } : {}),
    ...(tool !== undefined ? { tool } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  return toTextContent(result);
}

function handleFleetSnapshot({
  node,
  all,
  journalPath,
}: {
  node?: string | undefined;
  all?: boolean | undefined;
  journalPath?: string | undefined;
}):
  | Promise<{ content: { type: "text"; text: string }[] }>
  | { content: { type: "text"; text: string }[] } {
  if (all) {
    const peers = listPeers();
    const aggregator = new FleetAggregator({
      peers,
      fetchSnapshot: (peer): Promise<FleetSnapshotEntry | null> => createPeerFetch(peer)(),
    });
    return aggregator.pollNow().then(() => toTextContent({ snapshots: aggregator.getAll() }));
  }
  const path = journalPath ?? defaultFleetJournalPath();
  const entries = readJournal(path);
  return toTextContent({ snapshots: collectLatestSnapshots(entries, node) });
}

function handleFleetProposals({
  node,
  pendingOnly = true,
  limit = 50,
  sinceIsoTs,
  journalPath,
}: {
  node?: string | undefined;
  pendingOnly?: boolean | undefined;
  limit?: number | undefined;
  sinceIsoTs?: string | undefined;
  journalPath?: string | undefined;
}): { content: { type: "text"; text: string }[] } {
  const path = journalPath ?? defaultFleetJournalPath();
  const entries = readJournal(path);
  const proposals = collectProposals(entries, {
    pendingOnly,
    ...(node !== undefined ? { node } : {}),
    ...(sinceIsoTs !== undefined ? { sinceIsoTs } : {}),
  });
  const total = proposals.length;
  return toTextContent({ proposals: proposals.slice(0, limit), total });
}

function handleFleetExecutions({
  node,
  sinceIsoTs,
  limit = 50,
  journalPath,
}: {
  node?: string | undefined;
  sinceIsoTs?: string | undefined;
  limit?: number | undefined;
  journalPath?: string | undefined;
}): { content: { type: "text"; text: string }[] } {
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
}

function handleFleetJournalTail({
  node,
  kinds,
  limit = 20,
  journalPath,
}: {
  node?: string | undefined;
  kinds?: FleetJournalEntry["kind"][] | undefined;
  limit?: number | undefined;
  journalPath?: string | undefined;
}): { content: { type: "text"; text: string }[] } {
  const path = journalPath ?? defaultFleetJournalPath();
  const entries = readJournal(path);
  const kindSet = kinds ? new Set(kinds) : null;

  const filtered = entries.filter((e) => {
    if (node !== undefined && e.node !== node) return false;
    if (kindSet && !kindSet.has(e.kind)) return false;
    return true;
  });

  return toTextContent({ entries: filtered.slice(-limit) });
}

function handleFleetPressure({
  node,
  journalPath,
}: {
  node?: string | undefined;
  journalPath?: string | undefined;
}): {
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
  input: {
    workload: string;
    node?: string | undefined;
    timeoutMs?: number | undefined;
    confirm?: boolean | undefined;
  },
): Promise<{ content: { type: "text"; text: string }[] }> {
  const { workload, node, timeoutMs, confirm } = input;

  if (!SAFE_WORKLOAD_RE.test(workload) || workload.includes("..")) {
    const outcome = {
      ok: false,
      error: "invalid workload name: must not contain path separators, .., or start with . - or /",
    };
    appendAudit("llamactl_admit_measure", snapshotInput({ workload, node }), "denied", outcome);
    return toTextContent(outcome);
  }

  if (confirm !== true) {
    const preview = snapshotInput({ workload, node });
    const outcome = { ok: false, error: "destructive operation requires confirm:true", preview };
    appendAudit("llamactl_admit_measure", preview, "denied", outcome);
    return toTextContent(outcome);
  }

  if (admitMeasureInFlight.size >= MAX_ADMIT_CONCURRENT) {
    const preview = snapshotInput({ workload, node });
    const outcome = { ok: false, error: "too many concurrent admit-measure runs", preview };
    appendAudit("llamactl_admit_measure", preview, "denied", outcome);
    return toTextContent(outcome);
  }

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
    const cliBinPath = ensureCliBin();
    const args = [cliBinPath, "admit", "measure", workload];
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
    proposalId?: string | undefined;
    auto?: boolean | undefined;
    severityThreshold?: number | undefined;
    node?: string | undefined;
    confirm?: boolean | undefined;
    timeoutMs?: number | undefined;
  },
): Promise<{ content: { type: "text"; text: string }[] }> {
  const { proposalId, auto, severityThreshold, node, confirm, timeoutMs } = input;

  if (proposalId?.trim() === "") {
    const outcome = {
      ok: false,
      error: "proposalId must not be empty",
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

  const key = hasProposalId ? proposalId : `auto:${node ?? ""}`;
  if (supervisorExecuteInFlight.has(key)) {
    const snapshot = snapshotInput({ proposalId, auto, severityThreshold, node });
    const outcome = {
      ok: false,
      error: `supervisor execute already running for ${key}`,
      preview: snapshot,
    };
    appendAudit("llamactl_supervisor_execute", snapshot, "denied", outcome);
    return toTextContent(outcome);
  }
  supervisorExecuteInFlight.add(key);

  try {
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

    const cliBinPath = ensureCliBin();
    const args = [cliBinPath, "supervisor", "tick"];
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
  } finally {
    supervisorExecuteInFlight.delete(key);
  }
}

export function registerFleetTools(server: McpServer, deps?: FleetToolDeps): void {
  const spawnFn = deps?.spawn ?? spawn;
  const detectExistingSupervisor =
    deps?.detectExistingSupervisor ??
    ((): Promise<{ running: boolean; pid?: number }> => detectExistingSupervisorDefault(spawnFn));

  server.registerTool(
    "llamactl.fleet.snapshot",
    {
      title: "Fleet snapshot",
      description:
        "Return the latest fleet snapshot per node from the fleet-supervisor journal. When node is set, returns at most one snapshot for that node.",
      inputSchema: snapshotInputSchema,
    },
    handleFleetSnapshot,
  );

  registerDeprecatedAlias(
    server,
    "llamactl_fleet_snapshot",
    "llamactl.fleet.snapshot",
    "Fleet snapshot",
    snapshotInputSchema,
    handleFleetSnapshot,
  );

  server.registerTool(
    "llamactl.fleet.pressure",
    {
      title: "Fleet pressure state",
      description:
        "Current pressure state (NORMAL | HIGH) per node, derived from fleet-transition entries where subjectKind=node and signal in (pressure, pressure-cleared). Nodes that never transitioned appear as NORMAL with lastTransitionAt: null.",
      inputSchema: pressureInputSchema,
    },
    (input) => handleFleetPressure(input),
  );

  registerDeprecatedAlias(
    server,
    "llamactl_fleet_pressure",
    "llamactl.fleet.pressure",
    "Fleet pressure state",
    pressureInputSchema,
    handleFleetPressure,
  );

  server.registerTool(
    "llamactl.fleet.audit",
    {
      title: "Fleet supervisor audit",
      description:
        "Read recent MCP write-tool audit entries from the fleet-supervisor audit log. Supports filters by tool name, outcome, and timestamp.",
      inputSchema: auditInputSchema,
    },
    handleFleetAudit,
  );

  registerDeprecatedAlias(
    server,
    "llamactl_fleet_audit",
    "llamactl.fleet.audit",
    "Fleet supervisor audit",
    auditInputSchema,
    handleFleetAudit,
  );

  server.registerTool(
    "llamactl.fleet.supervisor.audit",
    {
      title: "Fleet supervisor audit",
      description:
        "Read recent MCP write-tool audit entries from the fleet-supervisor audit log. Supports filters by tool name, outcome, and timestamp.",
      inputSchema: auditInputSchema,
    },
    handleFleetAudit,
  );

  registerDeprecatedAlias(
    server,
    "llamactl_fleet_supervisor_audit",
    "llamactl.fleet.supervisor.audit",
    "Fleet supervisor audit",
    auditInputSchema,
    handleFleetAudit,
  );

  server.registerTool(
    "llamactl.fleet.pressure.status",
    {
      title: "Fleet supervisor status",
      description:
        "Current pressure status per node derived from the fleet-supervisor journal: state, time-in-state, clear-tick progress, latest breach flags, and recent fleet-pressure-status entries. Complementary to llamactl.fleet.pressure (transition-derived current state). This tool returns richer periodic fields: time-in-state, clear-tick progress, latest breach flags, and recent fleet-pressure-status journal entries.",
      inputSchema: pressureStatusInputSchema,
    },
    handleFleetPressureStatus,
  );

  registerDeprecatedAlias(
    server,
    "llamactl_fleet_pressure_status",
    "llamactl.fleet.pressure.status",
    "Fleet supervisor status",
    pressureStatusInputSchema,
    handleFleetPressureStatus,
  );

  server.registerTool(
    "llamactl.fleet.supervisor.status",
    {
      title: "Fleet supervisor status",
      description:
        "Current pressure status per node derived from the fleet-supervisor journal: state, time-in-state, clear-tick progress, latest breach flags, and recent fleet-pressure-status entries. Complementary to llamactl.fleet.pressure (transition-derived current state). This tool returns richer periodic fields: time-in-state, clear-tick progress, latest breach flags, and recent fleet-pressure-status journal entries.",
      inputSchema: pressureStatusInputSchema,
    },
    handleFleetPressureStatus,
  );

  registerDeprecatedAlias(
    server,
    "llamactl_fleet_supervisor_status",
    "llamactl.fleet.supervisor.status",
    "Fleet supervisor status",
    pressureStatusInputSchema,
    handleFleetPressureStatus,
  );

  server.registerTool(
    "llamactl.fleet.proposals",
    {
      title: "Fleet proposals",
      description:
        "List fleet proposals from the journal. pendingOnly=true (default) returns only proposals with no matching fleet-execution entry. Ordered most-recent-first; limit applied after filtering.",
      inputSchema: proposalsInputSchema,
    },
    handleFleetProposals,
  );

  registerDeprecatedAlias(
    server,
    "llamactl_fleet_proposals",
    "llamactl.fleet.proposals",
    "Fleet proposals",
    proposalsInputSchema,
    handleFleetProposals,
  );

  server.registerTool(
    "llamactl.fleet.executions",
    {
      title: "Fleet executions",
      description:
        "List fleet executor actions from the journal. Ordered most-recent-first; total is post-filter pre-limit count.",
      inputSchema: executionsInputSchema,
    },
    handleFleetExecutions,
  );

  registerDeprecatedAlias(
    server,
    "llamactl_fleet_executions",
    "llamactl.fleet.executions",
    "Fleet executions",
    executionsInputSchema,
    handleFleetExecutions,
  );

  server.registerTool(
    "llamactl.fleet.journal.tail",
    {
      title: "Fleet journal tail",
      description:
        "Return raw recent journal entries, optionally filtered by node and/or entry kind. Returns the last `limit` (default 20) matching entries in chronological order.",
      inputSchema: journalTailInputSchema,
    },
    handleFleetJournalTail,
  );

  registerDeprecatedAlias(
    server,
    "llamactl_fleet_journal_tail",
    "llamactl.fleet.journal.tail",
    "Fleet journal tail",
    journalTailInputSchema,
    handleFleetJournalTail,
  );

  server.registerTool(
    "llamactl.admit.measure",
    {
      title: "Admit Measure",
      description: "Probe peak RSS for a workload via `admit measure`.",
      inputSchema: admitMeasureInputSchema,
    },
    (input) => handleAdmitMeasure(spawnFn, input),
  );

  registerDeprecatedAlias(
    server,
    "llamactl_admit_measure",
    "llamactl.admit.measure",
    "Admit Measure",
    admitMeasureInputSchema,
    (input: { workload: string; node?: string; timeoutMs?: number; confirm?: boolean }) =>
      handleAdmitMeasure(spawnFn, input),
  );

  server.registerTool(
    "llamactl.supervisor.execute",
    {
      title: "Supervisor Execute",
      description: "Execute a supervisor proposal or run auto mode (single tick via --once).",
      inputSchema: supervisorExecuteInputSchema,
    },
    (input) => handleSupervisorExecute(spawnFn, detectExistingSupervisor, input),
  );

  registerDeprecatedAlias(
    server,
    "llamactl_supervisor_execute",
    "llamactl.supervisor.execute",
    "Supervisor Execute",
    supervisorExecuteInputSchema,
    (input: {
      proposalId?: string;
      auto?: boolean;
      severityThreshold?: number;
      node?: string;
      confirm?: boolean;
      timeoutMs?: number;
    }) => handleSupervisorExecute(spawnFn, detectExistingSupervisor, input),
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

function proposalMatches(
  e: FleetProposalEntry,
  opts: { node?: string; pendingOnly?: boolean; sinceIsoTs?: string },
  pendingIds: Set<string>,
): boolean {
  if (opts.node !== undefined && e.node !== opts.node) return false;
  if (opts.sinceIsoTs !== undefined && e.ts < opts.sinceIsoTs) return false;
  if ((opts.pendingOnly ?? true) && !pendingIds.has(e.proposalId)) return false;
  return true;
}

export function collectProposals(
  entries: FleetJournalEntry[],
  opts: { node?: string; pendingOnly?: boolean; sinceIsoTs?: string } = {},
): FleetProposalEntry[] {
  const proposalIds = new Set<string>();
  for (const e of entries) {
    if (e.kind === "fleet-proposal") proposalIds.add(e.proposalId);
  }

  const pendingIds = new Set<string>();
  for (const proposalId of proposalIds) {
    if (isProposalPending(proposalId, entries)) pendingIds.add(proposalId);
  }

  const out: FleetProposalEntry[] = [];
  for (const e of entries) {
    if (e.kind !== "fleet-proposal") continue;
    if (proposalMatches(e, opts, pendingIds)) out.push(e);
  }
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return out;
}
