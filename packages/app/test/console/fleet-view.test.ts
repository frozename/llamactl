// Issue #410 P5a-3c RED — pins the fleet view: one tile per
// nodeList node with per-node nodeTest reachability on a 30s
// refetch, "open in new tab" fleet deep links only for dispatchable
// non-tab nodes, the exposed-workloads list (Running rows with an
// http(s) endpoint only, behind blank-target links) and the
// tab-node card whose env secrets render as "set" — never the raw
// value. Rendered through NodeScopedProvider with react-dom/server
// against the node-scoped tRPC proxy; the view module does not exist
// at the base commit, so every case fails by assertion — never by
// import error.

import type { ComponentType, ReactElement, ReactNode } from "react";

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ConsoleRoute } from "../../src/console/router";

import { consoleHref } from "../../src/console/router";

const NODE_TRPC_SPEC = "../../src/console/node-trpc.ts";
const VIEW_SPEC = "../../src/console/views/fleet.tsx";
const PROVIDER_SPEC = "../../src/console/node-scoped-provider.tsx";
const CONSOLE_NODE = "local";

const hadElectronTRPC = "electronTRPC" in globalThis;
const prevElectronTRPC = globalThis.electronTRPC;
globalThis.electronTRPC ??= {
  sendMessage: (): undefined => undefined,
  onMessage: (): undefined => undefined,
};

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
const queryCalls: { procedure: string; input: unknown; options: unknown }[] = [];
let queryResults: Record<string, unknown> = {};
let consoleNode = CONSOLE_NODE;

