import * as fs from "node:fs";
import * as readline from "node:readline";

import type { FleetJournalEntry, FleetPressureStatusEntry } from "./types.js";

import { DEFAULT_PRESSURE_THRESHOLDS } from "./loop.js";

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

export async function readSupervisorStatus(
  opts: ReadSupervisorStatusOptions,
): Promise<SupervisorStatusReport> {
  const limit = opts.limit ?? 20;

  const nodeStates = new Map<string, NodePressureAccumulator>();

  const ensureNode = (node: string): NodePressureAccumulator => {
    const existing = nodeStates.get(node);
    if (existing) return existing;
    const created = {
      state: "NORMAL" as const,
      enteredAt: null,
      lastTransitionTs: null,
      lastStatus: null,
      recent: [],
    };
    nodeStates.set(node, created);
    return created;
  };

  if (!fs.existsSync(opts.journalPath)) {
    return { nodes: [] };
  }

  const stream = fs.createReadStream(opts.journalPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as FleetJournalEntry;
      if (opts.node && entry.node !== opts.node) continue;

      if (entry.kind === "fleet-transition" && entry.subjectKind === "node") {
        const trans = entry;
        if (trans.signal === "pressure" && trans.to === "HIGH") {
          const state = ensureNode(entry.node);
          state.state = "HIGH";
          state.enteredAt = trans.ts;
          state.lastTransitionTs = trans.ts;
        } else if (trans.signal === "pressure-cleared" && trans.to === "NORMAL") {
          const state = ensureNode(entry.node);
          state.state = "NORMAL";
          state.enteredAt = null;
          state.lastTransitionTs = trans.ts;
        }
      } else if (entry.kind === "fleet-pressure-status") {
        const status = entry;
        const state = ensureNode(entry.node);
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
    } catch (err) {
      // Ignore unparseable lines
    }
  }

  const report: SupervisorStatusReport = { nodes: [] };
  const now = Date.now();

  for (const [node, state] of nodeStates.entries()) {
    // Determine duration: if NORMAL, it's 0. If HIGH, it's duration since enteredAt.
    // However, if we just parse the log, `now` might not be the best reference for "duration" if the log is old,
    // but the spec says "durationMs: now - enteredAt" which implies time since enteredAt until now.
    report.nodes.push({
      name: node,
      state: state.state,
      enteredAt: state.enteredAt,
      durationMs: state.enteredAt ? Math.max(0, now - new Date(state.enteredAt).getTime()) : 0,
      consecutiveClearTicks: state.lastStatus ? state.lastStatus.consecutiveClearTicks : 0,
      clearTicksNeeded: state.lastStatus
        ? state.lastStatus.clearTicksNeeded
        : DEFAULT_PRESSURE_THRESHOLDS.clearTicks,
      free_mb: state.lastStatus ? state.lastStatus.free_mb : 0,
      compressor_mb: state.lastStatus ? state.lastStatus.compressor_mb : 0,
      headroomBreach: state.lastStatus ? state.lastStatus.headroomBreach : false,
      compressorBreach: state.lastStatus ? state.lastStatus.compressorBreach : false,
      recent: [...state.recent].reverse(), // most recent first
    });
  }

  // Sort nodes alphabetically
  report.nodes.sort((a, b) => a.name.localeCompare(b.name));

  return report;
}
