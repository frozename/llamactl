// Issue #410 P5a-3b RED — pins the workloads view: current-node row
// filtering with per-row testids, the other-nodes footer with sorted
// deep links, the StopServerAction wiring (enabled only for safe
// single-node ModelRuns), the safe blank-target endpoint link, the
// deep-link drawer gating through workloadDescribe and the
// procedures-only allowlist. Rendered through NodeScopedProvider with
// react-dom/server against the node-scoped tRPC proxy; the view module
// does not exist at the base commit, so every case fails by assertion —
// never by import error.

import type { ComponentType, FunctionComponent, ReactElement, ReactNode } from "react";

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ConsoleRoute } from "../../src/console/router";

import { consoleHref } from "../../src/console/router";
import { openWorkloadName, phaseTone, workloadCardKey } from "../../src/console/workloads-scope";

const NODE_TRPC_SPEC = "../../src/console/node-trpc.ts";
const VIEW_SPEC = "../../src/console/views/workloads.tsx";
const PROVIDER_SPEC = "../../src/console/node-scoped-provider.tsx";
const CONSOLE_NODE = "local";

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
    useSubscription: (): Record<string, unknown> => ({}),
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

const mod = (await import(VIEW_SPEC).catch(() => ({}))) as {
  WorkloadsView?: FunctionComponent<{
    route: ConsoleRoute;
    onSuccessToast: (text: string) => void;
  }>;
};
const providerMod = (await import(PROVIDER_SPEC).catch(() => ({}))) as {
  NodeScopedProvider?: ComponentType<{ node: string; baseUrl?: string; children?: ReactNode }>;
};

type WorkloadRow = {
  name: string;
  kind: "ModelRun" | "ModelHost";
  node: string;
  endpoint: string | null;
  workerNodes: string[];
  phase: string;
  rel: string;
  workerCount: number;
  status: unknown;
};

function makeRow(
  name: string,
  kind: "ModelRun" | "ModelHost",
  node: string,
  endpoint: string | null,
  workerNodes: string[],
): WorkloadRow {
  return {
    name,
    kind,
    node,
    endpoint,
    workerNodes,
    phase: "Running",
    rel: "1m",
    workerCount: 1,
    status: { healthy: true },
  };
}

const ROWS: WorkloadRow[] = [
  makeRow("qwen", "ModelRun", "local", "http://127.0.0.1:8080", []),
  makeRow("big", "ModelRun", "local", null, ["w1"]),
  makeRow("omlx", "ModelHost", "local", null, []),
  makeRow("far", "ModelRun", "remote1", null, []),
  makeRow("r1b", "ModelRun", "remote1", null, []),
  makeRow("r2a", "ModelRun", "remote2", null, []),
];

const ALLOWED_PROCEDURES = new Set([
  "workloadList",
  "workloadDescribe",
  "serverStop",
  "serverStatus",
]);

