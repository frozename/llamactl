// #410 P5a-3d, pure scope model behind the logs view: the tab-node
// workload picker, route classification without a network call, the
// frozen subscription input, the status gate + conn-dot fold for the
// server tail, the reconnect-safe line buffer and the defense-in-depth
// line mask. Relative imports only, so bun tests load it without the
// "@/" alias.

import type { ConsoleWorkloadRow } from "./workloads-scope";

import { isReconnectingSignal, isReconnectSignal } from "../lib/transport/sse-lifecycle";
import { consoleHref } from "./router";
import { workloadLocation, workloadsForTab } from "./workloads-scope";

export const LOGS_HISTORY_LINES = 200;
export const MAX_LOG_LINES = 2000;

export type LogsGate = "pending" | "error" | "offline" | "online";

export type LogsConnState = "connecting" | "streaming" | "reconnecting" | "error" | "idle";

export type LogsSelection =
  | { kind: "pending" }
  | { kind: "none" }
  | { kind: "selected"; name: string }
  | { kind: "elsewhere"; node: string; message: string; href: string }
  | { kind: "missing"; name: string };

export type LogEntry = { kind: "line"; text: string } | { kind: "divider" };

export interface LogsState {
  entries: readonly LogEntry[];
  // The status gate closed since the last stream start, so the next
  // onStarted opens a fresh subscription whose backfill would otherwise
  // replay lines the buffer already holds.
  pendingFreshStart: boolean;
  // Set by the RECONNECTING_SIGNAL frame when a resumable subscription
  // receives a server RETURN: the reconnect is scheduled and the backoff
  // timer is running. Cleared when the RECONNECT_SIGNAL frame arrives.
  reconnecting?: true;
}

export const INITIAL_LOGS_STATE: LogsState = { entries: [], pendingFreshStart: false };

export type LogsAction =
  | { type: "event"; event: unknown }
  | { type: "clear" }
  | { type: "gate-off" }
  | { type: "stream-start" };

// Copied deliberately from packages/remote/src/console/allowlist.ts
// (LINE_SECRET_FLAG in maskLineSecrets) and redact.ts (BEARER, USERINFO
// in redactString): the console graph must not import @llamactl/remote,
// so the client re-masks each line on append even though the server's
// serverLogs projection already masked it. Keep the three regexes and
// the "[redacted]" token in lockstep with the server.
const REDACTED = "[redacted]";
const LINE_SECRET_FLAG =
  /(-{1,2}(?:hft|[^\s=]*(?:api[-_]?key|token|secret|password)[^\s=]*))([=\s])(?:\S+)/gi;
const USERINFO = /(?<=:\/\/)[^\s/?#@]*@/g;
const BEARER = /\bBearer\s+\S+/gi;

export function maskLogLine(line: string): string {
  return line
    .replaceAll(LINE_SECRET_FLAG, (_match, flag: string, sep: string) => `${flag}${sep}${REDACTED}`)
    .replaceAll(BEARER, `Bearer ${REDACTED}`)
    .replaceAll(USERINFO, "");
}

export function logsWorkloadNames(rows: readonly ConsoleWorkloadRow[], tabNode: string): string[] {
  const names = new Set(workloadsForTab(rows, tabNode).rows.map((row) => row.name));
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function normaliseRows(data: unknown): ConsoleWorkloadRow[] {
  if (!Array.isArray(data)) return [];
  return (data as ConsoleWorkloadRow[]).map((row) => ({
    ...row,
    workerNodes: Array.isArray(row.workerNodes) ? row.workerNodes : [],
  }));
}

export function selectLogsWorkload(
  data: unknown,
  routeWorkload: string | undefined,
  tabNode: string,
): LogsSelection {
  if (!Array.isArray(data)) return { kind: "pending" };
  const rows = normaliseRows(data);
  if (routeWorkload !== undefined) {
    const location = workloadLocation(rows, routeWorkload, tabNode);
    if (location.kind === "here") {
      return { kind: "selected", name: location.row.name };
    }
    if (location.kind === "elsewhere") {
      return {
        kind: "elsewhere",
        node: location.node,
        message: location.message,
        href: consoleHref({ view: "logs", workload: routeWorkload, node: location.node }),
      };
    }
    return { kind: "missing", name: routeWorkload };
  }
  const first = logsWorkloadNames(rows, tabNode)[0];
  return first === undefined ? { kind: "none" } : { kind: "selected", name: first };
}

// follow:true is the server tail mode (core tailServerLog defaults to
// false and stops after the backfill); the UI Follow toggle is
// client-side auto-scroll only and never enters this input.
export function logsSubscriptionInput(workload: string): {
  workload: string;
  lines: number;
  follow: true;
} {
  return { workload, lines: LOGS_HISTORY_LINES, follow: true } as const;
}

export function logsStreamGate(statusQuery: unknown): LogsGate {
  if (typeof statusQuery !== "object" || statusQuery === null) return "pending";
  const query = statusQuery as Record<string, unknown>;
  if (query["isError"] === true) return "error";
  if (query["isPending"] === true || query["data"] === undefined) return "pending";
  const data = query["data"];
  if (
    typeof data === "object" &&
    data !== null &&
    (data as Record<string, unknown>)["state"] === "down"
  ) {
    return "offline";
  }
  return "online";
}

// "pending" here is the tRPC v11 useSubscription status: the
// connection is open and awaiting data. A "reconnecting" state is
// produced by the P4 sse-lifecycle when a resumable subscription
// receives a server RETURN: the backoff timer is running and the
// __reconnecting__ frame has been emitted.
export function logsConnState(
  status: unknown,
  error: string | null,
  gate: LogsGate,
  reconnecting?: boolean,
): LogsConnState {
  if (gate !== "online") return "idle";
  if (error !== null || status === "error") return "error";
  if (reconnecting === true) return "reconnecting";
  if (status === "pending") return "streaming";
  if (status === "connecting") return "connecting";
  if (status === "idle") return "idle";
  return "connecting";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function reconnectingCarry(state: LogsState): { reconnecting?: true } {
  return state.reconnecting === true ? { reconnecting: true } : {};
}

function reduceLogEvent(state: LogsState, event: unknown): LogsState {
  if (isReconnectSignal(event)) {
    return { entries: [{ kind: "divider" }], pendingFreshStart: state.pendingFreshStart };
  }
  if (isReconnectingSignal(event)) {
    if (state.reconnecting === true) return state;
    return { ...state, reconnecting: true };
  }
  if (isObject(event) && event["type"] === "line" && typeof event["line"] === "string") {
    const entries = [...state.entries, { kind: "line" as const, text: maskLogLine(event["line"]) }];
    return {
      entries:
        entries.length > MAX_LOG_LINES ? entries.slice(entries.length - MAX_LOG_LINES) : entries,
      pendingFreshStart: state.pendingFreshStart,
      ...reconnectingCarry(state),
    };
  }
  return state;
}

export function logsReducer(state: LogsState, action: LogsAction): LogsState {
  if (action.type === "clear") {
    return state.reconnecting === true
      ? { ...INITIAL_LOGS_STATE, reconnecting: true }
      : INITIAL_LOGS_STATE;
  }
  if (action.type === "gate-off") {
    return state.pendingFreshStart ? state : { ...state, pendingFreshStart: true };
  }
  if (action.type === "stream-start") {
    if (!state.pendingFreshStart) return state;
    return {
      entries: [{ kind: "divider" }],
      pendingFreshStart: false,
      ...reconnectingCarry(state),
    };
  }
  return reduceLogEvent(state, action.event);
}
