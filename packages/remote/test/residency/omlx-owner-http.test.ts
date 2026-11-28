import { expect, test } from "bun:test";

import {
  createOmlxOwnerFetch,
  verifyOmlxOwnerAuthentication,
} from "../../src/residency/omlx-owner-http.js";

const OWNER_KEY = "fake-owner-only-key";
const COMPLETION_PATH = "/v1/chat/completions";
const BODY = JSON.stringify({ model: "fixture", stream: true });

test("owner inference replaces caller credentials and streams before upstream completion", async () => {
  const observed: {
    authorization: string | null;
    alternateKey: string | null;
    contentType: string | null;
    body: string;
  }[] = [];
  const closeStream = Promise.withResolvers<undefined>();
  const chunk = "data: first\n\n";
  using engine = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      observed.push({
        authorization: req.headers.get("authorization"),
        alternateKey: req.headers.get("x-api-key"),
        contentType: req.headers.get("content-type"),
        body: await req.text(),
      });
      if (req.headers.get("authorization") !== `Bearer ${OWNER_KEY}`) {
        return new Response(null, { status: 401 });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller): Promise<void> {
            controller.enqueue(new TextEncoder().encode(chunk));
            await closeStream.promise;
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const fetchOwner = createOmlxOwnerFetch(
    { host: engine.url.hostname, port: Number(engine.url.port) },
    { inferenceKey: OWNER_KEY },
  );
  try {
    const response = await fetchOwner(new URL(COMPLETION_PATH, engine.url), {
      method: "POST",
      body: BODY,
      headers: {
        authorization: "Bearer fake-caller-key",
        "x-api-key": "fake-alternate-key",
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(2000),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(observed).toEqual([
      {
        authorization: `Bearer ${OWNER_KEY}`,
        alternateKey: null,
        contentType: "application/json",
        body: BODY,
      },
    ]);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(chunk);
    closeStream.resolve(undefined);
    expect((await reader.read()).done).toBe(true);
  } finally {
    closeStream.resolve(undefined);
  }
});

test("owner inference refuses native control paths without dialing the listener", async () => {
  let calls = 0;
  using engine = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return new Response(null, { status: 204 });
    },
  });
  const fetchOwner = createOmlxOwnerFetch(
    { host: engine.url.hostname, port: Number(engine.url.port) },
    { inferenceKey: OWNER_KEY },
  );
  let refused = false;
  try {
    await fetchOwner(new URL("/v1/models/fixture/load", engine.url), {
      method: "POST",
      body: BODY,
    });
  } catch {
    refused = true;
  }
  expect({ refused, calls }).toEqual({ refused: true, calls: 0 });
});

test.each(["reader", "signal"])(
  "owner inference closes the upstream on %s cancellation",
  async (mode) => {
    const closed = Promise.withResolvers<undefined>();
    using engine = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.enqueue(new TextEncoder().encode("data: first\n\n"));
            },
            cancel(): void {
              closed.resolve(undefined);
            },
          }),
        );
      },
    });
    const fetchOwner = createOmlxOwnerFetch(
      { host: engine.url.hostname, port: Number(engine.url.port) },
      { inferenceKey: OWNER_KEY },
    );
    const controller = new AbortController();
    try {
      const response = await fetchOwner(new URL(COMPLETION_PATH, engine.url), {
        method: "POST",
        body: BODY,
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      if (mode === "reader") await reader.cancel();
      else controller.abort();
      const outcome = await Promise.race([
        closed.promise.then(() => "closed"),
        Bun.sleep(1000).then(() => "open"),
      ]);
      expect(outcome).toBe("closed");
    } finally {
      controller.abort();
    }
  },
);

test("owner inference sends nothing to alternate origins, redirect targets or ambient proxies", async () => {
  let observerHits = 0;
  using observer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      observerHits++;
      return new Response(null, { status: 502 });
    },
  });
  const requests: (string | null)[] = [];
  using engine = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request.headers.get("authorization"));
      return Response.redirect(String(new URL(COMPLETION_PATH, observer.url)), 307);
    },
  });
  const proxyEnv = {
    HTTP_PROXY: String(observer.url),
    http_proxy: String(observer.url),
    NO_PROXY: "",
    no_proxy: "",
  };
  const saved = Object.entries(proxyEnv).map(([name]) => [name, process.env[name]] as const);
  Object.assign(process.env, proxyEnv);
  try {
    const fetchOwner = createOmlxOwnerFetch(
      { host: engine.url.hostname, port: Number(engine.url.port) },
      { inferenceKey: OWNER_KEY },
    );
    const init = { method: "POST", body: BODY, signal: AbortSignal.timeout(1000) };
    const alternate = await fetchOwner(new URL(COMPLETION_PATH, observer.url), init).catch(
      (error: unknown) => error,
    );
    const redirect = await fetchOwner(new URL(COMPLETION_PATH, engine.url), init).catch(
      (error: unknown) => error,
    );
    expect(alternate).toMatchObject({ message: "Owner oMLX endpoint changed" });
    expect(redirect).toMatchObject({ message: "Owner oMLX endpoint redirected" });
    expect({ observerHits, requests }).toEqual({
      observerHits: 0,
      requests: [`Bearer ${OWNER_KEY}`],
    });
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
});

test("a native listener must reject anonymous data and control requests and prove its version", async () => {
  let anonymousPath: string | undefined;
  let version = "0.8.4";
  const seen: [string, string | null][] = [];
  using engine = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      const path = new URL(request.url).pathname;
      const authorization = request.headers.get("authorization");
      seen.push([path, authorization]);
      if (authorization !== `Bearer ${OWNER_KEY}` && path !== anonymousPath) {
        return new Response(null, { status: 401 });
      }
      return Response.json(path === "/api/status" ? { version } : { data: [{ id: "fixture" }] });
    },
  });
  const endpoint = { host: engine.url.hostname, port: Number(engine.url.port) };
  const verify = (): Promise<boolean> =>
    verifyOmlxOwnerAuthentication({
      endpoint,
      apiKey: OWNER_KEY,
      modelId: "fixture",
      signal: AbortSignal.timeout(1500),
    });
  expect(await verify()).toBe(true);
  const required: typeof seen = [
    ["/api/status", null],
    ["/v1/models", null],
    ["/api/status", `Bearer ${OWNER_KEY}`],
    ["/v1/models", `Bearer ${OWNER_KEY}`],
  ];
  expect(seen).toHaveLength(required.length);
  for (const proof of required) expect(seen).toContainEqual(proof);
  anonymousPath = "/v1/models";
  expect(await verify()).toBe(false);
  anonymousPath = "/api/status";
  expect(await verify()).toBe(false);
  anonymousPath = undefined;
  version = "0.8.5";
  expect(await verify()).toBe(false);
});
