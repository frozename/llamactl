// Issue #410 P5a-3c RED — pins the nodes view: one row per
// nodeList node with its kind, a "default" badge on the default
// node only, http(s) endpoints as blank-target links while the
// inproc endpoint stays text, and a per-row reachability dot driven
// by nodeTest on a 30s refetch. The view must also schedule no
// intervals or long timeouts during render, and neither it nor the
// fleet view may contain timer calls in source. Rendered through
// NodeScopedProvider with react-dom/server against the node-scoped
// tRPC proxy; the view module does not exist at the base commit, so
// every case fails by assertion — never by import error.

import type { ComponentType, ReactElement, ReactNode } from "react";

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ConsoleRoute } from "../../src/console/router";

const NODE_TRPC_SPEC = "../../src/console/node-trpc.ts";
const VIEW_SPEC = "../../src/console/views/nodes.tsx";
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
  NodesView?: ComponentType<{
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

const ALLOWED_PROCEDURES = new Set(["nodeList", "nodeTest"]);

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
  };
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

function onSuccessToast(_text: string): void {
  // Nodes view has no mutations; the prop exists only for signature parity.
}

function renderView(): string {
  renderedButtons.length = 0;
  renderedInputs.length = 0;
  const NodesView = mod.NodesView!;
  const NodeScopedProvider = providerMod.NodeScopedProvider!;
  return renderMarkup(
    createElement(
      NodeScopedProvider,
      { node: consoleNode },
      createElement(NodesView, { route: { view: "nodes" }, onSuccessToast }),
    ),
  );
}

function rowBlock(markup: string, name: string): string {
  const marker = `data-testid="console-node-row-${name}"`;
  const start = markup.indexOf(marker);
  if (start === -1) return "";
  const contentStart = markup.indexOf(">", start) + 1;
  const rest = markup.slice(contentStart);
  const next = rest.indexOf('data-testid="console-node-row-');
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

function showsErr(row: string): boolean {
  return (
    row.includes("ECONNREFUSED") ||
    row.includes("var(--color-err)") ||
    row.includes('data-tone="err"')
  );
}

function showsOk(row: string): boolean {
  return (
    row.includes("reachable") || row.includes("var(--color-ok)") || row.includes('data-tone="ok"')
  );
}

async function readViewSource(specifier: string): Promise<string> {
  try {
    return await Bun.file(new URL(specifier, import.meta.url)).text();
  } catch {
    return "";
  }
}

describe("nodes view (#410 P5a-3c)", () => {
  test("renders the nodes view with one row per node showing kind and the default badge", () => {
    const NodesView = mod.NodesView;
    expect(typeof NodesView).toBe("function");

    const markup = renderView();
    const clean = markup.replaceAll("<!-- -->", "");
    expect(markup).toContain('data-testid="console-view-nodes"');
    for (const name of ["local", "agent-1", "gw", "rag1"]) {
      expect(markup).toContain(`data-testid="console-node-row-${name}"`);
    }
    expect(rowBlock(clean, "local")).toMatch(/>\s*agent\s*</);
    expect(rowBlock(clean, "agent-1")).toMatch(/>\s*agent\s*</);
    expect(rowBlock(clean, "gw")).toMatch(/>\s*gateway\s*</);
    expect(rowBlock(clean, "rag1")).toMatch(/>\s*rag\s*</);
    expect(rowBlock(clean, "local")).toMatch(/>\s*default\s*</i);
    expect(rowBlock(clean, "agent-1")).not.toMatch(/>\s*default\s*</i);
    expect(rowBlock(clean, "gw")).not.toMatch(/>\s*default\s*</i);
    expect(rowBlock(clean, "rag1")).not.toMatch(/>\s*default\s*</i);
  });

  test("renders http(s) endpoints as blank-target links and inproc as text", () => {
    const NodesView = mod.NodesView;
    expect(typeof NodesView).toBe("function");

    const markup = renderView();
    const agentLinks = anchorsWithHref(rowBlock(markup, "agent-1"), "https://10.0.0.5:7843");
    expect(
      agentLinks.some(
        (anchor) =>
          anchor.tag.includes('target="_blank"') &&
          anchor.tag.includes('rel="noopener noreferrer"'),
      ),
    ).toBe(true);

    const localRow = rowBlock(markup, "local");
    expect(localRow).toContain("inproc://local");
    expect(localRow).not.toContain('href="inproc://local"');
    expect(markup).not.toContain('href="inproc://local"');
    expect(rowBlock(markup, "gw")).toContain("http://gw:8080");
    expect(rowBlock(markup, "rag1")).toContain("http://rag:9000");
  });

  test("each row shows nodeTest reachability on a 30s refetch; gw is err, the rest ok", () => {
    const NodesView = mod.NodesView;
    expect(typeof NodesView).toBe("function");

    const markup = renderView();
    const clean = markup.replaceAll("<!-- -->", "");
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
    expect(showsErr(rowBlock(clean, "gw"))).toBe(true);
    expect(showsOk(rowBlock(clean, "agent-1"))).toBe(true);
    expect(showsOk(rowBlock(clean, "local"))).toBe(true);
    expect(showsOk(rowBlock(clean, "rag1"))).toBe(true);
  });

  test("the view touches only nodeList and nodeTest", () => {
    const NodesView = mod.NodesView;
    expect(typeof NodesView).toBe("function");

    renderView();
    for (const procedure of accessedProcedures) {
      expect(ALLOWED_PROCEDURES.has(procedure)).toBe(true);
    }
    expect(accessedProcedures.has("nodeList")).toBe(true);
    expect(accessedProcedures.has("nodeTest")).toBe(true);
  });

  test("the nodes view schedules no intervals or long timeouts during render", () => {
    const NodesView = mod.NodesView;
    expect(typeof NodesView).toBe("function");

    const realSetInterval = globalThis.setInterval;
    const realSetTimeout = globalThis.setTimeout;
    let intervalCalls = 0;
    const slowTimeouts: number[] = [];
    globalThis.setInterval = ((...args: unknown[]) => {
      intervalCalls += 1;
      return Reflect.apply(realSetInterval, globalThis, args) as number;
    }) as unknown as typeof setInterval;
    globalThis.setTimeout = ((...args: unknown[]) => {
      const delay: unknown = args[1];
      if (typeof delay === "number" && delay >= 1000) {
        slowTimeouts.push(delay);
      }
      return Reflect.apply(realSetTimeout, globalThis, args) as number;
    }) as unknown as typeof setTimeout;
    let markup = "";
    try {
      markup = renderView();
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.setTimeout = realSetTimeout;
    }
    expect(markup).toContain('data-testid="console-view-nodes"');
    expect(intervalCalls).toBe(0);
    expect(slowTimeouts).toEqual([]);
  });

  test("neither the nodes nor the fleet view source contains timer calls", async () => {
    const NodesView = mod.NodesView;
    expect(typeof NodesView).toBe("function");

    const nodesSource = await readViewSource("../../src/console/views/nodes.tsx");
    const fleetSource = await readViewSource("../../src/console/views/fleet.tsx");
    for (const source of [nodesSource, fleetSource]) {
      expect(source).not.toContain("setInterval");
      expect(source).not.toContain("setTimeout");
    }
  });
});
