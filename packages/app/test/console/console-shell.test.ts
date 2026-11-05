// Issue #410 P5a-3b RED — pins the console shell: a four-view nav whose
// links carry the tab node, the dispatchable-node selector fed by
// nodeList (gateways never offered), per-view testids, the
// invalid-session banner, the invalid-node notice, the unknown-path
// notice and the SSR-safe session store. Rendered through
// react-dom/server against a stubbed location and a node-scoped tRPC
// proxy. The shell module does not exist at the base commit, so every
// case fails by assertion — never by import error.

import type { ComponentType, ReactElement, ReactNode } from "react";

import { skipToken } from "@tanstack/react-query";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { consoleHref } from "../../src/console/router";
import {
  consoleSessionStore,
  INVALID_SESSION_MESSAGE,
  useInvalidSession,
} from "../../src/console/session-store";

const NODE_TRPC_SPEC = "../../src/console/node-trpc.ts";
const SHELL_SPEC = "../../src/console/ConsoleShell.tsx";
const CONSOLE_NODE = "local";

const hadElectronTRPC = "electronTRPC" in globalThis;
const prevElectronTRPC = globalThis.electronTRPC;
globalThis.electronTRPC ??= {
  sendMessage: (): undefined => undefined,
  onMessage: (): undefined => undefined,
};

interface LocationStub {
  pathname: string;
  search: string;
}
const locationHolder = globalThis as { location?: LocationStub | undefined };
const hadLocation = "location" in globalThis;
const prevLocation = locationHolder.location;

function setLocation(pathname: string, search: string): void {
  locationHolder.location = { pathname, search };
}

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

interface StubInputProps {
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
  value?: string | undefined;
}
const renderedInputs: StubInputProps[] = [];
function InputStub(props: StubInputProps): ReactElement {
  renderedInputs.push(props);
  return createElement("input", {
    disabled: props.disabled === true,
    placeholder: props.placeholder,
    readOnly: true,
    value: props.value,
  });
}

const uiReal = { ...(await import("../../src/ui/index")) };
const nodeTrpcReal = { ...(await import("../../src/console/node-trpc.ts")) };

const accessedProcedures = new Set<string>();
const describeCalls: { input: unknown; enabled: unknown }[] = [];
const statusCalls: unknown[] = [];
const stopCalls: unknown[] = [];
const logsSubs: { input: unknown; enabled: boolean }[] = [];
const invalidatedKeys: string[] = [];
let queryResults: Record<string, unknown> = {};
let consoleNode = CONSOLE_NODE;

function queryResult(procedure: string, input: unknown, enabled: unknown): Record<string, unknown> {
  if (procedure === "workloadDescribe") describeCalls.push({ input, enabled });
  if (procedure === "serverStatus") statusCalls.push(input);
  return {
    data: queryResults[procedure],
    error: null,
    isError: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
  };
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
      mutate: (input: unknown): void => {
        if (procedure === "serverStop") stopCalls.push(input);
      },
      mutateAsync: (input: unknown): Promise<unknown> => {
        if (procedure === "serverStop") stopCalls.push(input);
        return Promise.resolve({ killed: false, pid: 1, stopped: true });
      },
      reset: (): void => undefined,
    }),
    useQuery: (input?: unknown, options?: { enabled?: boolean }): Record<string, unknown> =>
      queryResult(procedure, input, options?.enabled),
    useSubscription: (
      input?: unknown,
      options?: { enabled?: boolean },
    ): Record<string, unknown> => {
      if (procedure === "serverLogs") {
        logsSubs.push({ input, enabled: input !== skipToken && options?.enabled !== false });
      }
      return {};
    },
    useSuspenseQuery: (input?: unknown, options?: { enabled?: boolean }): Record<string, unknown> =>
      queryResult(procedure, input, options?.enabled),
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
      invalidate: (): Promise<void> => {
        invalidatedKeys.push(typeof key === "string" ? key : "<non-string>");
        return Promise.resolve();
      },
    }),
  },
);

