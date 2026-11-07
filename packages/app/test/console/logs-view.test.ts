// Issue #410 P5a-3d RED — pins the console logs view: the workload
// picker lists only tab-node names and the route (or first sorted
// name) selects exactly one serverStatus/serverLogs pair through the
// node-scoped client; the subscription input is a single memoized
// {workload, lines: 200, follow: true} object; the status gate
// idles the stream while the server is not up; reconnect events
// collapse to one divider without duplicating replayed lines and
// every rendered line passes maskLogLine; a workloadList error shows
// its own notice instead of pending. Rendered through
// react-dom/server against the mocked node-scoped tRPC proxy; the
// view module does not exist at the base commit, so every case fails
// by assertion — never by import error.

import type { FunctionComponent, ReactElement, ReactNode } from "react";

import { skipToken } from "@tanstack/react-query";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ConsoleRoute } from "../../src/console/router";

import { consoleHref } from "../../src/console/router";
import { RECONNECT_SIGNAL } from "../../src/lib/transport/sse-lifecycle";

const NODE_TRPC_SPEC = "../../src/console/node-trpc.ts";
const VIEW_SPEC = "../../src/console/views/logs.tsx";
const CONSOLE_NODE = "local";
const ALLOWED_PROCEDURES = new Set(["workloadList", "serverStatus", "serverLogs"]);

interface StubButtonProps {
  children?: ReactNode;
  disabled?: boolean | undefined;
  onClick?: (() => void) | undefined;
  size?: string;
  variant?: string;
}
const renderedButtons: StubButtonProps[] = [];
function ButtonStub(props: StubButtonProps): ReactElement {
  renderedButtons.push(props);
  return createElement(
    "button",
    {
      disabled: props.disabled === true,
      onClick: props.onClick,
      type: "button",
    },
    props.children,
  );
}

const uiReal = { ...(await import("../../src/ui/index")) };
const nodeTrpcReal = { ...(await import("../../src/console/node-trpc.ts")) };

interface QueryOptions {
  enabled?: boolean;
}

interface SubscriptionOptions {
  enabled?: boolean;
  onComplete?: (() => void) | undefined;
  onData?: ((data: unknown) => void) | undefined;
  onError?: ((error: unknown) => void) | undefined;
  onStarted?: (() => void) | undefined;
}

interface LogsViewRow {
  name: string;
  kind: string;
  node: string;
  endpoint: string | null;
  workerNodes: string[];
}

function makeRow(name: string, node: string): LogsViewRow {
  return { name, kind: "ModelRun", node, endpoint: null, workerNodes: [] };
}

const LOG_ROWS: LogsViewRow[] = [
  makeRow("qwen", "local"),
  makeRow("gemma", "local"),
  makeRow("aaa", "remote1"),
  makeRow("llama", "local"),
  makeRow("gemma", "local"),
];

const accessedProcedures = new Set<string>();
const statusCalls: { input: unknown; enabled: boolean }[] = [];
const logsSubs: { input: unknown; enabled: boolean }[] = [];
let listScript: unknown[] = [];
let listError = false;
let statusData: unknown = { state: "up" };
let statusError = false;
let subStatus: string | undefined;
let feedEvents: unknown[] | undefined;
let consoleNode = CONSOLE_NODE;

function subscriptionEnabled(input: unknown, options: SubscriptionOptions | undefined): boolean {
  return input !== skipToken && options?.enabled !== false;
}

function procedureStub(procedure: string): Record<string, unknown> {
  return {
    useInfiniteQuery: (): Record<string, unknown> => ({
      data: undefined,
      isLoading: false,
    }),
    useMutation: (_options?: unknown): Record<string, unknown> => ({
      data: undefined,
      error: null,
      isError: false,
      isPending: false,
      mutate: (_input: unknown): void => undefined,
      mutateAsync: (_input: unknown): Promise<unknown> => Promise.resolve({}),
      reset: (): void => undefined,
    }),
    useQuery: (input?: unknown, options?: QueryOptions): Record<string, unknown> => {
      if (procedure === "workloadList") {
        const [pass, setPass] = useState(0);
        if (pass < listScript.length - 1) {
          setPass(pass + 1);
        }
        const data: unknown = listScript[pass];
        return {
          data,
          error: null,
          isError: listError,
          isLoading: false,
          isPending: data === undefined && !listError,
          isSuccess: data !== undefined && !listError,
        };
      }
      if (procedure === "serverStatus") {
        statusCalls.push({
          input,
          enabled: input !== skipToken && options?.enabled !== false,
        });
        return {
          data: statusData,
          error: null,
          isError: statusError,
          isLoading: false,
          isPending: statusData === undefined && !statusError,
          isSuccess: statusData !== undefined && !statusError,
        };
      }
      return {
        data: undefined,
        error: null,
        isError: false,
        isLoading: false,
        isPending: true,
        isSuccess: false,
      };
    },
    useSubscription: (input?: unknown, options?: SubscriptionOptions): Record<string, unknown> => {
      if (procedure === "serverLogs") {
        const enabled = subscriptionEnabled(input, options);
        logsSubs.push({ input, enabled });
        const [pass, setPass] = useState(0);
        const fed = useRef(false);
        if (enabled && feedEvents !== undefined && !fed.current) {
          fed.current = true;
          for (const event of feedEvents) {
            options?.onData?.(event);
          }
        }
        if (pass < 2) {
          setPass(pass + 1);
        }
        return { status: subStatus ?? "pending", error: null, data: undefined };
      }
      return { status: "idle", error: null, data: undefined };
    },
    useSuspenseQuery: (): Record<string, unknown> => ({
      data: undefined,
      isLoading: false,
    }),
  };
}

