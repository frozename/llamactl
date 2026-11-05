// packages/app/test/console/node-trpc.test.ts
// Issue #410, P5a-3a RED — pins the console node-scoped tRPC hooks.
// Console sources must reach the tab's tRPC client through
// useNodeTrpc()/useNodeTrpcUtils() instead of the module-global trpc
// proxy, and the hooks must refuse to run outside NodeScopedProvider —
// a bare call throws an error naming the provider rather than silently
// falling back to the global client. The module does not exist at the
// base commit, so every case fails by assertion through the
// import-catch pattern — never by import error.

import type { ComponentType, ReactNode } from "react";

import { afterAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const SPEC = "../../src/console/node-trpc.ts";
const PROVIDER_SPEC = "../../src/console/node-scoped-provider.tsx";
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

interface NodeScopedProviderModule {
  NodeScopedProvider?: ComponentType<{ node: string; baseUrl: string; children?: ReactNode }>;
}

interface NodeTrpcModule {
  ConsoleNodeContext?: unknown;
  useConsoleNode?: () => string;
  useNodeTrpc?: () => unknown;
  useNodeTrpcUtils?: () => { client: unknown };
}

interface TrpcModule {
  trpc: unknown;
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

async function importNodeTrpcModule(): Promise<NodeTrpcModule | null> {
  return (await import(SPEC).catch(() => null)) as NodeTrpcModule | null;
}

async function importProviderModule(): Promise<NodeScopedProviderModule | null> {
  return (await import(PROVIDER_SPEC).catch(() => null)) as NodeScopedProviderModule | null;
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

describe("console node-trpc hooks (#410 P5a-3a)", () => {
  test("exports the node-scoped hooks and the context object", async () => {
    const mod = await importNodeTrpcModule();
    expect(mod?.useConsoleNode).toBeFunction();
    expect(mod?.useNodeTrpc).toBeFunction();
    expect(mod?.useNodeTrpcUtils).toBeFunction();
    expect(typeof mod?.ConsoleNodeContext).toBe("object");
  });

  test("useConsoleNode throws naming NodeScopedProvider with no provider", async () => {
    const mod = await importNodeTrpcModule();
    expect(mod?.useConsoleNode).toBeFunction();
    const useConsoleNode = mod!.useConsoleNode!;

    function Capture(): ReactNode {
      useConsoleNode();
      return null;
    }

    expect(() => renderToStaticMarkup(createElement(Capture))).toThrow(/NodeScopedProvider/);
  });

  test("useNodeTrpc throws naming NodeScopedProvider with no provider", async () => {
    const mod = await importNodeTrpcModule();
    expect(mod?.useNodeTrpc).toBeFunction();
    const useNodeTrpc = mod!.useNodeTrpc!;

    function Capture(): ReactNode {
      useNodeTrpc();
      return null;
    }

    expect(() => renderToStaticMarkup(createElement(Capture))).toThrow(/NodeScopedProvider/);
  });

  test("useConsoleNode returns the provider's node on each render", async () => {
    const providerMod = await importProviderModule();
    expect(providerMod?.NodeScopedProvider).toBeFunction();
    const mod = await importNodeTrpcModule();
    expect(mod?.useConsoleNode).toBeFunction();
    const NodeScopedProvider = providerMod!.NodeScopedProvider!;
    const useConsoleNode = mod!.useConsoleNode!;

    const captured: string[] = [];
    function Capture(): ReactNode {
      captured.push(useConsoleNode());
      return null;
    }

    renderToStaticMarkup(
      createElement(NodeScopedProvider, { node: "a", baseUrl: "/api" }, createElement(Capture)),
    );
    renderToStaticMarkup(
      createElement(NodeScopedProvider, { node: "b", baseUrl: "/api" }, createElement(Capture)),
    );

    expect(captured).toEqual(["a", "b"]);
  });

  test("useNodeTrpcUtils reaches the provider node's trpc mount", async () => {
    const providerMod = await importProviderModule();
    expect(providerMod?.NodeScopedProvider).toBeFunction();
    const mod = await importNodeTrpcModule();
    expect(mod?.useNodeTrpcUtils).toBeFunction();
    const NodeScopedProvider = providerMod!.NodeScopedProvider!;
    const useNodeTrpcUtils = mod!.useNodeTrpcUtils!;

    // The provider builds its scope from the ambient fetch at render
    // time, so the recording fetch (and the dead-end EventSource for
    // the subscription leg) must be installed before the render.
    const globals = globalThis as Record<string, unknown>;
    const hadEventSource = "EventSource" in globals;
    const previousEventSource = globals["EventSource"];
    const previousFetch = globalThis.fetch;
    const { calls, fakeFetch } = makeRecordingFetch();
    globals["EventSource"] = FakeEventSource;
    globalThis.fetch = fakeFetch as unknown as typeof globalThis.fetch;

    try {
      const captured: unknown[] = [];
      function Capture(): ReactNode {
        captured.push(useNodeTrpcUtils().client);
        return null;
      }

      renderToStaticMarkup(
        createElement(NodeScopedProvider, { node: "b", baseUrl: "/api" }, createElement(Capture)),
      );
      expect(captured).toHaveLength(1);

      const client = captured[0] as UntypedProcedures;
      await client.serverStatus.query({ workload: "w1" }).then(
        (v) => ({ v }),
        (e: unknown) => ({ e }),
      );

      expect(calls.length).toBeGreaterThan(0);
      expect(calls[calls.length - 1]!.startsWith("/api/n/b/trpc/serverStatus")).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
      if (hadEventSource) globals["EventSource"] = previousEventSource;
      else delete globals["EventSource"];
    }
  });

  test("useNodeTrpc returns the shared trpc proxy by identity", async () => {
    const providerMod = await importProviderModule();
    expect(providerMod?.NodeScopedProvider).toBeFunction();
    const mod = await importNodeTrpcModule();
    expect(mod?.useNodeTrpc).toBeFunction();
    const trpcMod = (await import(TRPC_SPEC).catch(() => null)) as TrpcModule | null;
    expect(trpcMod?.trpc).toBeDefined();
    const NodeScopedProvider = providerMod!.NodeScopedProvider!;
    const useNodeTrpc = mod!.useNodeTrpc!;

    const captured: unknown[] = [];
    function Capture(): ReactNode {
      captured.push(useNodeTrpc());
      return null;
    }

    renderToStaticMarkup(
      createElement(NodeScopedProvider, { node: "a", baseUrl: "/api" }, createElement(Capture)),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe(trpcMod!.trpc);
  });
});