function nodeTestName(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const name = (input as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

function queryResult(procedure: string, input: unknown, options: unknown): Record<string, unknown> {
  queryCalls.push({ procedure, input, options });
  let data: unknown = queryResults[procedure];
  if (procedure === "nodeTest") {
    const table = queryResults["nodeTest"];
    const name = nodeTestName(input);
    data =
      typeof table === "object" && table !== null && name !== null
        ? (table as Record<string, unknown>)[name]
        : undefined;
  }
  return {
    data,
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
      mutate: (): void => undefined,
      mutateAsync: (): Promise<unknown> => Promise.resolve({}),
      reset: (): void => undefined,
    }),
    useQuery: (input?: unknown, options?: unknown): Record<string, unknown> =>
      queryResult(procedure, input, options),
    useSubscription: (): Record<string, unknown> => ({}),
    useSuspenseQuery: (input?: unknown, options?: unknown): Record<string, unknown> =>
      queryResult(procedure, input, options),
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
    get: (_target, _key): { invalidate: () => Promise<void> } => ({
      invalidate: (): Promise<void> => Promise.resolve(),
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
  FleetView?: ComponentType<{
    route: ConsoleRoute;
    onSuccessToast: (text: string) => void;
  }>;
};
const providerMod = (await import(PROVIDER_SPEC).catch(() => ({}))) as {
  NodeScopedProvider?: ComponentType<{ node: string; baseUrl?: string; children?: ReactNode }>;
};

const NODE_LIST = {
  defaultNode: "local",
  nodes: [
    { name: "local", endpoint: "inproc://local" },
    { name: "agent-1", endpoint: "https://10.0.0.5:7843", effectiveKind: "agent" },
    { name: "gw", endpoint: "http://gw:8080", effectiveKind: "gateway" },
    { name: "rag1", endpoint: "http://rag:9000", effectiveKind: "rag" },
  ],
};

function makeFacts(nodeName: string): Record<string, unknown> {
  return {
    nodeName,
    hostname: nodeName,
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
}

const WORKLOAD_ROWS = [
  {
    name: "qwen",
    kind: "ModelRun",
    node: "local",
    phase: "Running",
    endpoint: "http://127.0.0.1:18080",
    workerNodes: [],
    rel: "qwen.gguf",
  },
  {
    name: "far",
    kind: "ModelRun",
    node: "agent-1",
    phase: "Running",
    endpoint: "https://10.0.0.5:18080",
    workerNodes: [],
    rel: "far.gguf",
  },
  {
    name: "pending-w",
    kind: "ModelRun",
    node: "local",
    phase: "Pending",
    endpoint: "http://127.0.0.1:9999",
    workerNodes: [],
    rel: "p.gguf",
  },
  {
    name: "no-endpoint-w",
    kind: "ModelRun",
    node: "agent-1",
    phase: "Running",
    endpoint: null,
    workerNodes: [],
    rel: "n.gguf",
  },
];

const ALLOWED_PROCEDURES = new Set(["nodeList", "nodeTest", "workloadList", "env", "nodeFacts"]);

beforeEach(() => {
  accessedProcedures.clear();
  queryCalls.length = 0;
  renderedButtons.length = 0;
  renderedInputs.length = 0;
  consoleNode = CONSOLE_NODE;
  queryResults = {
    nodeList: NODE_LIST,
    nodeTest: {
      local: { ok: true, facts: makeFacts("local") },
      "agent-1": { ok: true, facts: makeFacts("agent-1") },
      gw: { ok: false, error: "connect ECONNREFUSED" },
      rag1: { ok: true, facts: makeFacts("rag1") },
    },
    workloadList: WORKLOAD_ROWS,
    env: { LM_API_TOKEN: "[redacted]", OPENAI_API_KEY: "sk-live-x", LLAMA_CPP_PORT: "8080" },
    nodeFacts: makeFacts("local-mbp"),
  };
});

afterAll(() => {
  void mock.module("@/ui", () => uiReal);
  void mock.module(NODE_TRPC_SPEC, () => nodeTrpcReal);
  if (hadElectronTRPC) {
    globalThis.electronTRPC = prevElectronTRPC;
  } else {
    delete (globalThis as { electronTRPC?: unknown }).electronTRPC;
  }
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

function renderView(): string {
  renderedButtons.length = 0;
  renderedInputs.length = 0;
  const FleetView = mod.FleetView!;
  const NodeScopedProvider = providerMod.NodeScopedProvider!;
  return renderMarkup(
    createElement(
      NodeScopedProvider,
      { node: consoleNode },
      createElement(FleetView, { route: { view: "fleet" }, onSuccessToast }),
    ),
  );
}

function tileBlock(markup: string, name: string): string {
  const marker = `data-testid="console-fleet-node-${name}"`;
  const start = markup.indexOf(marker);
  if (start === -1) return "";
  const contentStart = markup.indexOf(">", start) + 1;
  const rest = markup.slice(contentStart);
  const next = rest.indexOf('data-testid="console-fleet-node-');
  return next === -1 ? rest : rest.slice(0, next);
}

interface AnchorMatch {
  tag: string;
  inner: string;
}

function anchorsWithHref(markup: string, href: string): AnchorMatch[] {
  const needle = `href="${href}"`;
  const matches: AnchorMatch[] = [];
  let hrefIndex = markup.indexOf(needle);
  while (hrefIndex !== -1) {
    const tagStart = markup.lastIndexOf("<a", hrefIndex);
    const openEnd = markup.indexOf(">", hrefIndex);
    const closeIndex = openEnd === -1 ? -1 : markup.indexOf("</a>", openEnd);
    if (
      tagStart !== -1 &&
      openEnd !== -1 &&
      closeIndex !== -1 &&
      /^<a[\s>]/.test(markup.slice(tagStart, tagStart + 3))
    ) {
      matches.push({
        tag: markup.slice(tagStart, openEnd + 1),
        inner: markup.slice(openEnd + 1, closeIndex),
      });
    }
    hrefIndex = markup.indexOf(needle, hrefIndex + needle.length);
  }
  return matches;
}

function blankTarget(anchor: AnchorMatch): boolean {
  return anchor.tag.includes('target="_blank"') && anchor.tag.includes('rel="noopener noreferrer"');
}

function htmlText(html: string): string {
  return html.replaceAll("<!-- -->", "").replaceAll(/<[^>]*>/g, "|");
}

describe("fleet view (#410 P5a-3c)", () => {
  test("renders the fleet view with one node tile per nodeList entry", () => {
    const FleetView = mod.FleetView;
    expect(typeof FleetView).toBe("function");

    const markup = renderView();
    expect(markup).toContain('data-testid="console-view-fleet"');
    for (const name of ["local", "agent-1", "gw", "rag1"]) {
      expect(markup).toContain(`data-testid="console-fleet-node-${name}"`);
    }
  });

  test("queries nodeTest once per node on a 30s refetch interval", () => {
    const FleetView = mod.FleetView;
    expect(typeof FleetView).toBe("function");

    renderView();
    const testCalls = queryCalls.filter((call) => call.procedure === "nodeTest");
    expect(testCalls).toHaveLength(4);
    expect(testCalls.map((call) => nodeTestName(call.input)).sort()).toEqual([
      "agent-1",
      "gw",
      "local",
      "rag1",
    ]);
    for (const call of testCalls) {
      expect(call.input).toEqual({ name: nodeTestName(call.input) });
      const options = call.options as { refetchInterval?: unknown };
      expect(options.refetchInterval).toBe(30000);
    }
  });

  test("the gw tile surfaces its reachability error and never the checking label", () => {
    const FleetView = mod.FleetView;
    expect(typeof FleetView).toBe("function");

    const markup = renderView();
    expect(markup).toContain('data-testid="console-fleet-node-gw"');
    const gwTile = tileBlock(markup, "gw");
    const showsErr =
      gwTile.includes("ECONNREFUSED") ||
      gwTile.includes("var(--color-err)") ||
      gwTile.includes('data-tone="err"');
    expect(showsErr).toBe(true);
    expect(gwTile).not.toContain("checking");
  });

  test("only dispatchable non-tab nodes get an open-in-new-tab fleet link", () => {
    const FleetView = mod.FleetView;
    expect(typeof FleetView).toBe("function");

    const markup = renderView();
    const agentHref = consoleHref({ view: "fleet", node: "agent-1" });
    const match = anchorsWithHref(markup, agentHref).find(
      (anchor) =>
        anchor.inner.includes("Open in new tab on agent-1") &&
        anchor.tag.includes('target="_blank"') &&
        anchor.tag.includes('rel="noopener noreferrer"'),
    );
    expect(match).toBeDefined();
    expect(markup.match(/Open in new tab on /g)).toHaveLength(1);
    expect(markup).not.toContain("Open in new tab on local");
    expect(markup).not.toContain("Open in new tab on gw");
    expect(markup).not.toContain("Open in new tab on rag1");
  });

  test("the exposed list links each Running http(s) endpoint and drops the rest", () => {
    const FleetView = mod.FleetView;
    expect(typeof FleetView).toBe("function");

    const markup = renderView();
    expect(markup).toContain('data-testid="console-fleet-exposed"');
    const exposedIdx = markup.indexOf('data-testid="console-fleet-exposed"');
    const exposedBlock = markup.slice(exposedIdx);
    for (const endpoint of ["http://127.0.0.1:18080", "https://10.0.0.5:18080"]) {
      const linked = anchorsWithHref(exposedBlock, endpoint).some(blankTarget);
      expect(linked).toBe(true);
    }
    expect(exposedBlock).toMatch(/\bqwen\b/);
    expect(exposedBlock).toMatch(/\bfar\b/);
    expect(markup).not.toContain("pending-w");
    expect(markup).not.toContain("no-endpoint-w");
    expect(markup).not.toContain("http://127.0.0.1:9999");
  });

  test("the tab-node card shows facts and renders env secrets as set", () => {
    const FleetView = mod.FleetView;
    expect(typeof FleetView).toBe("function");

    const markup = renderView();
    expect(markup).toContain('data-testid="console-fleet-tab-node"');
    const cardIdx = markup.indexOf('data-testid="console-fleet-tab-node"');
    const cardText = htmlText(markup.slice(cardIdx));
    expect(cardText).toContain("local-mbp");
    expect(cardText).toContain("darwin-arm64");
    expect(cardText).toMatch(/LM_API_TOKEN[^A-Za-z0-9]{0,80}set[^A-Za-z0-9]/);
    expect(cardText).toMatch(/OPENAI_API_KEY[^A-Za-z0-9]{0,80}set[^A-Za-z0-9]/);
    expect(cardText).toMatch(/LLAMA_CPP_PORT[^A-Za-z0-9]{0,80}8080[^A-Za-z0-9]/);
    expect(markup).not.toContain("[redacted]");
    expect(markup).not.toContain("sk-live-x");
  });

  test("the view touches only the fleet-allowed procedures", () => {
    const FleetView = mod.FleetView;
    expect(typeof FleetView).toBe("function");

    renderView();
    for (const procedure of accessedProcedures) {
      expect(ALLOWED_PROCEDURES.has(procedure)).toBe(true);
    }
    for (const procedure of ALLOWED_PROCEDURES) {
      expect(accessedProcedures.has(procedure)).toBe(true);
    }
  });
});
