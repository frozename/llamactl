// packages/app/test/console/node-scoped-provider.test.ts
// Issue #410, P3 RED 9 — pins NodeScopedProvider: switching the tab's
// node must remount the QueryClient + tRPC client so a cached result
// from node A can never be served on node B, and scope clients carry
// their node into the request URL.

import type { ComponentType, ReactNode } from "react";

import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { afterAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const PROVIDER_SPEC = "../../src/console/node-scoped-provider.tsx";
const SCOPE_SPEC = "../../src/console/create-node-scope.ts";

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
});
