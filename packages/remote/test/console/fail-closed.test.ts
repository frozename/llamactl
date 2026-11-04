/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- RED contract tests for #410 P2b: the console surface is an inert 501 stub, so every test reaches it through the untyped `api()` shim and fails on its expects rather than on an import error or a TypeError. */
// Issue frozename/llamactl#410 (plan P2b, §0.6/§0.7) — fail-closed
// node dispatch. The console router wraps the base procedures with
// buildDispatchRouter({ onUnresolvable: "error" }), so an
// unresolvable node (missing tokenRef secret, unreadable kubeconfig)
// surfaces as a typed PRECONDITION_FAILED — never as a silent
// fallthrough to the local caller. A Proxy on localCallerFactory
// proves the local path stayed untouched (R10).

import { afterEach, describe, expect, test } from "bun:test";

import * as remote from "../../src/index.js";
import { writeFileSync } from "../../src/safe-fs.js";
import {
  apiHeaders,
  cleanupConsoleTest,
  consoleTestFixture,
  setEnv,
  startConsole,
  trpcUrl,
} from "./helpers.js";

function api(): any {
  expect(typeof remote.startConsoleServer).toBe("function");
  expect(typeof remote.buildConsoleRouter).toBe("function");
  expect(remote.CONSOLE_ALLOWLIST).toBeDefined();
  return remote as any;
}

const MISSING_TOKEN_ENV = "LLAMACTL_CONSOLE_TEST_UNSET_TOKEN";

function unresolvableFixture(): { distPath: string } {
  setEnv(MISSING_TOKEN_ENV, undefined);
  return consoleTestFixture({
    defaultNode: "remote1",
    nodes: [
      {
        certificateFingerprint: `sha256:${"ab".repeat(32)}`,
        endpoint: "https://127.0.0.1:9",
        kind: "agent",
        name: "remote1",
      },
    ],
    users: [{ name: "me", tokenRef: `env:${MISSING_TOKEN_ENV}` }],
  });
}

/** The console-side dispatch seam with a recording local caller. */
function failClosedBackend(): { backend: unknown; calls: string[] } {
  const calls: string[] = [];
  const localCaller = new Proxy(
    {},
    {
      get:
        (_target, prop) =>
        (input?: unknown): Record<string, unknown> => {
          calls.push(String(prop));
          void input;
          return { fixture: true };
        },
    },
  );
  const backend = remote.buildDispatchRouter({
    fetchFactory: remote.makePinnedFetch,
    localCallerFactory: () => localCaller,
    nodeFromCtx: (c: { node?: string | null }) => c.node ?? null,
    onUnresolvable: "error",
  });
  return { backend, calls };
}

afterEach(async () => {
  await cleanupConsoleTest();
});

describe("console fail-closed node dispatch", () => {
  test("(R10.1) unresolvable tokenRef → 412 node_credentials_unavailable, local spy 0", async () => {
    const r = api();
    const { distPath } = unresolvableFixture();
    const { backend, calls } = failClosedBackend();
    const h = await startConsole(r, { backend, distPath });
    const res = await fetch(trpcUrl(h, "serverStatus", { input: { workload: "w1" } }), {
      headers: apiHeaders(h),
    });
    expect(res.status).toBe(412);
    expect(await res.text()).toContain("node_credentials_unavailable");
    expect(calls).toEqual([]);
  });

  test("(R10.2) unreadable kubeconfig → kubeconfig_unreadable, local spy 0", async () => {
    const r = api();
    const { configPath, distPath } = consoleTestFixture({ defaultNode: "remote1" });
    writeFileSync(configPath, "this is not: [valid kubeconfig yaml{{{");
    const { backend, calls } = failClosedBackend();
    const h = await startConsole(r, { backend, distPath });
    const res = await fetch(trpcUrl(h, "serverStatus", { input: { workload: "w1" } }), {
      headers: apiHeaders(h),
    });
    expect(res.status).toBe(412);
    expect(await res.text()).toContain("kubeconfig_unreadable");
    expect(calls).toEqual([]);
  });

  test("(R10.3) resolvable kubeconfig → nodeList (CONTROL_PLANE_ONLY) stays local → 200", async () => {
    const r = api();
    const { distPath } = consoleTestFixture({
      defaultNode: "remote1",
      nodes: [
        {
          certificateFingerprint: `sha256:${"ab".repeat(32)}`,
          endpoint: "https://127.0.0.1:9",
          kind: "agent",
          name: "remote1",
        },
      ],
      users: [{ name: "me", token: "x" }],
    });
    const calls: string[] = [];
    const localCaller = new Proxy(
      {},
      {
        get:
          (_target, prop) =>
          (input?: unknown): Record<string, unknown> => {
            calls.push(String(prop));
            void input;
            return { defaultNode: "remote1", nodes: [] };
          },
      },
    );
    const backend = remote.buildDispatchRouter({
      fetchFactory: remote.makePinnedFetch,
      localCallerFactory: () => localCaller,
      nodeFromCtx: (c: { node?: string | null }) => c.node ?? null,
      onUnresolvable: "error",
    });
    const h = await startConsole(r, { backend, distPath });
    const res = await fetch(trpcUrl(h, "nodeList"), { headers: apiHeaders(h) });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["nodeList"]);
  });

  test("(R10.4) real default backend: unresolvable tokenRef → 412 node_credentials_unavailable", async () => {
    const r = api();
    const { distPath } = unresolvableFixture();
    const h = await startConsole(r, { distPath });
    const res = await fetch(trpcUrl(h, "serverStatus", { input: { workload: "w1" } }), {
      headers: apiHeaders(h),
    });
    expect(res.status).toBe(412);
    expect(await res.text()).toContain("node_credentials_unavailable");
  });
});
