/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- RED contract tests for #410 P2b: the console surface is an inert 501 stub, so every test reaches it through the untyped `api()` shim and fails on its expects rather than on an import error or a TypeError. */
// Issue frozename/llamactl#410 (plan P2b) — subscription teardown.
// When the console's HTTP client aborts an SSE subscription, the
// AbortSignal must propagate through createCaller into the
// subscription generator so its `finally` runs (R12, local half —
// the remote half is the dispatch router's own responsibility). A
// generator that ignores the signal must still be torn down via the
// consumer's `iterator.return()` — the call the console wrapper makes
// in its own `finally` and that the SSE handler drives upstream on
// client disconnect.

import { initTRPC } from "@trpc/server";
import { createCallerFactory } from "@trpc/server/unstable-core-do-not-import";
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";

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

interface StubbornState {
  finallyRan: boolean;
}

// A backend `serverLogs` that never observes the AbortSignal and parks
// on a promise that never settles: its `finally` can only ever run if
// the console wrapper's own `finally` calls `iterator.return?.()`,
// which is what the SSE handler performs on the consumer iterator when
// a client disconnects.
function makeStubbornBackend(): { router: unknown; state: StubbornState } {
  const state: StubbornState = { finallyRan: false };
  const t = initTRPC.context<{ node: string | null }>().create();
  const router = t.router({
    serverLogs: t.procedure.input(z.unknown()).subscription(async function* () {
      try {
        yield { line: "stubbornmark-41c0", type: "line" };
        await new Promise<void>(() => undefined);
      } finally {
        state.finallyRan = true;
      }
    }),
  });
  return { router, state };
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

  test("(R12) iterator.return?.() on the console subscription tears down a signal-ignoring backend generator", async () => {
    const r = api();
    const stubborn = makeStubbornBackend();
    const caller: any = createCallerFactory()(remote.buildConsoleRouter(stubborn.router))({
      node: null,
    });
    const iterable = (await caller.serverLogs({
      follow: true,
      workload: "w1",
    })) as AsyncIterable<unknown>;
    const iterator = iterable[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ line: "stubbornmark-41c0", type: "line" });
    expect(stubborn.state.finallyRan).toBe(false);
    await iterator.return?.();
    expect(stubborn.state.finallyRan).toBe(true);
  });
});
