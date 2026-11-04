// packages/app/test/lib/transport/errors.test.ts
// Issue #410, P4 RED — pins classifyTransportError. The console server
// answers transport-level failures two ways: a guard envelope
// {error: "<consoleCode>"} written by same-origin/session/node guards,
// and real tRPC error envelopes from the router. SSE drops surface as
// TRPCClientError whose cause chain ends in a SuppressedError wrapping
// an eventsource@4 ErrorEvent (its numeric `code` is the HTTP status).
// The module does not exist at the base commit, so every row fails by
// assertion through the import-catch pattern — never by import error.

import type { AnyRouter } from "@trpc/server";

import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { describe, expect, test } from "bun:test";
import { ErrorEvent } from "eventsource";

const ERRORS_SPEC = "../../../src/lib/transport/errors.ts";

interface Classified {
  kind: string;
  retryable: boolean;
  status?: number;
  consoleCode?: string;
  trpcCode?: string;
  message: string;
}

interface ErrorsModule {
  classifyTransportError?: (err: unknown) => Classified;
}

interface UntypedProcedures {
  serverStatus: { query: () => Promise<unknown> };
  serverStop: { mutate: (input: { name: string }) => Promise<unknown> };
}

async function importErrors(): Promise<ErrorsModule | null> {
  return (await import(ERRORS_SPEC).catch(() => null)) as ErrorsModule | null;
}

function classify(mod: ErrorsModule | null, err: unknown): Classified | undefined {
  return mod?.classifyTransportError?.(err);
}

function respondWith(status: number, body: unknown): () => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
}

type HttpBatchFetch = NonNullable<Parameters<typeof httpBatchLink>[0]["fetch"]>;

function batchClient(fetchImpl: () => Promise<Response>): UntypedProcedures {
  const client = createTRPCClient<AnyRouter>({
    links: [
      httpBatchLink({
        url: "/api/n/local/trpc",
        fetch: ((input: string, init?: RequestInit) => {
          void input;
          void init;
          return fetchImpl();
        }) as unknown as HttpBatchFetch,
      }),
    ],
  });
  return client as unknown as UntypedProcedures;
}

async function queryError(client: UntypedProcedures): Promise<unknown> {
  try {
    await client.serverStatus.query();
    return undefined;
  } catch (err) {
    return err;
  }
}

function suppressed(error: unknown, suppressedValue?: unknown): Error {
  const g = globalThis as unknown as {
    SuppressedError?: new (error: unknown, suppressed: unknown, message?: string) => Error;
  };
  if (typeof g.SuppressedError === "function") {
    return new g.SuppressedError(error, suppressedValue ?? error, "");
  }
  return Object.assign(new Error(""), {
    name: "SuppressedError",
    error,
    suppressed: suppressedValue ?? error,
  });
}

const guardRows = [
  ["B1", 401, { error: "invalid_session" }, "invalid_session", false] as const,
  ["B2a", 403, { error: "cross_site_request_forbidden" }, "forbidden", false] as const,
  ["B2b", 421, { error: "misdirected_host" }, "forbidden", false] as const,
  ["B3a", 404, { error: "procedure_not_exposed" }, "not_exposed", false] as const,
  ["B3b", 400, { error: "bad_batch" }, "not_exposed", false] as const,
  ["B4", 404, { error: "unknown_node" }, "unknown_node", false] as const,
  ["B5a", 400, { error: "node_not_dispatchable" }, "node_not_dispatchable", false] as const,
  ["B5b", 400, { error: "bad_node" }, "node_not_dispatchable", false] as const,
  ["B6", 409, { error: "workload_node_mismatch" }, "workload_refused", false] as const,
  ["B10", 502, { error: "bad_gateway" }, "network", true] as const,
  ["B11", 412, { error: "kubeconfig_unreadable" }, "procedure", false] as const,
];

describe("classifyTransportError (#410 P4) — console guard envelopes", () => {
  test.each(guardRows)(
    "%s: status %i %j → %s (retryable=%j)",
    async (_label, status, body, kind, retryable) => {
      const mod = await importErrors();
      expect(mod?.classifyTransportError).toBeFunction();

      const client = batchClient(respondWith(status, body));
      const err = await queryError(client);
      expect(err).toBeInstanceOf(TRPCClientError);

      const classified = classify(mod, err);
      expect(classified?.kind).toBe(kind);
      expect(classified?.retryable).toBe(retryable);
      if (kind !== "network") {
        expect(classified?.consoleCode).toBe((body as { error: string }).error);
      }
    },
  );
});