void mock.module("@/ui", () => ({ ...uiReal, Button: ButtonStub, Input: InputStub }));
void mock.module(NODE_TRPC_SPEC, () => ({
  ...nodeTrpcReal,
  useConsoleNode: (): string => consoleNode,
  useNodeTrpc: (): unknown => trpcStub,
  useNodeTrpcUtils: (): unknown => utilsStub,
}));

const mod = (await import(SHELL_SPEC).catch(() => ({}))) as {
  ConsoleShell?: ComponentType;
};

const NODE_LIST = {
  defaultNode: "local",
  nodes: [
    { name: "local", endpoint: "inproc://local" },
    { name: "remote1", effectiveKind: "agent" },
    { name: "gw", effectiveKind: "gateway" },
  ],
};

const NODE_FACTS = {
  nodeName: "local",
  hostname: "local-mbp",
  platform: "darwin-arm64",
  os: "darwin",
  arch: "arm64",
  memBytes: 34359738368,
  gpu: { kind: "metal", name: "M4 Pro" },
  versions: { llamactl: "0.0.0", bun: "1.4.3", llamaCppSrcRev: null },
  llamaCppBuildId: null,
  profile: "macbook-pro-48g",
  startedAt: "2026-11-05T00:00:00.000Z",
  advertisedEndpoint: "http://127.0.0.1:8080",
};

beforeEach(() => {
  accessedProcedures.clear();
  describeCalls.length = 0;
  statusCalls.length = 0;
  stopCalls.length = 0;
  logsSubs.length = 0;
  invalidatedKeys.length = 0;
  renderedButtons.length = 0;
  renderedInputs.length = 0;
  consoleNode = CONSOLE_NODE;
  queryResults = {
    nodeList: NODE_LIST,
    workloadList: [],
    nodeTest: { ok: true, facts: null },
    env: {},
    nodeFacts: NODE_FACTS,
  };
});

afterEach(() => {
  consoleSessionStore.reset();
});

afterAll(() => {
  void mock.module("@/ui", () => uiReal);
  void mock.module(NODE_TRPC_SPEC, () => nodeTrpcReal);
  if (hadElectronTRPC) {
    globalThis.electronTRPC = prevElectronTRPC;
  } else {
    delete (globalThis as { electronTRPC?: unknown }).electronTRPC;
  }
  if (hadLocation) {
    locationHolder.location = prevLocation;
  } else {
    delete locationHolder.location;
  }
});

function renderMarkup(element: ReactElement): string {
  try {
    return renderToStaticMarkup(element);
  } catch (error) {
    return `THREW: ${String(error)}`;
  }
}

