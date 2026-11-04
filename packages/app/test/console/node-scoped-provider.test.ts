// packages/app/test/console/node-scoped-provider.test.ts
// Issue #410, P3 RED 9 — pins NodeScopedProvider: switching the tab's
// node must remount the QueryClient + tRPC client so a cached result
// from node A can never be served on node B, and scope clients carry
// their node into the request URL.

import type { ComponentType, ReactNode } from "react";
import type { Root } from "react-dom/client";

import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { afterAll, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const PROVIDER_SPEC = "../../src/console/node-scoped-provider.tsx";
const SCOPE_SPEC = "../../src/console/create-node-scope.ts";
const TRPC_SPEC = "../../src/lib/trpc";

// The provider imports src/lib/trpc, which builds an IPC UI client at
// eval time; without the preload bridge global that eval throws before
// any expect can fail, so stub the bridge first and restore it after.
const hadElectronTRPC = "electronTRPC" in globalThis;
const prevElectronTRPC = globalThis.electronTRPC;
globalThis.electronTRPC ??= {
  sendMessage: (): undefined => undefined,
  onMessage: (): undefined => undefined,
};

afterAll(() => {
  if (hadElectronTRPC) globalThis.electronTRPC = prevElectronTRPC;
  else delete (globalThis as { electronTRPC?: unknown }).electronTRPC;
});

type FetchInput = string | URL | Request;
type FakeFetch = (input: FetchInput, init?: RequestInit) => Promise<Response>;

interface NodeScope {
  queryClient: QueryClient;
  client: unknown;
}

interface NodeScopedProviderModule {
  NodeScopedProvider?: ComponentType<{ node: string; baseUrl: string; children?: ReactNode }>;
}

interface CreateNodeScopeModule {
  createNodeScope?: (opts: {
    node: string;
    baseUrl: string;
    fetch?: FakeFetch;
    EventSource?: unknown;
  }) => NodeScope;
}

interface TrpcHooksModule {
  trpc: {
    useUtils: () => { client: unknown };
  };
}

interface UntypedProcedures {
  serverStatus: { query: (input?: unknown) => Promise<unknown> };
}

class FakeEventSource {
  readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readyState = 0;

  addEventListener(): undefined {
    return undefined;
  }

  removeEventListener(): undefined {
    return undefined;
  }

  close(): void {
    this.readyState = this.CLOSED;
  }
}

async function importProviderModule(): Promise<NodeScopedProviderModule | null> {
  return (await import(PROVIDER_SPEC).catch(() => null)) as NodeScopedProviderModule | null;
}

async function importScopeModule(): Promise<CreateNodeScopeModule | null> {
  return (await import(SCOPE_SPEC).catch(() => null)) as CreateNodeScopeModule | null;
}

function makeRecordingFetch(): {
  calls: string[];
  fakeFetch: FakeFetch;
} {
  const calls: string[] = [];
  const fakeFetch: FakeFetch = (input) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    calls.push(url);
    return Promise.resolve(
      new Response(JSON.stringify([{ result: { data: 1 } }]), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { calls, fakeFetch };
}

// Bun has no DOM, so the mounted-root test below feeds react-dom/client
// the minimal element/document/window surface it touches while mounting
// and committing a provider-only tree (no host nodes are ever created,
// listeners are registered and never dispatched).
interface ShimEventTargetLike {
  addEventListener: (_type: string, _listener: unknown, _options?: unknown) => void;
  removeEventListener: (_type: string, _listener: unknown, _options?: unknown) => void;
}

interface ShimElementLike extends ShimEventTargetLike {
  nodeType: number;
  nodeName: string;
  tagName: string;
  ownerDocument: ShimDocumentLike | null;
  setAttribute: (_name: string, _value: string) => void;
  style: Record<string, string>;
}

interface ShimTextLike extends ShimEventTargetLike {
  nodeType: number;
  textContent: string;
  ownerDocument: ShimDocumentLike | null;
}

interface ShimDocumentLike extends ShimEventTargetLike {
  nodeType: number;
  visibilityState: string;
  defaultView: ShimWindowLike | null;
  documentElement: ShimElementLike;
  createElement: (_tagName: string) => ShimElementLike;
  createTextNode: (_text: string) => ShimTextLike;
}

interface ShimWindowLike extends ShimEventTargetLike {
  document: ShimDocumentLike;
  HTMLIFrameElement: new () => unknown;
  requestAnimationFrame: (_callback: () => void) => number;
  cancelAnimationFrame: (_handle: number) => void;
}

function makeShimTarget(): ShimEventTargetLike {
  return {
    addEventListener: (): undefined => undefined,
    removeEventListener: (): undefined => undefined,
  };
}

function makeShimWindow(): {
  window: ShimWindowLike;
  clearPendingFrames: () => void;
} {
  const frames = new Set<number>();
  const doc: ShimDocumentLike = {
    ...makeShimTarget(),
    nodeType: 9,
    visibilityState: "visible",
    defaultView: null,
    documentElement: undefined as unknown as ShimElementLike,
    createElement: (): ShimElementLike => ({
      ...makeShimTarget(),
      nodeType: 1,
      nodeName: "DIV",
      tagName: "DIV",
      ownerDocument: doc,
      setAttribute: (): undefined => undefined,
      style: {},
    }),
    createTextNode: (text: string): ShimTextLike => ({
      ...makeShimTarget(),
      nodeType: 3,
      textContent: text,
      ownerDocument: doc,
    }),
  };
  const win: ShimWindowLike = {
    ...makeShimTarget(),
    document: doc,
    HTMLIFrameElement: class ShimIFrame {
      readonly shim = true;
    },
    requestAnimationFrame: (callback: () => void): number => {
      const handle = setTimeout(() => {
        frames.delete(handle);
        callback();
      }, 16) as unknown as number;
      frames.add(handle);
      return handle;
    },
    cancelAnimationFrame: (handle: number): void => {
      frames.delete(handle);
      clearTimeout(handle);
    },
  };
  doc.defaultView = win;
  doc.documentElement = win.document.createElement("div");
  return {
    window: win,
    clearPendingFrames: (): void => {
      for (const handle of frames) clearTimeout(handle);
      frames.clear();
    },
  };
}

describe("NodeScopedProvider (#410 P3)", () => {
  test("exports createNodeScope and NodeScopedProvider", async () => {
    const provider = await importProviderModule();
    const scope = await importScopeModule();
    expect(scope?.createNodeScope).toBeFunction();
    expect(provider?.NodeScopedProvider).toBeFunction();
  });

  test("two scopes get independent QueryClients and no cache bleed", async () => {
    const mod = await importScopeModule();
    expect(mod?.createNodeScope).toBeFunction();
    const createNodeScope = mod!.createNodeScope!;
    const { fakeFetch } = makeRecordingFetch();

    const scopeA = createNodeScope({
      node: "a",
      baseUrl: "/api",
      fetch: fakeFetch,
      EventSource: FakeEventSource,
    });
    const scopeB = createNodeScope({
      node: "b",
      baseUrl: "/api",
      fetch: fakeFetch,
      EventSource: FakeEventSource,
    });

    expect(scopeA.queryClient).not.toBe(scopeB.queryClient);
    scopeA.queryClient.setQueryData(["env"], { from: "a" });
    const cachedB: unknown = scopeB.queryClient.getQueryData(["env"]);
    expect(cachedB).toBeUndefined();
  });

  test("scope clients carry their node into the request URL", async () => {
    const mod = await importScopeModule();
    expect(mod?.createNodeScope).toBeFunction();
    const createNodeScope = mod!.createNodeScope!;
    const { calls, fakeFetch } = makeRecordingFetch();

    const scopeA = createNodeScope({
      node: "a",
      baseUrl: "/api",
      fetch: fakeFetch,
      EventSource: FakeEventSource,
    });
    const scopeB = createNodeScope({
      node: "b",
      baseUrl: "/api",
      fetch: fakeFetch,
      EventSource: FakeEventSource,
    });

    await (scopeA.client as UntypedProcedures).serverStatus.query({ workload: "w1" }).then(
      (v) => ({ v }),
      (e: unknown) => ({ e }),
    );
    await (scopeB.client as UntypedProcedures).serverStatus.query({ workload: "w1" }).then(
      (v) => ({ v }),
      (e: unknown) => ({ e }),
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]!.startsWith("/api/n/a/trpc/serverStatus")).toBe(true);
    expect(calls[1]!.startsWith("/api/n/b/trpc/serverStatus")).toBe(true);
  });

  test("switching nodes remounts the QueryClient", async () => {
    const mod = await importProviderModule();
    expect(mod?.NodeScopedProvider).toBeFunction();
    const NodeScopedProvider = mod!.NodeScopedProvider!;

    const captured: QueryClient[] = [];
    function Capture(): ReactNode {
      captured.push(useQueryClient());
      return null;
    }

    renderToStaticMarkup(
      createElement(NodeScopedProvider, { node: "a", baseUrl: "/api" }, createElement(Capture)),
    );
    renderToStaticMarkup(
      createElement(NodeScopedProvider, { node: "b", baseUrl: "/api" }, createElement(Capture)),
    );

    expect(captured).toHaveLength(2);
    expect(captured[0]).toBeInstanceOf(QueryClient);
    expect(captured[1]).toBeInstanceOf(QueryClient);
    expect(captured[0]).not.toBe(captured[1]);
  });

  test("one mounted provider re-rendered with a new node swaps client, cache and request path", async () => {
    const providerMod = await importProviderModule();
    expect(providerMod?.NodeScopedProvider).toBeFunction();
    const NodeScopedProvider = providerMod!.NodeScopedProvider!;
    const trpcMod = (await import(TRPC_SPEC).catch(() => null)) as TrpcHooksModule | null;
    expect(trpcMod?.trpc).toBeDefined();
    const trpc = trpcMod!.trpc;

    const queryClients: QueryClient[] = [];
    const trpcClients: unknown[] = [];
    function Capture(): ReactNode {
      queryClients.push(useQueryClient());
      trpcClients.push(trpc.useUtils().client);
      return null;
    }

    // The mounted root needs window + document before react-dom/client
    // is evaluated; the provider creates its scope with the ambient
    // fetch, so the recording fetch must be installed before mount.
    const globals = globalThis as Record<string, unknown>;
    const hadWindow = "window" in globals;
    const hadDocument = "document" in globals;
    const hadActEnvironment = "IS_REACT_ACT_ENVIRONMENT" in globals;
    const previousWindow = globals["window"];
    const previousDocument = globals["document"];
    const previousActEnvironment = globals["IS_REACT_ACT_ENVIRONMENT"];
    const previousFetch = globalThis.fetch;
    const { calls, fakeFetch } = makeRecordingFetch();
    const shim = makeShimWindow();
    globals["window"] = shim.window;
    globals["document"] = shim.window.document;
    globals["IS_REACT_ACT_ENVIRONMENT"] = true;
    globalThis.fetch = fakeFetch as unknown as typeof globalThis.fetch;

    let root: Root | undefined;
    try {
      const { createRoot } = await import("react-dom/client");
      root = createRoot(shim.window.document.createElement("div") as unknown as Element);

      await act(() => {
        root?.render(
          createElement(NodeScopedProvider, { node: "a", baseUrl: "/api" }, createElement(Capture)),
        );
        return Promise.resolve();
      });
      await act(() => {
        root?.render(
          createElement(NodeScopedProvider, { node: "b", baseUrl: "/api" }, createElement(Capture)),
        );
        return Promise.resolve();
      });

      expect(queryClients).toHaveLength(2);
      expect(queryClients[0]).toBeInstanceOf(QueryClient);
      expect(queryClients[1]).toBeInstanceOf(QueryClient);
      expect(queryClients[0]).not.toBe(queryClients[1]);
      expect(trpcClients[0]).toBeDefined();
      expect(trpcClients[0]).not.toBe(trpcClients[1]);

      await (trpcClients[1] as UntypedProcedures).serverStatus.query({ workload: "w1" }).then(
        (v) => ({ v }),
        (e: unknown) => ({ e }),
      );

      expect(calls.length).toBeGreaterThan(0);
      expect(calls[calls.length - 1]!.startsWith("/api/n/b/trpc")).toBe(true);
    } finally {
      // Tear the root down *inside* act while the shim is still
      // installed: scheduler work left pending after teardown would run
      // against a missing window ("window is not defined") between
      // tests and keep handles open past the suite. Flush a macrotask
      // so effects + the scheduler drain, then kill any rAF timers the
      // shim scheduled, and only then restore every global it replaced.
      if (root) {
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
      shim.clearPendingFrames();
      globalThis.fetch = previousFetch;
      if (hadActEnvironment) globals["IS_REACT_ACT_ENVIRONMENT"] = previousActEnvironment;
      else delete globals["IS_REACT_ACT_ENVIRONMENT"];
      if (hadDocument) globals["document"] = previousDocument;
      else delete globals["document"];
      if (hadWindow) globals["window"] = previousWindow;
      else delete globals["window"];
    }
  });
});
