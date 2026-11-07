import { describe, expect, test } from "bun:test";

import { servingReadinessCheck } from "../src/serving-readiness.js";

/**
 * Real loopback servers (port 0) — the contract evaluator is exercised over a
 * live socket so abort/timeout bounds are observed through the actual fetch
 * stack, not a mocked transport.
 */
async function withReadinessServer(
  handler: (req: Request) => Response | Promise<Response>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  try {
    await run(`http://127.0.0.1:${String(server.port)}`);
  } finally {
    await server.stop(true);
  }
}

/**
 * JSON body split across a delayed second chunk. The timer is cancelled when
 * the reader aborts, so no enqueue ever races a closed controller — an
 * uncaught error here would leak across test files in a shared bun test run.
 */
function slowJsonBody(prefix: string, suffix: string, delayMs: number): Response {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(new TextEncoder().encode(prefix));
      timer = setTimeout(() => {
        timer = undefined;
        controller.enqueue(new TextEncoder().encode(suffix));
        controller.close();
      }, delayMs);
    },
    cancel(): void {
      if (timer !== undefined) clearTimeout(timer);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

describe("servingReadinessCheck", () => {
  test("passes the default-200 status contract", async () => {
    await withReadinessServer(
      () => new Response("ok", { status: 200 }),
      async (baseUrl) => {
        expect(await servingReadinessCheck(`${baseUrl}/ready`, { path: "/ready" })).toBe(true);
      },
    );
  });

  test("fails a 503 while loading when expectStatus is unset", async () => {
    await withReadinessServer(
      () => new Response("loading", { status: 503 }),
      async (baseUrl) => {
        expect(await servingReadinessCheck(`${baseUrl}/ready`, { path: "/ready" })).toBe(false);
      },
    );
  });

  test("honors an explicit expectStatus override", async () => {
    await withReadinessServer(
      () => new Response("weird but declared", { status: 204 }),
      async (baseUrl) => {
        expect(
          await servingReadinessCheck(`${baseUrl}/ready`, { path: "/ready", expectStatus: 204 }),
        ).toBe(true);
      },
    );
  });

  test("fails closed on a missing capability (404)", async () => {
    await withReadinessServer(
      () => new Response("not found", { status: 404 }),
      async (baseUrl) => {
        expect(await servingReadinessCheck(`${baseUrl}/ready`, { path: "/ready" })).toBe(false);
      },
    );
  });

  test("matches top-level scalar expectJson values", async () => {
    await withReadinessServer(
      () =>
        Response.json({
          status: "ready",
          models_loaded: 2,
          warm: true,
          nested: { ignored: true },
        }),
      async (baseUrl) => {
        expect(
          await servingReadinessCheck(`${baseUrl}/ready`, {
            path: "/ready",
            expectJson: { status: "ready", models_loaded: 2, warm: true },
          }),
        ).toBe(true);
      },
    );
  });

  test.each([
    { label: "wrong value", body: { status: "loading" } },
    { label: "missing key", body: { other: "ready" } },
    { label: "type mismatch", body: { models_loaded: "2" } },
  ])("fails expectJson on $label", async ({ body }) => {
    await withReadinessServer(
      () => Response.json(body),
      async (baseUrl) => {
        expect(
          await servingReadinessCheck(`${baseUrl}/ready`, {
            path: "/ready",
            expectJson: { status: "ready", models_loaded: 2 },
          }),
        ).toBe(false);
      },
    );
  });

  test.each(["not json at all", "[1,2,3]", '"a string"', "42", "null", "true"])(
    "fails a non-object-json or malformed payload: %s",
    async (raw) => {
      await withReadinessServer(
        () => new Response(raw, { status: 200, headers: { "content-type": "application/json" } }),
        async (baseUrl) => {
          expect(
            await servingReadinessCheck(`${baseUrl}/ready`, {
              path: "/ready",
              expectJson: { status: "ready" },
            }),
          ).toBe(false);
        },
      );
    },
  );

  test("fails closed when nothing listens (network error)", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok", { status: 200 }),
    });
    const baseUrl = `http://127.0.0.1:${String(server.port)}`;
    await server.stop(true);
    expect(await servingReadinessCheck(`${baseUrl}/ready`, { path: "/ready" })).toBe(false);
  });

  test("a slow body past timeoutMs fails within the bound", async () => {
    await withReadinessServer(
      () => slowJsonBody('{"status":', '"ready"}', 400),
      async (baseUrl) => {
        const started = Date.now();
        const ok = await servingReadinessCheck(
          `${baseUrl}/ready`,
          { path: "/ready", expectJson: { status: "ready" } },
          { timeoutMs: 100 },
        );
        expect(ok).toBe(false);
        expect(Date.now() - started).toBeLessThan(300);
      },
    );
  });

  test("a slow header past timeoutMs fails closed", async () => {
    await withReadinessServer(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return new Response("ok", { status: 200 });
      },
      async (baseUrl) => {
        expect(
          await servingReadinessCheck(`${baseUrl}/ready`, { path: "/ready" }, { timeoutMs: 100 }),
        ).toBe(false);
      },
    );
  });

  test("an already-aborted signal fails immediately", async () => {
    await withReadinessServer(
      () => new Response("ok", { status: 200 }),
      async (baseUrl) => {
        const controller = new AbortController();
        controller.abort();
        expect(
          await servingReadinessCheck(
            `${baseUrl}/ready`,
            { path: "/ready" },
            { timeoutMs: 60_000, signal: controller.signal },
          ),
        ).toBe(false);
      },
    );
  });

  test("the signal bounds the fetch even when timeoutMs is larger", async () => {
    await withReadinessServer(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        return new Response("ok", { status: 200 });
      },
      async (baseUrl) => {
        const controller = new AbortController();
        setTimeout(() => {
          controller.abort();
        }, 80);
        const started = Date.now();
        expect(
          await servingReadinessCheck(
            `${baseUrl}/ready`,
            { path: "/ready" },
            { timeoutMs: 30_000, signal: controller.signal },
          ),
        ).toBe(false);
        expect(Date.now() - started).toBeLessThan(1_000);
      },
    );
  });

  test("a live signal must not disable the timeout on a slow header", async () => {
    await withReadinessServer(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return new Response("ok", { status: 200 });
      },
      async (baseUrl) => {
        const started = Date.now();
        const ok = await servingReadinessCheck(
          `${baseUrl}/ready`,
          { path: "/ready" },
          { timeoutMs: 20, signal: new AbortController().signal },
        );
        expect(ok).toBe(false);
        expect(Date.now() - started).toBeLessThan(150);
      },
    );
  });

  test("a live signal must not disable the timeout on a slow body", async () => {
    await withReadinessServer(
      () => slowJsonBody('{"status":', '"ready"}', 200),
      async (baseUrl) => {
        const started = Date.now();
        const ok = await servingReadinessCheck(
          `${baseUrl}/ready`,
          { path: "/ready", expectJson: { status: "ready" } },
          { timeoutMs: 20, signal: new AbortController().signal },
        );
        expect(ok).toBe(false);
        expect(Date.now() - started).toBeLessThan(150);
      },
    );
  });

  test("a live signal with a passing response still returns true", async () => {
    await withReadinessServer(
      () => Response.json({ status: "ready" }),
      async (baseUrl) => {
        expect(
          await servingReadinessCheck(
            `${baseUrl}/ready`,
            { path: "/ready", expectJson: { status: "ready" } },
            { timeoutMs: 500, signal: new AbortController().signal },
          ),
        ).toBe(true);
      },
    );
  });
});
