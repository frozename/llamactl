import * as readline from "node:readline";

import type { FleetJournalEntry, FleetPressureStatusEntry, FleetTransitionEntry } from "./types.js";

import { DEFAULT_PRESSURE_THRESHOLDS } from "./loop.js";
import * as fs from "./safe-fs.js";

export interface NodePressureStatus {
  name: string;
  state: "NORMAL" | "HIGH";
  enteredAt: string | null;
  durationMs: number;
  consecutiveClearTicks: number;
  clearTicksNeeded: number;
  free_mb: number;
  compressor_mb: number;
  headroomBreach: boolean;
  compressorBreach: boolean;
  recent: FleetPressureStatusEntry[];
}

export interface SupervisorStatusReport {
  nodes: NodePressureStatus[];
}

export interface ReadSupervisorStatusOptions {
  journalPath: string;
  node?: string;
  limit?: number;
}

type NodePressureAccumulator = {
  state: "NORMAL" | "HIGH";
  enteredAt: string | null;
  lastTransitionTs: string | null;
  lastStatus: FleetPressureStatusEntry | null;
  recent: FleetPressureStatusEntry[];
};

function ensureNode(
  nodeStates: Map<string, NodePressureAccumulator>,
  node: string,
): NodePressureAccumulator {
  const existing = nodeStates.get(node);
  if (existing) return existing;
  const created: NodePressureAccumulator = {
    state: "NORMAL",
    enteredAt: null,
    lastTransitionTs: null,
    lastStatus: null,
    recent: [],
  };
  nodeStates.set(node, created);
  return created;
}

function applyTransition(
  nodeStates: Map<string, NodePressureAccumulator>,
  trans: FleetTransitionEntry,
): void {
  if (trans.signal === "pressure" && trans.to === "HIGH") {
    const state = ensureNode(nodeStates, trans.node);
    state.state = "HIGH";
    state.enteredAt = trans.ts;
    state.lastTransitionTs = trans.ts;
    return;
  }
  if (trans.signal === "pressure-cleared" && trans.to === "NORMAL") {
    const state = ensureNode(nodeStates, trans.node);
    state.state = "NORMAL";
    state.enteredAt = null;
    state.lastTransitionTs = trans.ts;
  }
}

function applyPressureStatus(
  nodeStates: Map<string, NodePressureAccumulator>,
  status: FleetPressureStatusEntry,
  limit: number,
): void {
  const state = ensureNode(nodeStates, status.node);
  state.lastStatus = status;
  state.recent.push(status);
  if (state.recent.length > limit) {
    state.recent.shift();
  }
  if (state.lastTransitionTs === null || status.ts > state.lastTransitionTs) {
    state.state = status.state;
    state.enteredAt = status.state === "HIGH" ? status.enteredAt : null;
  }
}

function applyJournalLine(
  line: string,
  nodeStates: Map<string, NodePressureAccumulator>,
  opts: ReadSupervisorStatusOptions,
  limit: number,
): void {
  try {
    const entry = JSON.parse(line) as FleetJournalEntry;
    if (opts.node && entry.node !== opts.node) return;

    if (entry.kind === "fleet-transition" && entry.subjectKind === "node") {
      applyTransition(nodeStates, entry);
      return;
    }
    if (entry.kind === "fleet-pressure-status") {
      applyPressureStatus(nodeStates, entry, limit);
    }
  } catch {
    // Ignore unparseable lines
  }
}

function buildNodeStatus(
  node: string,
  state: NodePressureAccumulator,
  now: number,
): NodePressureStatus {
  const enteredAtMs = state.enteredAt !== null ? Date.parse(state.enteredAt) : NaN;
  return {
    name: node,
    state: state.state,
    enteredAt: state.enteredAt,
    durationMs: Number.isFinite(enteredAtMs) ? Math.max(0, now - enteredAtMs) : 0,
    consecutiveClearTicks: state.lastStatus ? state.lastStatus.consecutiveClearTicks : 0,
    clearTicksNeeded: state.lastStatus
      ? state.lastStatus.clearTicksNeeded
      : DEFAULT_PRESSURE_THRESHOLDS.clearTicks,
    free_mb: state.lastStatus ? state.lastStatus.free_mb : 0,
    compressor_mb: state.lastStatus ? state.lastStatus.compressor_mb : 0,
    headroomBreach: state.lastStatus ? state.lastStatus.headroomBreach : false,
    compressorBreach: state.lastStatus ? state.lastStatus.compressorBreach : false,
    recent: [...state.recent].reverse(), // most recent first
  };
}

export async function readSupervisorStatus(
  opts: ReadSupervisorStatusOptions,
): Promise<SupervisorStatusReport> {
  const limit = opts.limit ?? 20;

  const nodeStates = new Map<string, NodePressureAccumulator>();

  if (!fs.existsSync(opts.journalPath)) {
    return { nodes: [] };
  }

  const stream = fs.createReadStream(opts.journalPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    applyJournalLine(line, nodeStates, opts, limit);
  }

  const report: SupervisorStatusReport = { nodes: [] };
  const now = Date.now();

  for (const [node, state] of nodeStates.entries()) {
    report.nodes.push(buildNodeStatus(node, state, now));
  }

  // Sort nodes alphabetically
  report.nodes.sort((a, b) => a.name.localeCompare(b.name));

  return report;
}
