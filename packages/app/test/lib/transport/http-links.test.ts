// packages/app/test/lib/transport/http-links.test.ts
// Issue #410, P3 RED — pins the node-scoped web-console HTTP transport:
// buildHttpLinks({baseUrl, node}) mounts every link at
// {baseUrl}/n/{node}/trpc to match the server's /api/n/:node/trpc
// mount. Subscriptions route to the SSE link with cookie credentials,
// queries and mutations to the batch link with credentials:"include"
// and no Authorization header. The injected fetch and EventSource
// fakes are the whole network; no sockets are opened.

import type { TRPCLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";

import { createTRPCClient } from "@trpc/client";
import { describe, expect, test } from "bun:test";

const HTTP_TRANSPORT_SPEC = "../../../src/lib/transport/http.ts";

type FetchInput = string | URL | Request;
type FakeFetch = (input: FetchInput, init?: RequestInit) => Promise<Response>;

interface BuildHttpLinksOptions {
  baseUrl: string;
  node: string;
  fetch?: FakeFetch;
  EventSource?: unknown;
}

interface HttpTransportModule {
  buildHttpLinks?: (opts: BuildHttpLinksOptions) => TRPCLink<AnyRouter>[];
  CONSOLE_NODE_NAME?: RegExp;
  isConsoleNodeName?: (name: string) => boolean;
}

interface UntypedProcedures {
  serverStatus: { query: () => Promise<unknown> };
  serverStop: { mutate: (input: { name: string }) => Promise<unknown> };
  chatStream: {
    subscribe: (
      input: undefined,
      opts: { onData: (data: unknown) => void },
    ) => { unsubscribe: () => void };
  };
}

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

class FakeEventSource {
  static instances: { url: string; init: { withCredentials?: boolean } | undefined }[] = [];

  readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readyState = 0;

  constructor(url: string, init?: { withCredentials?: boolean }) {
    FakeEventSource.instances.push({ url, init });
  }

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

async function importHttpTransport(): Promise<HttpTransportModule | null> {
  return (await import(HTTP_TRANSPORT_SPEC).catch(() => null)) as HttpTransportModule | null;
}

function makeRecordingFetch(responseBody: unknown): {
  calls: RecordedCall[];
  fakeFetch: FakeFetch;
} {
  const calls: RecordedCall[] = [];
  const fakeFetch: FakeFetch = (input, init) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { calls, fakeFetch };
}

function makeClient(
  buildHttpLinks: NonNullable<HttpTransportModule["buildHttpLinks"]>,
  opts: BuildHttpLinksOptions,
): UntypedProcedures {
  return createTRPCClient<AnyRouter>({
    links: buildHttpLinks(opts),
  }) as unknown as UntypedProcedures;
}

describe("buildHttpLinks (#410 P3)", () => {
  test("routes queries to the batch link under /api/n/{node}/trpc with include credentials and no authorization header", async () => {
    const mod = await importHttpTransport();
    expect(mod?.buildHttpLinks).toBeFunction();

    const { calls, fakeFetch } = makeRecordingFetch([{ result: { data: 1 } }]);
    const client = makeClient(mod!.buildHttpLinks!, {
      baseUrl: "/api",
      node: "local",
      fetch: fakeFetch,
      EventSource: FakeEventSource,
    });

    const result = await client.serverStatus.query();

    expect(result).toBe(1);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url.startsWith("/api/n/local/trpc/serverStatus")).toBe(true);
    expect(call.url).toContain("batch=1");
    expect(call.init?.credentials).toBe("include");
    expect(new Headers(call.init?.headers).has("authorization")).toBe(false);
  });

  test("routes mutations to the batch link under /api/n/{node}/trpc as POST with include credentials and no authorization header", async () => {
    const mod = await importHttpTransport();
    expect(mod?.buildHttpLinks).toBeFunction();

    const { calls, fakeFetch } = makeRecordingFetch([{ result: { data: { stopped: true } } }]);
    const client = makeClient(mod!.buildHttpLinks!, {
      baseUrl: "/api",
      node: "local",
      fetch: fakeFetch,
      EventSource: FakeEventSource,
    });

    const result = await client.serverStop.mutate({ name: "x" });

    expect(result).toEqual({ stopped: true });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url.startsWith("/api/n/local/trpc/serverStop")).toBe(true);
    expect(call.init?.method).toBe("POST");
    expect(call.init?.credentials).toBe("include");
    expect(new Headers(call.init?.headers).has("authorization")).toBe(false);
  });

  test("routes subscriptions to the SSE link under /api/n/{node}/trpc with withCredentials and never touches fetch", async () => {
    const mod = await importHttpTransport();
    expect(mod?.buildHttpLinks).toBeFunction();

    FakeEventSource.instances = [];
    const { calls, fakeFetch } = makeRecordingFetch([]);
    const client = makeClient(mod!.buildHttpLinks!, {
      baseUrl: "/api",
      node: "remote1",
      fetch: fakeFetch,
      EventSource: FakeEventSource,
    });

    const sub = client.chatStream.subscribe(undefined, {
      onData: (): undefined => undefined,
    });

    let ticks = 0;
    while (FakeEventSource.instances.length === 0 && ticks < 50) {
      ticks += 1;
      await Promise.resolve();
    }

    expect(FakeEventSource.instances).toHaveLength(1);
    const instance = FakeEventSource.instances[0]!;
    expect(instance.url.startsWith("/api/n/remote1/trpc/chatStream")).toBe(true);
    expect(instance.init?.withCredentials).toBe(true);
    expect(calls).toHaveLength(0);

    sub.unsubscribe();
  });

  test("uses a valid dotted, hyphenated node name verbatim in the URL", async () => {
    const mod = await importHttpTransport();
    expect(mod?.buildHttpLinks).toBeFunction();

    const { calls, fakeFetch } = makeRecordingFetch([{ result: { data: 1 } }]);
    const client = makeClient(mod!.buildHttpLinks!, {
      baseUrl: "/api",
      node: "gpu-1.lan",
      fetch: fakeFetch,
      EventSource: FakeEventSource,
    });

    await client.serverStatus.query();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.startsWith("/api/n/gpu-1.lan/trpc/serverStatus")).toBe(true);
  });

  test("rejects invalid node names at build time", async () => {
    const mod = await importHttpTransport();
    expect(mod?.buildHttpLinks).toBeFunction();
    const buildHttpLinks = mod!.buildHttpLinks!;
    const { fakeFetch } = makeRecordingFetch([]);

    for (const bad of ["", "a/b", "../x", "lo%2Fcal", ".hidden", "a b"]) {
      expect(() =>
        buildHttpLinks({
          baseUrl: "/api",
          node: bad,
          fetch: fakeFetch,
          EventSource: FakeEventSource,
        }),
      ).toThrow();
    }
  });

  test("two link sets built in one process for different nodes stay independent", async () => {
    const mod = await importHttpTransport();
    expect(mod?.buildHttpLinks).toBeFunction();

    const { calls, fakeFetch } = makeRecordingFetch([{ result: { data: 1 } }]);
    const clientA = makeClient(mod!.buildHttpLinks!, {
      baseUrl: "/api",
      node: "a",
      fetch: fakeFetch,
      EventSource: FakeEventSource,
    });
    const clientB = makeClient(mod!.buildHttpLinks!, {
      baseUrl: "/api",
      node: "b",
      fetch: fakeFetch,
      EventSource: FakeEventSource,
    });

    await clientA.serverStatus.query();
    await clientB.serverStatus.query();
    await clientA.serverStatus.query();

    expect(calls.map((call) => call.url.split("?")[0])).toEqual([
      "/api/n/a/trpc/serverStatus",
      "/api/n/b/trpc/serverStatus",
      "/api/n/a/trpc/serverStatus",
    ]);
  });

  test("exports the node-name rule the server shares", async () => {
    const mod = await importHttpTransport();
    expect(mod?.CONSOLE_NODE_NAME).toBeInstanceOf(RegExp);
    expect(mod?.isConsoleNodeName).toBeFunction();
  });
});
