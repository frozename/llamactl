// packages/app/test/console/logs-scope.test.ts
// Issue #410, P5a-3d RED — pins the logs view scope helpers. The
// workload picker lists only tab-node workload names, deduped and
// sorted; selectLogsWorkload classifies the route workload as
// pending / none / selected / elsewhere / missing without a network
// call; logsSubscriptionInput freezes the history window and follow
// flag the UI cannot reach; logsStreamGate + logsConnState fold the
// status query and subscription status into the conn dot; the
// reducer buffers line/divider entries, resets to a single divider
// on __reconnect__ and caps at MAX_LOG_LINES; maskLogLine redacts
// secret flags, bearer tokens and URL userinfo on append. The module
// does not exist at the base commit, so every case fails by
// assertion through the import-catch pattern — never by import
// error.

import { describe, expect, test } from "bun:test";

import { consoleHref } from "../../src/console/router";
import { RECONNECT_SIGNAL } from "../../src/lib/transport/sse-lifecycle";

const SCOPE_SPEC = "../../src/console/logs-scope.ts";

interface LogsWorkloadRow {
  name: string;
  kind: "ModelRun" | "ModelHost";
  node: string;
  endpoint: string | null;
  workerNodes: string[];
}

type LogsGate = "pending" | "online" | "offline" | "error";
type LogsConn = "connecting" | "streaming" | "error" | "idle";

type LogsSelection =
  | { kind: "pending" }
  | { kind: "none" }
  | { kind: "selected"; name: string }
  | { kind: "elsewhere"; node: string; message: string; href: string }
  | { kind: "missing"; name: string };

type LogsEntry = { kind: "line"; text: string } | { kind: "divider" };

interface LogsState {
  entries: LogsEntry[];
  pendingFreshStart: boolean;
}

type LogsAction =
  | { type: "event"; event: unknown }
  | { type: "clear" }
  | { type: "gate-off" }
  | { type: "stream-start" };

const emptyLogsState = (): LogsState => ({ entries: [], pendingFreshStart: false });

interface LogsScopeModule {
  INITIAL_LOGS_STATE?: LogsState;
  LOGS_HISTORY_LINES?: number;
  MAX_LOG_LINES?: number;
  logsConnState?: (
    subscriptionStatus: string | undefined,
    error: unknown,
    gate: LogsGate,
  ) => LogsConn;
  logsReducer?: (state: LogsState, action: LogsAction) => LogsState;
  logsStreamGate?: (statusQuery: {
    data?: unknown;
    isError?: boolean;
    isPending?: boolean;
  }) => LogsGate;
  logsSubscriptionInput?: (workload: string) => {
    workload: string;
    lines: number;
    follow: boolean;
  };
  logsWorkloadNames?: (rows: readonly LogsWorkloadRow[], tabNode: string) => string[];
  maskLogLine?: (line: string) => string;
  selectLogsWorkload?: (
    data: unknown,
    routeWorkload: string | undefined,
    tabNode: string,
  ) => LogsSelection;
}

const mod = (await import(SCOPE_SPEC).catch(() => ({}))) as LogsScopeModule;

function makeRow(name: string, node: string): LogsWorkloadRow {
  return { name, kind: "ModelRun", node, endpoint: null, workerNodes: [] };
}

const ROWS: LogsWorkloadRow[] = [
  makeRow("qwen", "local"),
  makeRow("gemma", "local"),
  makeRow("aaa", "remote1"),
  makeRow("llama", "local"),
  makeRow("gemma", "local"),
];

function lineAction(text: string): LogsAction {
  return { type: "event", event: { type: "line", line: text } };
}

const reconnectAction: LogsAction = { type: "event", event: RECONNECT_SIGNAL };

function entryTexts(state: LogsState): string[] {
  return state.entries.flatMap((entry) => (entry.kind === "line" ? [entry.text] : []));
}

