/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- RED contract tests for #410 P2b: the console surface is an inert 501 stub, so every test reaches it through the untyped `api()` shim and fails on its expects rather than on an import error or a TypeError. */
// Issue frozename/llamactl#410 (plan P2b) — same-origin guard contract
// for the console server: a session cookie is required on /api (R1),
// the Host allowlist blocks DNS-rebinding (R4), Sec-Fetch-Site/Origin
// is enforced on every /api request including GET subscriptions (R5),
// inbound credentials never reach procedure ctx or input (R8), and a
// non-loopback bind is refused (R14, server half).

import { afterEach, describe, expect, test } from "bun:test";

import * as remote from "../../src/index.js";
import {
  apiHeaders,
  cleanupConsoleTest,
  consoleTestFixture,
  makeSpyBackend,
  startConsole,
  trpcUrl,
} from "./helpers.js";

function api(): any {
  expect(typeof remote.startConsoleServer).toBe("function");
  expect(typeof remote.buildConsoleRouter).toBe("function");
  expect(typeof remote.redactDeep).toBe("function");
  expect(remote.CONSOLE_ALLOWLIST).toBeDefined();
  expect(typeof remote.newConsoleSession).toBe("function");
  expect(typeof remote.checkConsoleHost).toBe("function");
  expect(typeof remote.checkConsoleSameOrigin).toBe("function");
  expect(typeof remote.checkConsoleSession).toBe("function");
  expect(typeof remote.checkConsoleTrpcPath).toBe("function");
  return remote as any;
}

afterEach(async () => {
  await cleanupConsoleTest();
});

describe("console same-origin guards", () => {
  test("(R1) GET /api/trpc/nodeList without the session cookie → 401 invalid_session", async () => {
    const r = api();
    const spy = makeSpyBackend();
    const h = await startConsole(r, {
      distPath: consoleTestFixture().distPath,
      backend: spy.router,
    });
    const res = await fetch(trpcUrl(h, "nodeList"), {
      headers: {
        host: `127.0.0.1:${String(h.port)}`,
        "sec-fetch-site": "same-origin",
      },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_session" });
    expect(spy.calls).toEqual([]);
  });

  test("(R4) a valid cookie under a foreign Host is rejected before the procedure runs", async () => {
    const r = api();
    const spy = makeSpyBackend();
    const h = await startConsole(r, {
      distPath: consoleTestFixture().distPath,
      backend: spy.router,
    });
    const res = await fetch(trpcUrl(h, "nodeList"), {
      headers: apiHeaders(h, { host: `evil.test:${String(h.port)}` }),
    });
    expect([403, 421]).toContain(res.status);
    expect(spy.calls).toEqual([]);
  });

  test("(R5) POST with a cross-site Origin → 403 cross_site_request_forbidden", async () => {
    const r = api();
    const spy = makeSpyBackend();
    const h = await startConsole(r, {
      distPath: consoleTestFixture().distPath,
      backend: spy.router,
    });
    const res = await fetch(trpcUrl(h, "nodeList"), {
      body: "null",
      headers: apiHeaders(h, {
        "content-type": "application/json",
        origin: "http://evil.test",
      }),
      method: "POST",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross_site_request_forbidden" });
    expect(spy.calls).toEqual([]);
  });

  test("(R5) Sec-Fetch-Site: cross-site → 403", async () => {
    const r = api();
    const spy = makeSpyBackend();
    const h = await startConsole(r, {
      distPath: consoleTestFixture().distPath,
      backend: spy.router,
    });
    const res = await fetch(trpcUrl(h, "nodeList"), {
      headers: apiHeaders(h, { "sec-fetch-site": "cross-site" }),
    });
    expect(res.status).toBe(403);
    expect(spy.calls).toEqual([]);
  });

  test("(R5) SSE GET on serverLogs with Sec-Fetch-Site: cross-site → 403", async () => {
    const r = api();
    const spy = makeSpyBackend();
    const h = await startConsole(r, {
      distPath: consoleTestFixture().distPath,
      backend: spy.router,
    });
    const res = await fetch(trpcUrl(h, "serverLogs", { input: { workload: "w1", follow: true } }), {
      headers: apiHeaders(h, {
        accept: "text/event-stream",
        "sec-fetch-site": "cross-site",
      }),
    });
    expect(res.status).toBe(403);
    expect(spy.calls).toEqual([]);
  });

  test("(R5) a request with no Sec-Fetch-Site header → 403", async () => {
    const r = api();
    const spy = makeSpyBackend();
    const h = await startConsole(r, {
      distPath: consoleTestFixture().distPath,
      backend: spy.router,
    });
    const res = await fetch(trpcUrl(h, "nodeList"), {
      headers: {
        cookie: h.cookie,
        host: `127.0.0.1:${String(h.port)}`,
      },
    });
    expect(res.status).toBe(403);
    expect(spy.calls).toEqual([]);
  });

  test("(R8) inbound Authorization and stray cookies never reach procedure ctx or input", async () => {
    const r = api();
    const spy = makeSpyBackend({ nodeList: { defaultNode: "local", nodes: [] } });
    const h = await startConsole(r, {
      distPath: consoleTestFixture().distPath,
      backend: spy.router,
    });
    const res = await fetch(trpcUrl(h, "nodeList"), {
      headers: apiHeaders(h, {
        authorization: "Bearer x",
        cookie: `${h.cookie}; foo=bar`,
      }),
    });
    expect(res.status).toBe(200);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.ctx).toEqual({ node: null });
    expect(JSON.stringify(spy.calls)).not.toContain("Bearer x");
    expect(JSON.stringify(spy.calls)).not.toContain("foo=bar");
  });

  test("(R14) startConsoleServer refuses a non-loopback hostname", async () => {
    const r = api();
    const { distPath } = consoleTestFixture();
    let server: { stop: () => Promise<void> } | undefined;
    let caught: unknown;
    try {
      server = await r.startConsoleServer({ hostname: "0.0.0.0", port: 0, distPath });
    } catch (err) {
      caught = err;
    } finally {
      await server?.stop();
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/127\.0\.0\.1/);
  });
});
