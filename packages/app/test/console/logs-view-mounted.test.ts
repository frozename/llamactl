// Issue #410 P5a-3d gate-flap pin — mounts the console logs stream through
// react-dom/client (test/console/dom-shim.ts) so the component's effects
// actually run: renderToStaticMarkup never does, so neither the gate-off
// dispatch (online -> offline/error) nor the stream-start buffer reset in
// onStarted is observed by the SSR suite. Per flap the stub client closes
// the tail on skipToken and, on the next online render, calls onStarted
// and replays lines a,b,c; the committed buffer must end at exactly three
// lines behind one divider — never six replayed lines, never a missing
// divider.

import type { FunctionComponent, ReactElement, ReactNode } from "react";
import type { Root } from "react-dom/client";

import { skipToken } from "@tanstack/react-query";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";

import type { ConsoleRoute } from "../../src/console/router";

import { installDomShim } from "./dom-shim";

const NODE_TRPC_SPEC = "../../src/console/node-trpc.ts";
const VIEW_SPEC = "../../src/console/views/logs.tsx";
const CONSOLE_NODE = "local";
const REPLAY_LINES = ["a", "b", "c"] as const;

type StatusGate = "error" | "offline" | "online";

interface StubButtonProps {
  children?: ReactNode;
}

function ButtonStub(props: StubButtonProps): ReactElement {
  return createElement("button", { type: "button" }, props.children);
}

const uiReal = { ...(await import("../../src/ui/index")) };
const nodeTrpcReal = { ...(await import("../../src/console/node-trpc.ts")) };

interface SubscriptionOptions {
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

const LOG_ROWS: LogsViewRow[] = [
  { name: "qwen", kind: "ModelRun", node: "local", endpoint: null, workerNodes: [] },
];

let statusData: unknown = { state: "up" };
let statusIsError = false;
let subscriptionOpen = false;
let openOptions: SubscriptionOptions | null = null;

function procedureStub(procedure: string): Record<string, unknown> {
  return {
    useQuery: (): Record<string, unknown> => {
      if (procedure === "workloadList") {
        return {
          data: LOG_ROWS,
          error: null,
          isError: false,
          isLoading: false,
          isPending: false,
          isSuccess: true,
        };
      }
      if (procedure === "serverStatus") {
        return {
          data: statusData,
          error: null,
          isError: statusIsError,
          isLoading: false,
          isPending: !statusIsError && statusData === undefined,
          isSuccess: statusData !== undefined && !statusIsError,
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
        if (input === undefined || input === skipToken) {
          subscriptionOpen = false;
          openOptions = null;
        } else {
          subscriptionOpen = true;
          openOptions = options ?? null;
        }
      }
      return { status: subscriptionOpen ? "pending" : "idle", error: null, data: undefined };
    },
  };
}

const trpcStub = new Proxy<Record<string, unknown>>(
  {},
  {
    get: (_target, property): unknown => {
      if (typeof property !== "string") {
        return undefined;
      }
      return procedureStub(property);
    },
  },
);

const utilsStub = new Proxy<Record<string, { invalidate: () => Promise<void> }>>(
  {},
  {
    get: (): { invalidate: () => Promise<void> } => ({
      invalidate: (): Promise<void> => Promise.resolve(),
    }),
  },
);

void mock.module("@/ui", () => ({ ...uiReal, Button: ButtonStub }));
void mock.module(NODE_TRPC_SPEC, () => ({
  ...nodeTrpcReal,
  useConsoleNode: (): string => CONSOLE_NODE,
  useNodeTrpc: (): unknown => trpcStub,
  useNodeTrpcUtils: (): unknown => utilsStub,
}));

const mod = (await import(VIEW_SPEC).catch(() => ({}))) as {
  LogsView?: FunctionComponent<{
    route: ConsoleRoute;
    onSelectWorkload: (workload: string) => void;
  }>;
};
const LogsView = mod.LogsView!;

beforeEach(() => {
  statusData = { state: "up" };
  statusIsError = false;
  subscriptionOpen = false;
  openOptions = null;
});

afterAll(() => {
  void mock.module("@/ui", () => uiReal);
  void mock.module(NODE_TRPC_SPEC, () => nodeTrpcReal);
});

function setStatus(gate: StatusGate): void {
  if (gate === "error") {
    statusData = undefined;
    statusIsError = true;
    return;
  }
  statusIsError = false;
  statusData = gate === "offline" ? { state: "down" } : { state: "up" };
}

function logsElement(): ReactElement {
  return createElement(LogsView, {
    route: { view: "logs" },
    onSelectWorkload: (): void => undefined,
  });
}

async function renderInto(root: Root): Promise<void> {
  await act(() => {
    root.render(logsElement());
    return Promise.resolve();
  });
}

function requireOptions(): SubscriptionOptions {
  if (openOptions === null) {
    throw new Error("logs stream stub: expected an open serverLogs subscription");
  }
  return openOptions;
}

async function feedStream(options: SubscriptionOptions): Promise<void> {
  await act(() => {
    options.onStarted?.();
    for (const line of REPLAY_LINES) {
      options.onData?.({ type: "line", line });
    }
    return Promise.resolve();
  });
}

function testIdTexts(container: Element, testId: string): string[] {
  return Array.from(container.querySelectorAll(`[data-testid="${testId}"]`)).map(
    (element) => element.textContent,
  );
}

function countTestId(container: Element, testId: string): number {
  return container.querySelectorAll(`[data-testid="${testId}"]`).length;
}

async function mountFlapAndAssert(midGate: StatusGate): Promise<void> {
  expect(typeof LogsView).toBe("function");
  const noticeTestId = midGate === "offline" ? "console-logs-offline" : "console-logs-gate-error";

  const shim = installDomShim();
  let root: Root | undefined;
  try {
    const { createRoot } = await import("react-dom/client");
    const container = shim.document.createElement("div");
    root = createRoot(container);

    setStatus("online");
    await renderInto(root);
    expect(subscriptionOpen).toBe(true);
    await feedStream(requireOptions());
    expect(testIdTexts(container, "console-logs-line")).toEqual([...REPLAY_LINES]);
    expect(countTestId(container, "console-logs-divider")).toBe(0);

    setStatus(midGate);
    await renderInto(root);
    expect(subscriptionOpen).toBe(false);
    expect(countTestId(container, noticeTestId)).toBe(1);
    expect(countTestId(container, "console-logs-line")).toBe(0);

    setStatus("online");
    await renderInto(root);
    expect(subscriptionOpen).toBe(true);
    await feedStream(requireOptions());

    expect(testIdTexts(container, "console-logs-line")).toEqual([...REPLAY_LINES]);
    expect(countTestId(container, "console-logs-divider")).toBe(1);
  } finally {
    // Tear the root down *inside* act while the shim is still installed,
    // flush one macrotask so the scheduler drains, then let the shim
    // cancel its rAF timers and restore every global it replaced.
    if (root !== undefined) {
      const mountedRoot = root;
      await act(() => {
        mountedRoot.unmount();
        return Promise.resolve();
      });
    }
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 0);
    });
    shim.uninstall();
  }
}

describe("mounted logs stream gate flap (#410 P5a-3d)", () => {
  test("online -> offline -> online replays into a fresh buffer: 3 lines, 1 divider", async () => {
    await mountFlapAndAssert("offline");
  });

  test("online -> status-error -> online replays into a fresh buffer: 3 lines, 1 divider", async () => {
    await mountFlapAndAssert("error");
  });
});