function dividerCount(state: LogsState): number {
  return state.entries.filter((entry) => entry.kind === "divider").length;
}

describe("logs scope (#410 P5a-3d)", () => {
  test("logsWorkloadNames lists tab-node names deduped and sorted, never other nodes", () => {
    expect(typeof mod.logsWorkloadNames).toBe("function");

    expect(mod.logsWorkloadNames!(ROWS, "local")).toEqual(["gemma", "llama", "qwen"]);
    expect(mod.logsWorkloadNames!([makeRow("solo", "remote2")], "local")).toEqual([]);
  });

  test("selectLogsWorkload stays pending until rows arrive, then picks the first sorted name", () => {
    expect(typeof mod.selectLogsWorkload).toBe("function");

    expect(mod.selectLogsWorkload!(undefined, undefined, "local")).toEqual({ kind: "pending" });
    expect(mod.selectLogsWorkload!("not-an-array", undefined, "local")).toEqual({
      kind: "pending",
    });
    expect(mod.selectLogsWorkload!(ROWS, undefined, "local")).toEqual({
      kind: "selected",
      name: "gemma",
    });
  });

  test("selectLogsWorkload follows the route workload and stays pure across switches", () => {
    expect(typeof mod.selectLogsWorkload).toBe("function");

    expect(mod.selectLogsWorkload!(ROWS, "gemma", "local")).toEqual({
      kind: "selected",
      name: "gemma",
    });
    expect(mod.selectLogsWorkload!(ROWS, "qwen", "local")).toEqual({
      kind: "selected",
      name: "qwen",
    });
  });

  test("selectLogsWorkload classifies a route on another node as elsewhere with a switch href", () => {
    expect(typeof mod.selectLogsWorkload).toBe("function");

    expect(mod.selectLogsWorkload!(ROWS, "aaa", "local")).toEqual({
      kind: "elsewhere",
      node: "remote1",
      message: "This workload runs on remote1. Switch this tab or open a new one",
      href: consoleHref({ view: "logs", workload: "aaa", node: "remote1" }),
    });
  });

  test("selectLogsWorkload reports a route missing everywhere and an empty list as none", () => {
    expect(typeof mod.selectLogsWorkload).toBe("function");

    expect(mod.selectLogsWorkload!(ROWS, "ghost", "local")).toEqual({
      kind: "missing",
      name: "ghost",
    });
    expect(mod.selectLogsWorkload!([], undefined, "local")).toEqual({ kind: "none" });
  });

  test("logsSubscriptionInput pins the history window and follow flag the UI cannot change", () => {
    expect(typeof mod.logsSubscriptionInput).toBe("function");
    expect(mod.LOGS_HISTORY_LINES).toBe(200);

    expect(mod.logsSubscriptionInput!("qwen")).toEqual({
      workload: "qwen",
      lines: 200,
      follow: true,
    });
    expect(Object.keys(mod.logsSubscriptionInput!("qwen")).sort()).toEqual([
      "follow",
      "lines",
      "workload",
    ]);
    expect(mod.logsSubscriptionInput!.length).toBe(1);
  });

  test("logsStreamGate maps the status query onto the stream gate", () => {
    expect(typeof mod.logsStreamGate).toBe("function");

    expect(mod.logsStreamGate!({ data: undefined })).toBe("pending");
    expect(mod.logsStreamGate!({ isPending: true })).toBe("pending");
    expect(mod.logsStreamGate!({ isError: true })).toBe("error");
    expect(mod.logsStreamGate!({ data: { state: "down" } })).toBe("offline");
    expect(mod.logsStreamGate!({ data: { state: "up" } })).toBe("online");
  });

  test("logsConnState folds subscription status, error and gate into the conn dot", () => {
    expect(typeof mod.logsConnState).toBe("function");

    expect(mod.logsConnState!("pending", null, "online")).toBe("streaming");
    expect(mod.logsConnState!("connecting", null, "online")).toBe("connecting");
    expect(mod.logsConnState!("error", null, "online")).toBe("error");
    expect(mod.logsConnState!("pending", "boom", "online")).toBe("error");
    expect(mod.logsConnState!("idle", null, "online")).toBe("idle");
    expect(mod.logsConnState!(undefined, null, "online")).toBe("connecting");
    for (const gate of ["offline", "pending", "error"] as const) {
      expect(mod.logsConnState!("pending", null, gate)).toBe("idle");
    }
  });

  test("INITIAL_LOGS_STATE is an empty entry list with no pending fresh start", () => {
    expect(typeof mod.logsReducer).toBe("function");

    expect(mod.INITIAL_LOGS_STATE).toEqual({ entries: [], pendingFreshStart: false });
  });

  test("logsReducer appends line entries and resets to one divider on reconnect", () => {
    expect(typeof mod.logsReducer).toBe("function");
    const reducer = mod.logsReducer!;
    let state = mod.INITIAL_LOGS_STATE ?? emptyLogsState();

    for (const text of ["l1", "l2", "l3"]) {
      state = reducer(state, lineAction(text));
    }
    expect(state.entries).toEqual([
      { kind: "line", text: "l1" },
      { kind: "line", text: "l2" },
      { kind: "line", text: "l3" },
    ]);

    state = reducer(state, reconnectAction);
    expect(state.entries).toEqual([{ kind: "divider" }]);

    for (const text of ["l1", "l2", "l3", "l4"]) {
      state = reducer(state, lineAction(text));
    }
    expect(dividerCount(state)).toBe(1);
    expect(entryTexts(state)).toEqual(["l1", "l2", "l3", "l4"]);
    expect(entryTexts(state).filter((text) => text === "l1")).toHaveLength(1);

    state = reducer(state, reconnectAction);
    for (const text of ["l1", "l2", "l3", "l4"]) {
      state = reducer(state, lineAction(text));
    }
    expect(dividerCount(state)).toBe(1);
    expect(entryTexts(state)).toEqual(["l1", "l2", "l3", "l4"]);
  });

  test("a plain __reconnect__ event behaves the same as RECONNECT_SIGNAL", () => {
    expect(typeof mod.logsReducer).toBe("function");
    const reducer = mod.logsReducer!;
    let state = mod.INITIAL_LOGS_STATE ?? emptyLogsState();

    state = reducer(state, lineAction("only"));
    state = reducer(state, { type: "event", event: { type: "__reconnect__" } });
    expect(state.entries).toEqual([{ kind: "divider" }]);
  });

  test("unknown events return the identical state object and clear empties entries", () => {
    expect(typeof mod.logsReducer).toBe("function");
    const reducer = mod.logsReducer!;
    let state = mod.INITIAL_LOGS_STATE ?? emptyLogsState();
    state = reducer(state, lineAction("keep"));

    expect(reducer(state, { type: "event", event: { type: "noise" } })).toBe(state);
    expect(reducer(state, { type: "event", event: undefined })).toBe(state);
    expect(reducer(state, { type: "clear" }).entries).toEqual([]);
  });

  test("logsReducer caps entries at MAX_LOG_LINES keeping the newest", () => {
    expect(typeof mod.logsReducer).toBe("function");
    expect(mod.MAX_LOG_LINES).toBe(2000);
    const reducer = mod.logsReducer!;
    const max = mod.MAX_LOG_LINES!;
    let state = mod.INITIAL_LOGS_STATE ?? emptyLogsState();

    const total = max + 5;
    const texts = Array.from({ length: total }, (_value, index) => `line-${String(index)}`);
    for (const text of texts) {
      state = reducer(state, lineAction(text));
    }

    expect(state.entries).toHaveLength(max);
    const kept = entryTexts(state);
    expect(kept.at(-1)).toBe(`line-${String(total - 1)}`);
    expect(kept[0]).toBe("line-5");
  });

  test("maskLogLine redacts secret flags, bearer tokens and URL userinfo", () => {
    expect(typeof mod.maskLogLine).toBe("function");
    const mask = mod.maskLogLine!;

    expect(mask("srv --api-key sentinel-log --port 8080")).toBe(
      "srv --api-key [redacted] --port 8080",
    );
    expect(mask("--hf-token=abc")).toBe("--hf-token=[redacted]");
    expect(mask("--hf-token abc")).toBe("--hf-token [redacted]");
    expect(mask("--api-key=xyz")).toBe("--api-key=[redacted]");
    expect(mask("Authorization: Bearer abc.def")).toBe("Authorization: Bearer [redacted]");
    expect(mask("fetch http://u:pw@h:1/x")).toBe("fetch http://h:1/x");
    expect(mask("llama-server ready on port 8080")).toBe("llama-server ready on port 8080");
  });

  test("maskLogLine is idempotent", () => {
    expect(typeof mod.maskLogLine).toBe("function");
    const mask = mod.maskLogLine!;

    for (const line of [
      "srv --api-key sentinel-log --port 8080",
      "--hf-token=abc",
      "Authorization: Bearer abc.def",
      "fetch http://u:pw@h:1/x",
    ]) {
      expect(mask(mask(line))).toBe(mask(line));
    }
  });

  test("logsReducer masks secret material when appending lines", () => {
    expect(typeof mod.logsReducer).toBe("function");
    const reducer = mod.logsReducer!;
    let state = mod.INITIAL_LOGS_STATE ?? emptyLogsState();

    state = reducer(state, lineAction("--api-key sentinel-log"));
    for (const text of entryTexts(state)) {
      expect(text).not.toContain("sentinel-log");
    }
  });

  test("lines -> gate offline -> gate online + backfill = no duplicates, one divider", () => {
    expect(typeof mod.logsReducer).toBe("function");
    const reducer = mod.logsReducer!;
    let state = mod.INITIAL_LOGS_STATE ?? emptyLogsState();

    for (const text of ["a", "b", "c"]) {
      state = reducer(state, lineAction(text));
    }
    expect(entryTexts(state)).toEqual(["a", "b", "c"]);

    state = reducer(state, { type: "gate-off" });
    expect(entryTexts(state)).toEqual(["a", "b", "c"]);
    expect(reducer(state, { type: "gate-off" })).toBe(state);

    state = reducer(state, { type: "stream-start" });
    expect(state.entries).toEqual([{ kind: "divider" }]);

    for (const text of ["a", "b", "c"]) {
      state = reducer(state, lineAction(text));
    }
    expect(dividerCount(state)).toBe(1);
    expect(entryTexts(state)).toEqual(["a", "b", "c"]);
    for (const text of ["a", "b", "c"]) {
      expect(entryTexts(state).filter((entry) => entry === text)).toHaveLength(1);
    }
  });

  test("stream-start with no gate-off period keeps the buffer and adds no divider", () => {
    expect(typeof mod.logsReducer).toBe("function");
    const reducer = mod.logsReducer!;
    let state = mod.INITIAL_LOGS_STATE ?? emptyLogsState();

    state = reducer(state, lineAction("keep"));
    expect(reducer(state, { type: "stream-start" })).toBe(state);
    expect(dividerCount(state)).toBe(0);
  });

  test("clear empties the buffer and drops the pending fresh start", () => {
    expect(typeof mod.logsReducer).toBe("function");
    const reducer = mod.logsReducer!;
    let state = mod.INITIAL_LOGS_STATE ?? emptyLogsState();

    state = reducer(state, lineAction("keep"));
    state = reducer(state, { type: "gate-off" });
    state = reducer(state, { type: "clear" });
    expect(state).toEqual({ entries: [], pendingFreshStart: false });
    expect(reducer(state, { type: "stream-start" })).toBe(state);
  });
});