const trpcStub = new Proxy<Record<string, unknown>>(
  {},
  {
    get: (_target, property): unknown => {
      if (typeof property !== "string") return undefined;
      accessedProcedures.add(property);
      return procedureStub(property);
    },
  },
);

const utilsStub = new Proxy<Record<string, { invalidate: () => Promise<void> }>>(
  {},
  {
    get: (_target, key): { invalidate: () => Promise<void> } => ({
      invalidate: (): Promise<void> => Promise.resolve(),
    }),
  },
);

void mock.module("@/ui", () => ({ ...uiReal, Button: ButtonStub }));
void mock.module(NODE_TRPC_SPEC, () => ({
  ...nodeTrpcReal,
  useConsoleNode: (): string => consoleNode,
  useNodeTrpc: (): unknown => trpcStub,
  useNodeTrpcUtils: (): unknown => utilsStub,
}));

const mod = (await import(VIEW_SPEC).catch(() => ({}))) as {
  LogsView?: FunctionComponent<{
    route: ConsoleRoute;
    onSelectWorkload: (workload: string) => void;
  }>;
};

beforeEach(() => {
  accessedProcedures.clear();
  statusCalls.length = 0;
  logsSubs.length = 0;
  renderedButtons.length = 0;
  consoleNode = CONSOLE_NODE;
  listScript = [LOG_ROWS];
  listError = false;
  statusData = { state: "up" };
  statusError = false;
  subStatus = undefined;
  feedEvents = undefined;
});

afterAll(() => {
  void mock.module("@/ui", () => uiReal);
  void mock.module(NODE_TRPC_SPEC, () => nodeTrpcReal);
});

function renderMarkup(element: ReactElement): string {
  try {
    return renderToStaticMarkup(element);
  } catch (error) {
    return `THREW: ${String(error)}`;
  }
}

function renderView(route: ConsoleRoute): string {
  const LogsView = mod.LogsView!;
  return renderMarkup(createElement(LogsView, { route, onSelectWorkload: (): void => undefined }));
}

function workloadSelect(markup: string): string | null {
  const match = /<select\b[^>]*aria-label="Logs workload"[^>]*>[\s\S]*?<\/select>/.exec(markup);
  return match?.[0] ?? null;
}

function optionTags(selectHtml: string): string[] {
  return [...selectHtml.matchAll(/<option\b[^>]*>/g)].map((m) => m[0]);
}

function optionValue(tag: string): string {
  return /\bvalue="([^"]*)"/.exec(tag)?.[1] ?? "";
}

function optionSelected(tag: string): boolean {
  return /\sselected(?:=|\s|>)/.test(tag);
}

function testIdBlock(markup: string, testId: string): string | null {
  const marker = `data-testid="${testId}"`;
  const start = markup.indexOf(marker);
  if (start === -1) return null;
  const contentStart = markup.indexOf(">", start) + 1;
  const next = markup.indexOf("data-testid=", contentStart);
  return markup.slice(contentStart, next === -1 ? markup.length : next);
}

function testIdOpenTag(markup: string, testId: string): string | null {
  const marker = `data-testid="${testId}"`;
  const at = markup.indexOf(marker);
  if (at === -1) return null;
  const open = markup.lastIndexOf("<", at);
  const close = markup.indexOf(">", at);
  if (open === -1 || close === -1) return null;
  return markup.slice(open, close + 1);
}

function lineEntries(markup: string): string[] {
  const pattern =
    /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bdata-testid="console-logs-line"[^>]*>([\s\S]*?)<\/\1>/g;
  const out: string[] = [];
  for (const match of markup.matchAll(pattern)) {
    out.push((match[2] ?? "").replaceAll(/<[^>]*>/g, "").trim());
  }
  return out;
}

function countTestId(markup: string, testId: string): number {
  return markup.split(`data-testid="${testId}"`).length - 1;
}