beforeEach(() => {
  accessedProcedures.clear();
  describeCalls.length = 0;
  statusCalls.length = 0;
  stopCalls.length = 0;
  invalidatedKeys.length = 0;
  renderedButtons.length = 0;
  renderedInputs.length = 0;
  consoleNode = CONSOLE_NODE;
  queryResults = { workloadList: ROWS };
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

const toastTexts: string[] = [];
function onSuccessToast(text: string): void {
  toastTexts.push(text);
}

function renderView(route: ConsoleRoute): string {
  renderedButtons.length = 0;
  renderedInputs.length = 0;
  const WorkloadsView = mod.WorkloadsView!;
  const NodeScopedProvider = providerMod.NodeScopedProvider!;
  return renderMarkup(
    createElement(
      NodeScopedProvider,
      { node: "local" },
      createElement(WorkloadsView, { route, onSuccessToast }),
    ),
  );
}

function rowBlock(markup: string, name: string): string | null {
  const marker = `data-testid="console-workload-row-${name}"`;
  const start = markup.indexOf(marker);
  if (start === -1) return null;
  const contentStart = markup.indexOf(">", start) + 1;
  const candidates = [
    markup.indexOf('data-testid="console-workload-row-', contentStart),
    markup.indexOf('data-testid="console-workloads-other-nodes"', contentStart),
  ].filter((index) => index !== -1);
  const end = candidates.length === 0 ? markup.length : Math.min(...candidates);
  return markup.slice(contentStart, end);
}

function linkInner(markup: string, href: string): string | null {
  const hrefIndex = markup.indexOf(`href="${href}"`);
  if (hrefIndex === -1) return null;
  const openEnd = markup.indexOf(">", hrefIndex);
  const closeIndex = markup.indexOf("</a>", openEnd);
  if (openEnd === -1 || closeIndex === -1) return null;
  return markup.slice(openEnd + 1, closeIndex);
}

function rowIds(markup: string): string[] {
  return [...markup.matchAll(/data-testid="console-workload-row-([^"]+)"/g)]
    .map((m) => m[1] ?? "")
    .sort();
}

// Walks the un-rendered element tree WorkloadsView returns and reports
// the React key of the ConsoleWorkloadRowCard for a row name, so the
// popstate remount contract is pinned on the keys themselves rather
// than on markup (keys never reach renderToStaticMarkup).
function cardKeyIn(node: unknown, rowName: string): string | null | undefined {
  if (Array.isArray(node)) {
    const children: unknown[] = node;
    for (const child of children) {
      const key = cardKeyIn(child, rowName);
      if (key !== undefined) return key;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const props = node.props as {
    row?: { name?: unknown };
    initiallyOpen?: unknown;
    children?: unknown;
  };
  if (props.row?.name === rowName && typeof props.initiallyOpen === "boolean") {
    return node.key;
  }
  return cardKeyIn(props.children, rowName);
}

describe("workloads view (#410 P5a-3b)", () => {
  test("only tab-node rows render, each with its console-workload-row testid", () => {
    const WorkloadsView = mod.WorkloadsView;
    expect(typeof WorkloadsView).toBe("function");

    const markup = renderView({ view: "workloads" });
    expect(rowIds(markup)).toEqual(["big", "omlx", "qwen"]);
  });

  test("the footer counts other-node workloads with one sorted link per node", () => {
    const WorkloadsView = mod.WorkloadsView;
    expect(typeof WorkloadsView).toBe("function");

    const markup = renderView({ view: "workloads" });
    expect(markup).toContain('data-testid="console-workloads-other-nodes"');

    const remote1Href = consoleHref({ view: "workloads", node: "remote1" });
    const remote2Href = consoleHref({ view: "workloads", node: "remote2" });

    const link1 = linkInner(markup, remote1Href);
    const link2 = linkInner(markup, remote2Href);
    expect(link1).not.toBeNull();
    expect(link2).not.toBeNull();
    expect(link1 ?? "").toContain("2");
    expect(link2 ?? "").toContain("1");
    expect(markup.indexOf(`href="${remote1Href}"`)).toBeLessThan(
      markup.indexOf(`href="${remote2Href}"`),
    );
    expect(markup.split(`href="${remote1Href}"`)).toHaveLength(2);
    expect(markup.split(`href="${remote2Href}"`)).toHaveLength(2);
  });

  test("StopServerAction renders enabled for qwen, disabled with the worker reason for big, nothing for omlx", () => {
    const WorkloadsView = mod.WorkloadsView;
    expect(typeof WorkloadsView).toBe("function");

    const markup = renderView({ view: "workloads" });

    const stopButtons = renderedButtons.filter((button) => button.children === "Stop");
    expect(stopButtons).toHaveLength(2);
    expect(stopButtons.filter((button) => button.disabled === true)).toHaveLength(1);
    expect(stopButtons.filter((button) => button.disabled !== true)).toHaveLength(1);

    const qwenRow = rowBlock(markup, "qwen");
    const bigRow = rowBlock(markup, "big");
    const omlxRow = rowBlock(markup, "omlx");
    expect(qwenRow).not.toBeNull();
    expect(bigRow).not.toBeNull();
    expect(omlxRow).not.toBeNull();

    const qwenStop = /<button\b[^>]*>Stop<\/button>/.exec(qwenRow ?? "");
    expect(qwenStop).not.toBeNull();
    expect(qwenStop?.[0] ?? "").not.toContain("disabled");

    const bigStop = /<button\b[^>]*>Stop<\/button>/.exec(bigRow ?? "");
    expect(bigStop).not.toBeNull();
    expect(bigStop?.[0] ?? "").toContain("disabled");
    expect(bigRow ?? "").toContain("rpc-server running on w1");

    expect(omlxRow ?? "").not.toContain(">Stop</button>");
  });

  test("the endpoint renders as a safe blank-target link", () => {
    const WorkloadsView = mod.WorkloadsView;
    expect(typeof WorkloadsView).toBe("function");

    const markup = renderView({ view: "workloads" });
    expect(markup).toMatch(
      /<a\b(?=[^>]*href="http:\/\/127\.0\.0\.1:8080")(?=[^>]*target="_blank")(?=[^>]*rel="noopener noreferrer")[^>]*>/,
    );
  });

  test("a deep link to another node's workload shows the switch notice and opens no drawer", () => {
    const WorkloadsView = mod.WorkloadsView;
    expect(typeof WorkloadsView).toBe("function");

    const markup = renderView({ view: "workloads", workload: "far" });
    expect(markup).toContain("This workload runs on remote1. Switch this tab or open a new one");
    const href = consoleHref({ view: "workloads", workload: "far", node: "remote1" });
    expect(markup).toContain(`href="${href}"`);
    expect(rowIds(markup)).toEqual(["big", "omlx", "qwen"]);

    expect(describeCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of describeCalls) {
      expect(call.enabled).toBe(false);
    }
  });

  test("a deep link to a tab-node workload enables exactly its describe query", () => {
    const WorkloadsView = mod.WorkloadsView;
    expect(typeof WorkloadsView).toBe("function");

    renderView({ view: "workloads", workload: "qwen" });

    const enabledCalls = describeCalls.filter((call) => call.enabled === true);
    expect(enabledCalls).toHaveLength(1);
    expect(enabledCalls[0]?.input).toEqual({ name: "qwen" });
    for (const call of describeCalls) {
      if (call.enabled !== true) expect(call.enabled).toBe(false);
    }
  });

  test("a deep link to an unknown workload shows the missing notice and opens no drawer", () => {
    const WorkloadsView = mod.WorkloadsView;
    expect(typeof WorkloadsView).toBe("function");

    const markup = renderView({ view: "workloads", workload: "ghost" });
    expect(markup).toContain("No workload named ghost on any node");
    for (const call of describeCalls) {
      expect(call.enabled).toBe(false);
    }
  });

  test("openWorkloadName follows the route so /workloads/a then /workloads/b opens b", () => {
    expect(openWorkloadName(ROWS, "qwen", "local")).toBe("qwen");
    expect(openWorkloadName(ROWS, "big", "local")).toBe("big");
    expect(openWorkloadName(ROWS, undefined, "local")).toBeNull();
    expect(openWorkloadName(ROWS, "far", "local")).toBeNull();
    expect(openWorkloadName(ROWS, "ghost", "local")).toBeNull();
    expect(openWorkloadName(ROWS, "far", "remote1")).toBe("far");
  });

  test("phaseTone maps each phase bucket to its status tone", () => {
    expect(phaseTone("Running")).toBe("ok");
    expect(phaseTone("Mismatch")).toBe("warn");
    expect(phaseTone("Unreachable")).toBe("err");
    expect(phaseTone("Foreign")).toBe("err");
    expect(phaseTone("Pending")).toBe("idle");
    expect(phaseTone("Unknown")).toBe("idle");
  });

  test("workloadCardKey changes exactly when a route change toggles that card's membership", () => {
    expect(workloadCardKey("qwen", "qwen")).toBe(workloadCardKey("qwen", "qwen"));
    expect(workloadCardKey("qwen", "qwen")).not.toBe(workloadCardKey("qwen", null));
    expect(workloadCardKey("qwen", "qwen")).not.toBe(workloadCardKey("qwen", "big"));
    expect(workloadCardKey("qwen", null)).toBe(workloadCardKey("qwen", "big"));
    expect(workloadCardKey("big", "big")).not.toBe(workloadCardKey("big", "qwen"));
    expect(workloadCardKey("qwen", "qwen")).not.toBe(workloadCardKey("big", "big"));
    expect(workloadCardKey("qwen", null)).not.toBe(workloadCardKey("big", null));
  });

  test("the view keys cards by route membership so a deep-link move remounts exactly those two cards", () => {
    const WorkloadsView = mod.WorkloadsView;
    expect(typeof WorkloadsView).toBe("function");
    if (WorkloadsView === undefined) return;

    const qwenTree = WorkloadsView({
      route: { view: "workloads", workload: "qwen" },
      onSuccessToast,
    });
    const bigTree = WorkloadsView({
      route: { view: "workloads", workload: "big" },
      onSuccessToast,
    });
    const plainTree = WorkloadsView({ route: { view: "workloads" }, onSuccessToast });

    // Reverting the view to key={row.name} pins every card's key to a
    // constant: qwen and big would keep their useState drawer state
    // across the popstate move, and these assertions fail.
    expect(cardKeyIn(qwenTree, "qwen")).toBe(workloadCardKey("qwen", "qwen"));
    expect(cardKeyIn(bigTree, "qwen")).toBe(workloadCardKey("qwen", "big"));
    expect(cardKeyIn(bigTree, "qwen")).not.toBe(cardKeyIn(qwenTree, "qwen"));
    expect(cardKeyIn(qwenTree, "big")).toBe(workloadCardKey("big", "qwen"));
    expect(cardKeyIn(bigTree, "big")).toBe(workloadCardKey("big", "big"));
    expect(cardKeyIn(plainTree, "qwen")).toBe(workloadCardKey("qwen", null));
    expect(cardKeyIn(plainTree, "big")).toBe(workloadCardKey("big", null));
    expect(cardKeyIn(bigTree, "omlx")).toBe(cardKeyIn(qwenTree, "omlx"));
    expect(cardKeyIn(bigTree, "omlx")).toBe(workloadCardKey("omlx", null));
  });

  test("the view touches only the allowed procedures and renders no Delete or Apply actions", () => {
    const WorkloadsView = mod.WorkloadsView;
    expect(typeof WorkloadsView).toBe("function");

    const routes: ConsoleRoute[] = [
      { view: "workloads" },
      { view: "workloads", workload: "far" },
      { view: "workloads", workload: "qwen" },
      { view: "workloads", workload: "ghost" },
    ];
    for (const route of routes) {
      accessedProcedures.clear();
      const markup = renderView(route);
      for (const procedure of accessedProcedures) {
        expect(ALLOWED_PROCEDURES.has(procedure)).toBe(true);
      }
      expect(markup).not.toContain(">Delete<");
      expect(markup).not.toContain(">Apply<");
      for (const button of renderedButtons) {
        if (typeof button.children !== "string") continue;
        expect(button.children).not.toContain("Delete");
        expect(button.children).not.toContain("Apply");
      }
    }
  });
});
