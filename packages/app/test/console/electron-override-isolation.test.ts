// packages/app/test/console/electron-override-isolation.test.ts
// Issue #410, P3 RED 6 — the Electron dispatcher's module-global
// active-node override (set through uiSetActiveNode over IPC) must not
// steer requests that arrive through the web console's
// /api/n/:node/trpc mount. The console binds its node from the path
// per request; the two selection mechanisms share no mutable state.
// A real loopback console server proves it end to end: a node:"local"
// link client lands on the local spy while the override points at
// remote1, and a node:"remote1" client lands on the fake remote while
// the override points at local.

import type { TRPCLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";

import { buildDispatchRouter, startConsoleServer } from "@llamactl/remote";
import { createTRPCClient } from "@trpc/client";
import { afterEach, describe, expect, test } from "bun:test";

import type { buildDispatcherRouter } from "../../electron/trpc/dispatcher";

import {
  apiHeaders,
  cleanupConsoleTest,
  consoleTestFixture,
  makeFakeRemote,
  makeLocalSpy,
  remoteNodeFixture,
  startConsole,
} from "../../../remote/test/console/helpers";

const HTTP_TRANSPORT_SPEC = "../../src/lib/transport/http.ts";

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
}

interface UntypedProcedures {
  serverStatus: { query: (input?: unknown) => Promise<unknown> };
}

interface DispatcherCaller {
  uiSetActiveNode: (input: { name: string }) => Promise<{ ok: true; name: string }>;
  uiGetActiveNode: () => Promise<{ name: string | null }>;
}

interface DispatcherModule {
  buildDispatcherRouter: typeof buildDispatcherRouter;
  __resetActiveNodeOverrideForTests: () => void;
}

let dispatcherMod: DispatcherModule | null = null;

afterEach(async () => {
  dispatcherMod?.__resetActiveNodeOverrideForTests();
  dispatcherMod = null;
  await cleanupConsoleTest();
});

describe("electron override isolation (#410 P3)", () => {
  test("the uiSetActiveNode override cannot steer console /api/n/:node requests", async () => {
    expect(buildDispatchRouter).toBeFunction();
    expect(startConsoleServer).toBeFunction();

    const http = (await import(HTTP_TRANSPORT_SPEC).catch(
      () => null,
    )) as HttpTransportModule | null;
    dispatcherMod = await import("../../electron/trpc/dispatcher");

    // The console backend, wired exactly like server.ts wires its
    // default: node bound from ctx, unresolvable targets are errors.
    const fake = makeFakeRemote();
    const spy = makeLocalSpy();
    const backend = buildDispatchRouter({
      fetchFactory: fake.fetchFactory,
      localCallerFactory: spy.localCallerFactory,
      nodeFromCtx: (c) => c.node ?? null,
      onUnresolvable: "error",
    });
    const { distPath } = consoleTestFixture({
      nodes: [remoteNodeFixture()],
      users: [{ name: "me", token: "tok" }],
    });
    const h = await startConsole({ startConsoleServer }, { backend, distPath });

    // The Electron-side override lives in a different module's global
    // state. Setting it must be invisible to the console mount.
    const caller = dispatcherMod
      .buildDispatcherRouter()
      .createCaller({}) as unknown as DispatcherCaller;
    await caller.uiSetActiveNode({ name: "remote1" });
    expect((await caller.uiGetActiveNode()).name).toBe("remote1");

    expect(http?.buildHttpLinks).toBeFunction();
    const buildHttpLinks = http!.buildHttpLinks!;
    const makeClient = (node: string): UntypedProcedures =>
      createTRPCClient<AnyRouter>({
        links: buildHttpLinks({
          baseUrl: `http://127.0.0.1:${String(h.port)}/api`,
          node,
          fetch: (input, init) =>
            fetch(input, {
              ...init,
              headers: {
                ...Object.fromEntries(new Headers(init?.headers)),
                ...apiHeaders(h),
              },
            }),
        }),
      }) as unknown as UntypedProcedures;

    // Override says remote1, path node says local → local wins.
    const localOutcome = await makeClient("local")
      .serverStatus.query({ workload: "w1" })
      .then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ e, ok: false as const }),
      );
    expect(localOutcome.ok).toBe(true);
    expect(spy.calls.filter((c) => c === "serverStatus")).toHaveLength(1);
    expect(fake.calls).toHaveLength(0);

    // Override says local, path node says remote1 → remote1 wins.
    await caller.uiSetActiveNode({ name: "local" });
    const remoteOutcome = await makeClient("remote1")
      .serverStatus.query({ workload: "w1" })
      .then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ e, ok: false as const }),
      );
    expect(remoteOutcome.ok).toBe(true);
    expect(fake.calls).toEqual(["serverStatus"]);
    expect(spy.calls.filter((c) => c === "serverStatus")).toHaveLength(1);
  });
});