function countDistinctInputs(calls: { input: unknown; enabled: boolean }[]): number {
  const seen: unknown[] = [];
  let count = 0;
  for (const call of calls) {
    if (!call.enabled) continue;
    if (!seen.some((input) => Object.is(input, call.input))) {
      seen.push(call.input);
      count += 1;
    }
  }
  return count;
}

function enabledCalls(calls: { input: unknown; enabled: boolean }[]): typeof calls {
  return calls.filter((call) => call.enabled);
}

function expectGemmaPicked(markup: string): void {
  const selectHtml = workloadSelect(markup);
  expect(selectHtml).not.toBeNull();
  expect(optionTags(selectHtml ?? "").map(optionValue)).toEqual(["gemma", "llama", "qwen"]);
  const gemma = optionTags(selectHtml ?? "").find((tag) => optionValue(tag) === "gemma");
  expect(gemma).toBeDefined();
  expect(optionSelected(gemma!)).toBe(true);
}

function expectGemmaStreams(): void {
  const statusEnabled = enabledCalls(statusCalls);
  expect(statusEnabled.length).toBeGreaterThan(0);
  for (const call of statusEnabled) {
    expect(call.input).toEqual({ workload: "gemma" });
  }
  const subsEnabled = enabledCalls(logsSubs);
  expect(subsEnabled.length).toBeGreaterThan(0);
  expect(countDistinctInputs(subsEnabled)).toBe(1);
  expect(subsEnabled[0]?.input).toEqual({ workload: "gemma", lines: 200, follow: true });
}

