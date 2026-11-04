// packages/app/test/lib/transport/http-links.test.ts
// Issue #410, P1 RED 3 — pins the web-console HTTP transport: subscriptions
// route to the SSE link at {baseUrl}/trpc with cookie credentials, queries
// and mutations to the batch link with credentials:"include" and no
// Authorization header. The injected fetch and EventSource fakes are the
// whole network; no sockets are opened.

import type { TRPCLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";

import { createTRPCClient } from "@trpc/client";
import { describe, expect, test } from "bun:test";

const HTTP_TRANSPORT_SPEC = "../../../src/lib/transport/http.ts";

type FetchInput = string | URL | Request;
type FakeFetch = (input: FetchInput, init?: RequestInit) => Promise<Response>;

interface BuildHttpLinksOptions {
  baseUrl: string;
  fetch?: FakeFetch;
  EventSource?: unknown;
}

interface HttpTransportModule {
  buildHttpLinks?: (opts: BuildHttpLinksOptions) => TRPCLink<AnyRouter>[];
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

describe("buildHttpLinks (#410 P1)", () => {
  test("routes queries to the batch link with include credentials and no authorization header", async () => {
    const mod = await importHttpTransport();
    expect(mod?.buildHttpLinks).toBeFunction();

    const { calls, fakeFetch } = makeRecordingFetch([{ result: { data: 1 } }]);
    const client = makeClient(mod!.buildHttpLinks!, {
      baseUrl: "/api",
      fetch: fakeFetch,
      EventSource: FakeEventSource,
    });

    const result = await client.serverStatus.query();

    expect(result).toBe(1);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url.startsWith("/api/trpc/serverStatus")).toBe(true);
    expect(call.url).toContain("batch=1");
    expect(call.init?.credentials).toBe("include");
    expect(new Headers(call.init?.headers).has("authorization")).toBe(false);
  });

  test("routes mutations to the batch link as POST with include credentials and no authorization header", async () => {
    const mod = await importHttpTransport();
    expect(mod?.buildHttpLinks).toBeFunction();

    const { calls, fakeFetch } = makeRecordingFetch([{ result: { data: { stopped: true } } }]);
    const client = makeClient(mod!.buildHttpLinks!, {
      baseUrl: "/api",
      fetch: fakeFetch,
      EventSource: FakeEventSource,
    });

    const result = await client.serverStop.mutate({ name: "x" });

    expect(result).toEqual({ stopped: true });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url.startsWith("/api/trpc/serverStop")).toBe(true);
    expect(call.init?.method).toBe("POST");
    expect(call.init?.credentials).toBe("include");
    expect(new Headers(call.init?.headers).has("authorization")).toBe(false);
  });

  test("routes subscriptions to the SSE link with withCredentials and never touches fetch", async () => {
    const mod = await importHttpTransport();
    expect(mod?.buildHttpLinks).toBeFunction();

    FakeEventSource.instances = [];
    const { calls, fakeFetch } = makeRecordingFetch([]);
    const client = makeClient(mod!.buildHttpLinks!, {
      baseUrl: "/api",
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
    expect(instance.url.startsWith("/api/trpc/chatStream")).toBe(true);
    expect(instance.init?.withCredentials).toBe(true);
    expect(calls).toHaveLength(0);

    sub.unsubscribe();
  });
});
