/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- RED contract tests for #410 P2b: the console surface is an inert 501 stub, so every test reaches it through the untyped `api()` shim and fails on its expects rather than on an import error or a TypeError. */
// Issue frozename/llamactl#410 (plan P2b) — session contract: `GET /`
// issues a fresh HttpOnly SameSite=Strict nonce under a port-scoped
// cookie name (browsers do not isolate cookies by port), the index
// carries CSP + no-store headers (R2), and two concurrent servers each
// accept only their own cookie name (R3).

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
  expect(remote.CONSOLE_ALLOWLIST).toBeDefined();
  expect(typeof remote.newConsoleSession).toBe("function");
  expect(typeof remote.checkConsoleSession).toBe("function");
  return remote as any;
}

afterEach(async () => {
  await cleanupConsoleTest();
});

describe("console session", () => {
  test("(R2) GET / issues a port-scoped HttpOnly session cookie with CSP + no-store", async () => {
    const r = api();
    const h = await startConsole(r, { distPath: consoleTestFixture().distPath });
    const res = await fetch(`${h.url}/`);
    const setCookie =
      res.headers.getAll("set-cookie").find((line) => line.startsWith("llamactl_console_")) ?? "";
    const [pair, ...attrs] = setCookie.split(";").map((part) => part.trim());
    const eq = pair?.indexOf("=") ?? -1;
    const name = eq > 0 ? pair?.slice(0, eq) : "";
    const nonce = eq > 0 ? pair?.slice(eq + 1) : "";
    expect(name).toBe(`llamactl_console_${String(h.port)}`);
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(attrs).toEqual(["Path=/", "HttpOnly", "SameSite=Strict"]);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self'");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("(R2) the nonce differs between two server starts", async () => {
    const r = api();
    const a = await startConsole(r, { distPath: consoleTestFixture().distPath });
    const b = await startConsole(r, { distPath: consoleTestFixture().distPath });
    expect(a.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(a.nonce).not.toBe(b.nonce);
  });

  test("(R3) port-scoped cookie names isolate two concurrent servers", async () => {
    const r = api();
    const spyA = makeSpyBackend({ nodeList: { defaultNode: "local", nodes: [] } });
    const spyB = makeSpyBackend({ nodeList: { defaultNode: "local", nodes: [] } });
    const a = await startConsole(r, {
      distPath: consoleTestFixture().distPath,
      backend: spyA.router,
    });
    const b = await startConsole(r, {
      distPath: consoleTestFixture().distPath,
      backend: spyB.router,
    });
    expect(a.cookieName).not.toBe(b.cookieName);

    const bothCookies = `${a.cookieName}=${a.nonce}; ${b.cookieName}=${b.nonce}`;
    const resA = await fetch(trpcUrl(a, "nodeList"), {
      headers: apiHeaders(a, { cookie: bothCookies }),
    });
    expect(resA.status).toBe(200);
    const resB = await fetch(trpcUrl(b, "nodeList"), {
      headers: apiHeaders(b, { cookie: bothCookies }),
    });
    expect(resB.status).toBe(200);

    const swapped = await fetch(trpcUrl(b, "nodeList"), {
      headers: apiHeaders(b, { cookie: `${b.cookieName}=${a.nonce}` }),
    });
    expect(swapped.status).toBe(401);
    expect(spyB.calls).toHaveLength(1);
  });
});