describe("logs view (#410 P5a-3d)", () => {
  test("default pick: first sorted tab-node workload, one memoized subscription, streaming dot", () => {
    const LogsView = mod.LogsView;
    expect(typeof LogsView).toBe("function");

    const markup = renderView({ view: "logs" });

    expect(markup).toContain('data-testid="console-view-logs"');
    expectGemmaPicked(markup);
    expectGemmaStreams();
    for (const procedure of accessedProcedures) {
      expect(ALLOWED_PROCEDURES.has(procedure)).toBe(true);
    }

    const inputTags = [...markup.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]);
    expect(
      inputTags.some(
        (tag) => tag.includes('type="checkbox"') && tag.includes('aria-label="Follow"'),
      ),
    ).toBe(true);

    const connTag = testIdOpenTag(markup, "console-logs-conn");
    expect(connTag).not.toBeNull();
    expect(connTag ?? "").toContain('data-state="streaming"');
  });

  test("late-arriving rows still select gemma — the pick is not captured on first render", () => {
    const LogsView = mod.LogsView;
    expect(typeof LogsView).toBe("function");
    listScript = [undefined, LOG_ROWS];

    const markup = renderView({ view: "logs" });

    expect(markup).toContain('data-testid="console-view-logs"');
    expectGemmaPicked(markup);
    expectGemmaStreams();
  });

  test("the route workload wins over the default pick", () => {
    const LogsView = mod.LogsView;
    expect(typeof LogsView).toBe("function");

    renderView({ view: "logs", workload: "qwen" });
    const qwenSubs = enabledCalls(logsSubs);
    expect(qwenSubs.length).toBeGreaterThan(0);
    for (const call of qwenSubs) {
      expect(call.input).toEqual({ workload: "qwen", lines: 200, follow: true });
    }

    logsSubs.length = 0;
    statusCalls.length = 0;
    renderView({ view: "logs", workload: "llama" });
    const llamaSubs = enabledCalls(logsSubs);
    expect(llamaSubs.length).toBeGreaterThan(0);
    for (const call of llamaSubs) {
      expect(call.input).toEqual({ workload: "llama", lines: 200, follow: true });
    }
  });

  test("a route to another node's workload shows the switch notice and opens no streams", () => {
    const LogsView = mod.LogsView;
    expect(typeof LogsView).toBe("function");

    const markup = renderView({ view: "logs", workload: "aaa" });

    expect(markup).toContain("This workload runs on remote1. Switch this tab or open a new one");
    const href = consoleHref({ view: "logs", workload: "aaa", node: "remote1" });
    expect(markup).toContain(`href="${href}"`);
    expect(enabledCalls(statusCalls)).toHaveLength(0);
    expect(enabledCalls(logsSubs)).toHaveLength(0);
  });

  test("a down server shows the offline notice, idles the conn dot and opens no stream", () => {
    const LogsView = mod.LogsView;
    expect(typeof LogsView).toBe("function");
    statusData = { state: "down" };

    const markup = renderView({ view: "logs" });

    const offlineBlock = testIdBlock(markup, "console-logs-offline");
    expect(offlineBlock).not.toBeNull();
    expect(offlineBlock ?? "").toContain("Server offline");
    const connTag = testIdOpenTag(markup, "console-logs-conn");
    expect(connTag).not.toBeNull();
    expect(connTag ?? "").toContain('data-state="idle"');
    expect(enabledCalls(logsSubs)).toHaveLength(0);
  });

  test("a pending status query opens no stream and shows no offline notice", () => {
    const LogsView = mod.LogsView;
    expect(typeof LogsView).toBe("function");
    statusData = undefined;

    const markup = renderView({ view: "logs" });

    expect(markup).not.toContain("Server offline");
    expect(markup).not.toContain('data-testid="console-logs-offline"');
    const connTag = testIdOpenTag(markup, "console-logs-conn");
    expect(connTag).not.toBeNull();
    expect(connTag ?? "").toContain('data-state="idle"');
    expect(enabledCalls(logsSubs)).toHaveLength(0);
  });

  test("reconnect renders one divider, masks secrets and never duplicates replayed lines", () => {
    const LogsView = mod.LogsView;
    expect(typeof LogsView).toBe("function");
    feedEvents = [
      { type: "line", line: "--api-key sentinel-log" },
      { type: "line", line: "a" },
      RECONNECT_SIGNAL,
      { type: "line", line: "--api-key sentinel-log" },
      { type: "line", line: "a" },
      { type: "line", line: "b" },
    ];

    const markup = renderView({ view: "logs" });

    expect(countTestId(markup, "console-logs-divider")).toBe(1);
    const dividerBlock = testIdBlock(markup, "console-logs-divider");
    expect(dividerBlock ?? "").toContain("reconnected");
    expect(markup).toContain("--api-key [redacted]");
    expect(markup).not.toContain("sentinel-log");
    expect(lineEntries(markup)).toEqual(["--api-key [redacted]", "a", "b"]);
    expect(countDistinctInputs(logsSubs)).toBe(1);
  });

  test("a workloadList error shows the list-error notice and opens no streams", () => {
    const LogsView = mod.LogsView;
    expect(typeof LogsView).toBe("function");
    listScript = [undefined];
    listError = true;

    const markup = renderView({ view: "logs" });

    expect(markup).toContain('data-testid="console-logs-list-error"');
    expect(markup).not.toContain('data-testid="console-logs-pending"');
    expect(enabledCalls(statusCalls)).toHaveLength(0);
    expect(enabledCalls(logsSubs)).toHaveLength(0);
  });

  test("a pending workloadList shows the pending notice and opens no streams", () => {
    const LogsView = mod.LogsView;
    expect(typeof LogsView).toBe("function");
    listScript = [undefined];

    const markup = renderView({ view: "logs" });

    expect(markup).toContain('data-testid="console-logs-pending"');
    expect(enabledCalls(statusCalls)).toHaveLength(0);
    expect(enabledCalls(logsSubs)).toHaveLength(0);
  });

  test("a failed serverStatus refetch shows the status-error notice, idles the dot and opens no stream", () => {
    const LogsView = mod.LogsView;
    expect(typeof LogsView).toBe("function");
    statusError = true;

    const markup = renderView({ view: "logs" });

    const gateErrorBlock = testIdBlock(markup, "console-logs-gate-error");
    expect(gateErrorBlock).not.toBeNull();
    expect(gateErrorBlock ?? "").toContain("Server status unavailable");
    expect(markup).not.toContain('data-testid="console-logs-offline"');
    const connTag = testIdOpenTag(markup, "console-logs-conn");
    expect(connTag).not.toBeNull();
    expect(connTag ?? "").toContain('data-state="idle"');
    expect(enabledCalls(logsSubs)).toHaveLength(0);
  });

  test("the picker carries a selected empty placeholder only while nothing valid is selected", () => {
    const LogsView = mod.LogsView;
    expect(typeof LogsView).toBe("function");

    listScript = [undefined];
    const pendingSelect = workloadSelect(renderView({ view: "logs" }));
    expect(pendingSelect).not.toBeNull();
    const placeholder = optionTags(pendingSelect ?? "").find((tag) => optionValue(tag) === "");
    expect(placeholder).toBeDefined();
    expect(optionSelected(placeholder!)).toBe(true);

    listScript = [LOG_ROWS];
    const missing = workloadSelect(renderView({ view: "logs", workload: "ghost" }));
    expect(missing).not.toBeNull();
    const missingPlaceholder = optionTags(missing ?? "").find((tag) => optionValue(tag) === "");
    expect(missingPlaceholder).toBeDefined();
    expect(optionSelected(missingPlaceholder!)).toBe(true);

    const selected = workloadSelect(renderView({ view: "logs" }));
    expectGemmaPicked(selected ?? "");
    expect(optionTags(selected ?? "").some((tag) => optionValue(tag) === "")).toBe(false);
  });
});
