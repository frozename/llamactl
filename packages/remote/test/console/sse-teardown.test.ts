/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- RED contract tests for #410 P2b: the console surface is an inert 501 stub, so every test reaches it through the untyped `api()` shim and fails on its expects rather than on an import error or a TypeError. */
// Issue frozename/llamactl#410 (plan P2b) — subscription teardown.
// When the console's HTTP client aborts an SSE subscription, the
// AbortSignal must propagate through createCaller into the
// subscription generator so its `finally` runs (R12, local half —
// the remote half is the dispatch router's own responsibility).

import { afterEach, describe, expect, test } from "bun:test";

import * as remote from "../../src/index.js";
import {
  apiHeaders,
  cleanupConsoleTest,
  consoleTestFixture,
  makeSpyBackend,
  pollUntil,
  readSseFor,
  spyFixtures,
  startConsole,
  trpcUrl,
} from "./helpers.js";

function api(): any {
  expect(typeof remote.startConsoleServer).toBe("function");
  expect(typeof remote.buildConsoleRouter).toBe("function");
  expect(remote.CONSOLE_ALLOWLIST).toBeDefined();
  return remote as any;
}

afterEach(async () => {
  await cleanupConsoleTest();
});

describe("console SSE teardown", () => {
  test("(R12) aborting the client fetch runs the subscription's finally within 1s", async () => {
    const r = api();
    const spy = makeSpyBackend(spyFixtures());
    const h = await startConsole(r, {
      distPath: consoleTestFixture().distPath,
      backend: spy.router,
    });
    const controller = new AbortController();
    const res = await fetch(trpcUrl(h, "serverLogs", { input: { workload: "w1", follow: true } }), {
      headers: apiHeaders(h, { accept: "text/event-stream" }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    // The spy's yielded item carries the log line (projected — the
    // sentinels inside it are masked); "logmark-41c0" is its stable tag.
    const { found } = await readSseFor(res, "logmark-41c0", 3000);
    expect(found).toBe(true);
    expect(spy.state.sawAbortSignal).toBe(true);
    controller.abort();
    const ran = await pollUntil(() => spy.state.finallyRan, 1000);
    expect(ran).toBe(true);
  });
});
