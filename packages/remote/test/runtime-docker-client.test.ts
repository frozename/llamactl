import { describe, expect, test } from "bun:test";

import {
  createDockerClient,
  DEFAULT_SOCKET_PATH,
  DOCKER_API_VERSION,
  drainNdjson,
  failWith,
  parseJsonOrThrow,
} from "../src/runtime/docker/client.js";
import { RuntimeError } from "../src/runtime/errors.js";

/**
 * Pins the Docker Engine API client: request URL and query building,
 * transport-error mapping, error-body mapping (failWith /
 * parseJsonOrThrow) and NDJSON draining across stream chunks. Every case
 * injects fetch or builds an in-memory Response, so nothing touches a
 * real docker socket.
 */

interface Captured {
  url: string;
  init: RequestInit & { unix?: string };
}

const SOCKET = "/tmp/llamactl-test-docker.sock";

function withPreconnect(
  impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  // Bun's fetch type requires a `preconnect` method; tests never call it.
  (impl as unknown as { preconnect: (url: string) => void }).preconnect = (): undefined =>
    undefined;
  return impl as unknown as typeof fetch;
}

function recordingFetch(calls: Captured[]): typeof fetch {
  return withPreconnect((input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
}

function rejectingFetch(reason: Error): typeof fetch {
  return withPreconnect(() => Promise.reject(reason));
}

async function rejectionOf(promise: PromiseLike<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected rejection");
}

function asRuntimeError(err: unknown): RuntimeError {
  expect(err).toBeInstanceOf(RuntimeError);
  return err as RuntimeError;
}

// A 200 Response whose body arrives as exactly these byte chunks.
function chunkedResponse(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function textChunks(...parts: string[]): Uint8Array[] {
  const encoder = new TextEncoder();
  return parts.map((part) => encoder.encode(part));
}

describe("createDockerClient.request", () => {
  test("builds the versioned URL, encodes defined query values and passes init through", async () => {
    const calls: Captured[] = [];
    const client = createDockerClient({ socketPath: SOCKET, fetch: recordingFetch(calls) });
    await client.request("/containers/json", {
      method: "POST",
      body: "payload",
      query: { all: true, limit: 5, name: "a b&c", since: undefined },
    });
    expect(DOCKER_API_VERSION).toBe("v1.54");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://docker/v1.54/containers/json?all=true&limit=5&name=a+b%26c");
    expect(calls[0]?.init.unix).toBe(SOCKET);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe("payload");
    expect(Object.keys(calls[0]?.init ?? {})).not.toContain("query");
  });

  test("adds no query string when query is absent, empty or all undefined", async () => {
    const calls: Captured[] = [];
    const client = createDockerClient({ socketPath: SOCKET, fetch: recordingFetch(calls) });
    await client.request("/_ping");
    await client.request("/_ping", { query: {} });
    await client.request("/_ping", { query: { all: undefined, limit: undefined } });
    expect(calls.map((call) => call.url)).toEqual([
      "http://docker/v1.54/_ping",
      "http://docker/v1.54/_ping",
      "http://docker/v1.54/_ping",
    ]);
  });

  test("socketPath prefers the option, then DOCKER_SOCKET, then the default", () => {
    const previous = process.env["DOCKER_SOCKET"];
    try {
      process.env["DOCKER_SOCKET"] = "/tmp/llamactl-env-docker.sock";
      expect(createDockerClient({ socketPath: SOCKET }).socketPath).toBe(SOCKET);
      expect(createDockerClient().socketPath).toBe("/tmp/llamactl-env-docker.sock");
      Reflect.deleteProperty(process.env, "DOCKER_SOCKET");
      expect(createDockerClient().socketPath).toBe(DEFAULT_SOCKET_PATH);
      expect(DEFAULT_SOCKET_PATH).toBe("/var/run/docker.sock");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "DOCKER_SOCKET");
      else process.env["DOCKER_SOCKET"] = previous;
    }
  });

  test("a rejected fetch maps to backend-unreachable with the socket path in the cause", async () => {
    const transportError = new Error("connect ECONNREFUSED");
    const client = createDockerClient({
      socketPath: SOCKET,
      fetch: rejectingFetch(transportError),
    });
    const err = asRuntimeError(await rejectionOf(client.request("/_ping")));
    expect(err.code).toBe("backend-unreachable");
    expect(err.message).toBe("docker daemon unreachable (connect ECONNREFUSED)");
    const cause = err.cause as { socketPath: string; cause: unknown };
    expect(cause.socketPath).toBe(SOCKET);
    expect(cause.cause).toBe(transportError);
  });
});

describe("failWith", () => {
  test("returns a RuntimeError built from the JSON message field", async () => {
    const res = new Response(JSON.stringify({ message: "No such container: c1" }), {
      status: 404,
    });
    const err = await failWith("not-found", res, "inspect c1");
    expect(err).toBeInstanceOf(RuntimeError);
    expect(err.code).toBe("not-found");
    expect(err.message).toBe("inspect c1 failed (HTTP 404): No such container: c1");
  });

  test("falls back to the raw body for non-JSON text, JSON without a message and empty bodies", async () => {
    const rows: { body: string; status: number; expected: string }[] = [
      { body: "upstream exploded", status: 500, expected: "upstream exploded" },
      { body: '{"detail":"x"}', status: 409, expected: '{"detail":"x"}' },
      { body: '{"message":""}', status: 400, expected: '{"message":""}' },
      { body: "", status: 503, expected: "" },
    ];
    const messages: string[] = [];
    for (const row of rows) {
      const err = await failWith(
        "create-failed",
        new Response(row.body, { status: row.status }),
        "ctx",
      );
      messages.push(err.message);
    }
    expect(messages).toEqual(
      rows.map((row) => `ctx failed (HTTP ${String(row.status)}): ${row.expected}`),
    );
  });

  test("cuts the message to 300 characters", async () => {
    const res = new Response(JSON.stringify({ message: "m".repeat(400) }), { status: 400 });
    const err = await failWith("spec-invalid", res, "create svc");
    expect(err.message).toBe(`create svc failed (HTTP 400): ${"m".repeat(300)}`);
  });
});

describe("parseJsonOrThrow", () => {
  test("an empty 2xx body resolves undefined", async () => {
    expect(
      await parseJsonOrThrow<unknown>(new Response("", { status: 200 }), "not-found", "ctx"),
    ).toBeUndefined();
    expect(
      await parseJsonOrThrow<unknown>(new Response(null, { status: 204 }), "not-found", "ctx"),
    ).toBeUndefined();
  });

  test("a 2xx JSON body resolves the parsed value", async () => {
    const res = new Response(JSON.stringify({ Id: "c1", Warnings: [] }), { status: 201 });
    expect(await parseJsonOrThrow<unknown>(res, "create-failed", "create c1")).toEqual({
      Id: "c1",
      Warnings: [],
    });
  });

  test("invalid JSON on a 2xx rejects with create-failed whatever code was passed", async () => {
    // Documents current behaviour: the caller's errorCode is ignored here.
    const res = new Response("not json", { status: 200 });
    const err = asRuntimeError(await rejectionOf(parseJsonOrThrow(res, "not-found", "inspect c1")));
    expect(err.code).toBe("create-failed");
    expect(err.message).toBe("invalid JSON from docker (inspect c1)");
  });

  test("a non-2xx rejects with the caller's code through failWith", async () => {
    const res = new Response(JSON.stringify({ message: "no such image" }), { status: 404 });
    const err = asRuntimeError(
      await rejectionOf(parseJsonOrThrow(res, "not-found", "inspect img")),
    );
    expect(err.code).toBe("not-found");
    expect(err.message).toBe("inspect img failed (HTTP 404): no such image");
  });
});

describe("drainNdjson", () => {
  test("reassembles lines split across stream chunks", async () => {
    const res = chunkedResponse(
      textChunks('{"status":"Pull', 'ing fs layer"}\n{"sta', 'tus":"Done"}\n'),
    );
    expect(await drainNdjson(res, "image-pull-failed", "pull x")).toEqual([
      { status: "Pulling fs layer" },
      { status: "Done" },
    ]);
  });

  test("decodes a multibyte character split across chunks", async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('{"status":"caf\u00e9"}\n');
    // Cut between the two UTF-8 bytes of the e-acute.
    const cut = encoder.encode('{"status":"caf').length + 1;
    const res = chunkedResponse([bytes.slice(0, cut), bytes.slice(cut)]);
    expect(await drainNdjson(res, "image-pull-failed", "pull x")).toEqual([
      { status: "caf\u00e9" },
    ]);
  });

  test("skips blank, whitespace-only and malformed lines", async () => {
    const res = new Response('\n   \n{"status":"a"}\nnot json\n{"status":"b"}\n', { status: 200 });
    expect(await drainNdjson(res, "image-pull-failed", "pull x")).toEqual([
      { status: "a" },
      { status: "b" },
    ]);
  });

  test("a mid-stream error line rejects with the caller's code and context", async () => {
    const res = new Response(
      '{"status":"Pulling"}\n{"error":"manifest unknown"}\n{"status":"after"}\n',
      { status: 200 },
    );
    const err = asRuntimeError(await rejectionOf(drainNdjson(res, "image-pull-failed", "pull x")));
    expect(err.code).toBe("image-pull-failed");
    expect(err.message).toBe("pull x: manifest unknown");
  });

  test("a line whose error field is not a string is kept as a normal line", async () => {
    const res = new Response('{"error":{"code":1}}\n', { status: 200 });
    expect(await drainNdjson(res, "create-failed", "build")).toEqual([{ error: { code: 1 } }]);
  });

  test("parses a trailing line that has no newline", async () => {
    const res = new Response('{"status":"a"}\n{"status":"b"}', { status: 200 });
    expect(await drainNdjson(res, "image-pull-failed", "pull x")).toEqual([
      { status: "a" },
      { status: "b" },
    ]);
  });

  test("a trailing error line without a newline is swallowed", async () => {
    // Documents current behaviour: collectTrailingLine ignores anything that throws.
    const res = new Response('{"status":"a"}\n{"error":"late failure"}', { status: 200 });
    expect(await drainNdjson(res, "image-pull-failed", "pull x")).toEqual([{ status: "a" }]);
  });

  test("a non-2xx response rejects through failWith with the given code", async () => {
    const res = new Response(JSON.stringify({ message: "pull access denied" }), { status: 404 });
    const err = asRuntimeError(await rejectionOf(drainNdjson(res, "image-pull-failed", "pull x")));
    expect(err.code).toBe("image-pull-failed");
    expect(err.message).toBe("pull x failed (HTTP 404): pull access denied");
  });

  test("a 2xx response without a body resolves to an empty list", async () => {
    const res = new Response(null, { status: 200 });
    expect(res.body).toBeNull();
    expect(await drainNdjson(res, "image-pull-failed", "pull x")).toEqual([]);
  });
});