function tabNodeSelect(markup: string): string | null {
  const match = /<select\b[^>]*aria-label="Tab node"[^>]*>[\s\S]*?<\/select>/.exec(markup);
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

function renderShell(): string {
  return renderMarkup(createElement(mod.ConsoleShell!));
}

describe("console shell (#410 P5a-3b)", () => {
  test("nav lists the four console views in order with the tab node and marks the current view", () => {
    const ConsoleShell = mod.ConsoleShell;
    expect(typeof ConsoleShell).toBe("function");
    setLocation("/", "");
    consoleNode = "local";

    const markup = renderShell();

    const nav = /<nav\b[^>]*>[\s\S]*?<\/nav>/.exec(markup);
    expect(nav).not.toBeNull();
    const anchors = [...(nav?.[0] ?? "").matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
    expect(anchors).toHaveLength(4);

    const views = [
      { id: "fleet", label: "Fleet" },
      { id: "workloads", label: "Workloads" },
      { id: "nodes", label: "Nodes" },
      { id: "logs", label: "Logs" },
    ] as const;
    for (const [index, view] of views.entries()) {
      const anchor = anchors[index]!;
      expect(anchor).toContain(`href="${consoleHref({ view: view.id, node: "local" })}"`);
      const inner = anchor
        .replace(/<a\b[^>]*>/, "")
        .replace(/<\/a>$/, "")
        .replaceAll(/<[^>]*>/g, "");
      expect(inner).toBe(view.label);
    }

    const current = anchors.filter((anchor) => anchor.includes('aria-current="page"'));
    expect(current).toHaveLength(1);
    expect(current[0]).toContain(`href="${consoleHref({ view: "fleet", node: "local" })}"`);
  });

  test("/workloads?node=remote1 renders the workloads view with remote1 selected; / renders fleet", () => {
    const ConsoleShell = mod.ConsoleShell;
    expect(typeof ConsoleShell).toBe("function");

    setLocation("/workloads", "?node=remote1");
    consoleNode = "remote1";
    queryResults["workloadList"] = [
      { name: "qwen", kind: "ModelRun", node: "remote1", endpoint: null, workerNodes: [] },
      { name: "far", kind: "ModelRun", node: "local", endpoint: null, workerNodes: [] },
    ];
    const workloadsMarkup = renderShell();
    expect(workloadsMarkup).toContain('data-testid="console-view-workloads"');
    // Real WorkloadsView content a PlaceholderView cannot render: the
    // per-row testid and the other-nodes footer, and no placeholder.
    expect(workloadsMarkup).toContain('data-testid="console-workload-row-qwen"');
    expect(workloadsMarkup).toContain('data-testid="console-workloads-other-nodes"');
    expect(workloadsMarkup).not.toContain('data-testid="console-placeholder-workloads"');

    const selectHtml = tabNodeSelect(workloadsMarkup);
    expect(selectHtml).not.toBeNull();
    const remoteOption = optionTags(selectHtml ?? "").find((tag) => optionValue(tag) === "remote1");
    expect(remoteOption).toBeDefined();
    expect(optionSelected(remoteOption!)).toBe(true);

    setLocation("/", "");
    consoleNode = "local";
    const fleetMarkup = renderShell();
    expect(fleetMarkup).toContain('data-testid="console-view-fleet"');
    expect(fleetMarkup).toContain('data-testid="console-fleet-tab-node"');
    expect(fleetMarkup).not.toContain("console-placeholder-fleet");
    expect(fleetMarkup).not.toContain("console-view-workloads");
  });

  test("a /workloads/<name> deep link reaches WorkloadsView and opens exactly that drawer", () => {
    const ConsoleShell = mod.ConsoleShell;
    expect(typeof ConsoleShell).toBe("function");
    setLocation("/workloads/qwen", "");
    consoleNode = "local";
    queryResults["workloadList"] = [
      { name: "qwen", kind: "ModelRun", node: "local", endpoint: null, workerNodes: [] },
      { name: "big", kind: "ModelRun", node: "local", endpoint: null, workerNodes: [] },
    ];

    const markup = renderShell();
    expect(markup).toContain('data-testid="console-view-workloads"');
    expect(markup).toContain('data-testid="console-workload-row-qwen"');
    expect(markup).toContain('data-testid="console-workload-row-big"');
    expect(markup).not.toContain('data-testid="console-placeholder-workloads"');

    const enabled = describeCalls.filter((call) => call.enabled === true);
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.input).toEqual({ name: "qwen" });
    for (const call of describeCalls) {
      if (call.enabled !== true) expect(call.enabled).toBe(false);
    }
  });

  test("the tab-node selector offers only dispatchable nodes, never gateways", () => {
    const ConsoleShell = mod.ConsoleShell;
    expect(typeof ConsoleShell).toBe("function");
    setLocation("/", "");
    consoleNode = "local";

    const markup = renderShell();
    const selectHtml = tabNodeSelect(markup);
    expect(selectHtml).not.toBeNull();
    const values = optionTags(selectHtml ?? "").map(optionValue);
    expect(values).toEqual(["local", "remote1"]);
    expect(selectHtml ?? "").not.toContain("gw");
  });

  test("the invalid-session banner renders inside role=alert only after markInvalid", () => {
    const ConsoleShell = mod.ConsoleShell;
    expect(typeof ConsoleShell).toBe("function");
    setLocation("/", "");
    consoleNode = "local";

    const clean = renderShell();
    expect(clean).not.toContain(INVALID_SESSION_MESSAGE);

    consoleSessionStore.markInvalid();
    const invalid = renderShell();
    const alert = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\brole="alert"[^>]*>[\s\S]*?<\/\1>/.exec(invalid);
    expect(alert).not.toBeNull();
    expect(alert?.[0] ?? "").toContain(INVALID_SESSION_MESSAGE);
  });

  test("an invalid ?node= falls back to local and shows the rejected name", () => {
    const ConsoleShell = mod.ConsoleShell;
    expect(typeof ConsoleShell).toBe("function");
    setLocation("/", "?node=bad%2Fname");
    consoleNode = "local";

    const markup = renderShell();
    const selectHtml = tabNodeSelect(markup);
    expect(selectHtml).not.toBeNull();
    const localOption = optionTags(selectHtml ?? "").find((tag) => optionValue(tag) === "local");
    expect(localOption).toBeDefined();
    expect(optionSelected(localOption!)).toBe(true);

    const notice = testIdBlock(markup, "console-node-notice");
    expect(notice).not.toBeNull();
    expect(notice ?? "").toContain("bad/name");
  });

  test("an unknown path renders the fleet view with the not-found notice", () => {
    const ConsoleShell = mod.ConsoleShell;
    expect(typeof ConsoleShell).toBe("function");
    setLocation("/bogus", "");
    consoleNode = "local";

    const markup = renderShell();
    expect(markup).toContain('data-testid="console-view-fleet"');
    expect(markup).toContain("No console view at /bogus");
  });

  test("/nodes renders the nodes view and /logs renders the logs view", () => {
    const ConsoleShell = mod.ConsoleShell;
    expect(typeof ConsoleShell).toBe("function");

    setLocation("/nodes", "");
    consoleNode = "local";
    const nodesMarkup = renderShell();
    expect(nodesMarkup).toContain('data-testid="console-view-nodes"');
    expect(nodesMarkup).toContain('data-testid="console-node-row-local"');
    expect(nodesMarkup).toContain('data-testid="console-node-row-remote1"');
    expect(nodesMarkup).toContain('data-testid="console-node-row-gw"');
    expect(nodesMarkup).not.toContain('data-testid="console-placeholder-nodes"');

    setLocation("/logs/qwen", "");
    queryResults["workloadList"] = [
      { name: "qwen", kind: "ModelRun", node: "local", endpoint: null, workerNodes: [] },
    ];
    queryResults["serverStatus"] = { state: "up" };
    logsSubs.length = 0;
    const logsMarkup = renderShell();
    expect(logsMarkup).toContain('data-testid="console-view-logs"');
    expect(logsMarkup).not.toContain('data-testid="console-placeholder-logs"');
    const enabledSubs = logsSubs.filter((call) => call.enabled);
    expect(enabledSubs.length).toBeGreaterThanOrEqual(1);
    expect(enabledSubs[0]?.input).toEqual({ workload: "qwen", lines: 200, follow: true });
  });

  test("no other console view opens the serverLogs stream (regression guard)", () => {
    const ConsoleShell = mod.ConsoleShell;
    expect(typeof ConsoleShell).toBe("function");

    // Guard only: proves no view besides logs subscribes serverLogs. It
    // does NOT prove teardown on navigation — that stays with P4 RED 3
    // and the P5b logs.spec.
    setLocation("/fleet", "");
    consoleNode = "local";
    queryResults["workloadList"] = [
      { name: "qwen", kind: "ModelRun", node: "local", endpoint: null, workerNodes: [] },
    ];
    queryResults["serverStatus"] = { state: "up" };
    logsSubs.length = 0;
    renderShell();
    expect(logsSubs).toHaveLength(0);
  });

  test("useInvalidSession is SSR-safe: markInvalid renders 'invalid' instead of throwing", () => {
    function Probe(): string {
      return useInvalidSession() ? "invalid" : "valid";
    }
    consoleSessionStore.markInvalid();
    let out: string;
    try {
      out = renderToStaticMarkup(createElement(Probe));
    } catch (error) {
      out = `THREW: ${String(error)}`;
    }
    expect(out).toBe("invalid");
  });
});
