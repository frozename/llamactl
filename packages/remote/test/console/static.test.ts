/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- RED contract tests for #410 P2b: the console surface is an inert 501 stub, so every test reaches it through the untyped `api()` shim and fails on its expects rather than on an import error or a TypeError. */
// Issue frozename/llamactl#410 (plan P2b, §0.10) — static serving:
// the SPA fallback covers extensionless paths only, percent-encoded
// traversal is refused, missing assets 404, and every response —
// static, API success, API error — carries nosniff + referrer-policy
// headers (R13).

import { afterEach, describe, expect, test } from "bun:test";

import * as remote from "../../src/index.js";
import {
  apiHeaders,
  cleanupConsoleTest,
  consoleTestFixture,
  INDEX_HTML,
  makeSpyBackend,
  spyFixtures,
  startConsole,
  trpcUrl,
} from "./helpers.js";

function api(): any {
  expect(typeof remote.startConsoleServer).toBe("function");
  expect(remote.CONSOLE_ALLOWLIST).toBeDefined();
  return remote as any;
}

function expectSecurityHeaders(res: Response): void {
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBeTruthy();
}

afterEach(async () => {
  await cleanupConsoleTest();
});

describe("console static serving", () => {
  test("(R13) percent-encoded path traversal → 403", async () => {
    const r = api();
    const h = await startConsole(r, { distPath: consoleTestFixture().distPath });
    const res = await fetch(`${h.url}/..%2f..%2fetc%2fpasswd`);
    expect(res.status).toBe(403);
    expectSecurityHeaders(res);
  });

  test("(R13) an unknown extensionless path falls back to index.html", async () => {
    const r = api();
    const h = await startConsole(r, { distPath: consoleTestFixture().distPath });
    const res = await fetch(`${h.url}/workloads/abc123`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
    expectSecurityHeaders(res);
  });

  test("(R13) a missing asset path → 404, not the SPA fallback", async () => {
    const r = api();
    const h = await startConsole(r, { distPath: consoleTestFixture().distPath });
    const res = await fetch(`${h.url}/assets/x.js`);
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
  });

  test("(R13) security headers are present on API success and API error responses", async () => {
    const r = api();
    const spy = makeSpyBackend(spyFixtures());
    const h = await startConsole(r, {
      distPath: consoleTestFixture().distPath,
      backend: spy.router,
    });
    const ok = await fetch(trpcUrl(h, "nodeList"), { headers: apiHeaders(h) });
    expect(ok.status).toBe(200);
    expectSecurityHeaders(ok);
    const denied = await fetch(trpcUrl(h, "nodeList"), {
      headers: {
        host: `127.0.0.1:${String(h.port)}`,
        "sec-fetch-site": "same-origin",
      },
    });
    expect(denied.status).toBe(401);
    expectSecurityHeaders(denied);
  });
});