describe("classifyTransportError (#410 P4) — tRPC envelopes and transport failures", () => {
  test("B7: a real tRPC NOT_FOUND envelope maps to procedure with trpcCode preserved", async () => {
    const mod = await importErrors();
    expect(mod?.classifyTransportError).toBeFunction();

    const client = batchClient(
      respondWith(404, [
        {
          error: {
            message: "nope",
            code: -32004,
            data: { code: "NOT_FOUND", httpStatus: 404, path: "serverStatus" },
          },
        },
      ]),
    );
    const err = await queryError(client);
    const classified = classify(mod, err);
    expect(classified?.kind).toBe("procedure");
    expect(classified?.trpcCode).toBe("NOT_FOUND");
    expect(classified?.retryable).toBe(false);
  });

  test("B8: a 401 tRPC UNAUTHORIZED envelope is a procedure error, not an invalid session", async () => {
    const mod = await importErrors();
    expect(mod?.classifyTransportError).toBeFunction();

    const client = batchClient(
      respondWith(401, [
        {
          error: {
            message: "unauthorized",
            code: -32001,
            data: { code: "UNAUTHORIZED", httpStatus: 401, path: "serverStatus" },
          },
        },
      ]),
    );
    const err = await queryError(client);
    const classified = classify(mod, err);
    expect(classified?.kind).toBe("procedure");
    expect(classified?.trpcCode).toBe("UNAUTHORIZED");
    expect(classified?.retryable).toBe(false);
  });

  test("B9: a fetch TypeError on a mutation maps to network, retryable", async () => {
    const mod = await importErrors();
    expect(mod?.classifyTransportError).toBeFunction();

    const client = batchClient(() => Promise.reject(new TypeError("fetch failed")));
    let err: unknown;
    try {
      await client.serverStop.mutate({ name: "x" });
    } catch (cause) {
      err = cause;
    }
    expect(err).toBeInstanceOf(TRPCClientError);

    const classified = classify(mod, err);
    expect(classified?.kind).toBe("network");
    expect(classified?.retryable).toBe(true);
  });
});

describe("classifyTransportError (#410 P4) — SSE error shapes", () => {
  test("S1: TRPCClientError.from(SuppressedError(ErrorEvent{code:401})) → invalid_session", async () => {
    const mod = await importErrors();
    expect(mod?.classifyTransportError).toBeFunction();

    const ev = new ErrorEvent("error", { code: 401, message: "Non-200 status code (401)" });
    const err = TRPCClientError.from(suppressed(ev));
    expect(err.cause).toBeUndefined();
    expect((err.shape as { code?: unknown } | undefined)?.code).toBe(401);

    const classified = classify(mod, err);
    expect(classified?.kind).toBe("invalid_session");
    expect(classified?.retryable).toBe(false);
  });

  test("S2: a SuppressedError in .cause still reaches the 401 ErrorEvent", async () => {
    const mod = await importErrors();
    expect(mod?.classifyTransportError).toBeFunction();

    const ev = new ErrorEvent("error", { code: 401, message: "Non-200 status code (401)" });
    const err = new TRPCClientError("x", { cause: suppressed(ev) });

    const classified = classify(mod, err);
    expect(classified?.kind).toBe("invalid_session");
  });

  test("S3: a SuppressedError whose .error is a dispose Error but .suppressed is a 401 ErrorEvent", async () => {
    const mod = await importErrors();
    expect(mod?.classifyTransportError).toBeFunction();

    const ev = new ErrorEvent("error", { code: 401, message: "Non-200 status code (401)" });
    const err = new TRPCClientError("x", { cause: suppressed(new Error("dispose"), ev) });

    const classified = classify(mod, err);
    expect(classified?.kind).toBe("invalid_session");
  });

  test("S4: a codeless ErrorEvent maps to network", async () => {
    const mod = await importErrors();
    expect(mod?.classifyTransportError).toBeFunction();

    const ev = new ErrorEvent("error", { message: "fetch failed" });
    const err = TRPCClientError.from(suppressed(ev));

    const classified = classify(mod, err);
    expect(classified?.kind).toBe("network");
    expect(classified?.retryable).toBe(true);
  });

  test("S5: SSE status codes map like HTTP statuses — 404 not_exposed, 400 node_not_dispatchable", async () => {
    const mod = await importErrors();
    expect(mod?.classifyTransportError).toBeFunction();

    const ev404 = new ErrorEvent("error", { code: 404, message: "Non-200 status code (404)" });
    expect(classify(mod, TRPCClientError.from(suppressed(ev404)))?.kind).toBe("not_exposed");

    const ev400 = new ErrorEvent("error", { code: 400, message: "Non-200 status code (400)" });
    expect(classify(mod, TRPCClientError.from(suppressed(ev400)))?.kind).toBe(
      "node_not_dispatchable",
    );
  });

  test("S6: a self-referential cause cycle terminates as network", async () => {
    const mod = await importErrors();
    expect(mod?.classifyTransportError).toBeFunction();

    const cyclic = new Error("cycle") as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    const err = new TRPCClientError("x", { cause: cyclic });

    const classified = classify(mod, err);
    expect(classified?.kind).toBe("network");
  });
});
