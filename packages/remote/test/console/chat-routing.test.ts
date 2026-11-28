// Issue frozename/llamactl#335 — routeConsoleChat's own decisions, which no
// merged test covers. chat.test.ts drives the route through the console
// server and pins the happy path (catalog + streamed reply), the
// GET-completions 405, an extra `tools` key as 400, client abort cancelling
// the node response body, and the local node's serving-model legs. This file
// calls routeConsoleChat directly, so every assertion lands on the route's
// own answers: which pathnames match at all, the node segment beating the
// method guard, the method guard beating node validation, node-validation
// results passed through untouched, the fail-closed catch (a 412 and a
// dial-out never leak), the 1 MiB prompt bound as 413 against the schema
// rejects as 400, catalog dedup plus every unusable catalog answer (all 502,
// >2 MiB included, never 413), upstream status mapping, and refused
// redirects.

import { afterEach, expect, test } from "bun:test";

import { routeConsoleChat } from "../../src/console/chat.js";
import { cleanupConsoleTest, gatewayNodeFixture, writeKubeconfig } from "./helpers.js";

afterEach(cleanupConsoleTest);

/** The bound routeConsoleChat puts on a chat request body. */
const MAX_PROMPT_BYTES = 1024 * 1024;
/** The bound it puts on the upstream model catalog instead. */
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
/** The bearer writeKubeconfig's `me` user carries. */
const BEARER = "Bearer tok-console-test";

const PROMPT = JSON.stringify({ model: "m", messages: [{ role: "user", content: "Hello" }] });
/** Past MAX_PROMPT_BYTES once the JSON framing is counted. */
const OVERSIZED_PROMPT = JSON.stringify({
  messages: [{ content: "x".repeat(MAX_PROMPT_BYTES), role: "user" }],
  model: "m",
});
/** A catalog the schema would accept, padded past MAX_CATALOG_BYTES. */
const OVERSIZED_CATALOG = JSON.stringify({
  data: [{ id: "m" }],
  pad: "x".repeat(MAX_CATALOG_BYTES),
});

interface SeenRequest {
  authorization: string | null;
  method: string;
  pathname: string;
}

type Script = Map<string, () => Response>;

interface FakeUpstream {
  port: number;
  seen: SeenRequest[];
  stop: () => Promise<void>;
}

/**
 * Loopback chat agent: records (method, pathname, authorization) for every
 * request and answers from `script`, 599 for anything unscripted. 599 is
 * outside every status the route maps, so an unscripted path surfaces as a
 * plain mismatch instead of a false pass.
 */
function startFakeUpstream(script: Script): FakeUpstream {
  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Response {
      const pathname = new URL(req.url).pathname;
      seen.push({
        authorization: req.headers.get("authorization"),
        method: req.method,
        pathname,
      });
      const handler = script.get(pathname);
      return handler === undefined ? new Response("unscripted", { status: 599 }) : handler();
    },
  });
  return {
    // 0 only stands in for the impossible "no port" type: an endpoint on
    // port 0 fails every request loudly instead of silently matching a node.
    port: server.port ?? 0,
    seen,
    stop: async (): Promise<void> => {
      await server.stop(true);
    },
  };
}

function fakeNode(fake: FakeUpstream): Record<string, unknown> {
  return { name: "fake", endpoint: `http://127.0.0.1:${String(fake.port)}` };
}

/** The route promise for `pathname`, skipping the console session guards. */
async function chatRoute(pathname: string, init: RequestInit = {}): Promise<Response> {
  const routed = routeConsoleChat(new Request("http://127.0.0.1/x", init), pathname);
  if (routed === null) throw new Error(`expected a route for ${pathname}`);
  return await routed;
}

/** A POST carrying `body` as the console app sends it. */
function postBody(body: string): RequestInit {
  return { body, headers: { "content-type": "application/json" }, method: "POST" };
}

function sse(text: string, status = 200): Response {
  return new Response(text, { headers: { "content-type": "text/event-stream" }, status });
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function expectJson(res: Response, status: number, error: string): Promise<void> {
  expect(res.status).toBe(status);
  expect(await jsonBody(res)).toEqual({ error });
}

async function expectPayload(
  res: Response,
  status: number,
  payload: Record<string, unknown>,
): Promise<void> {
  expect(res.status).toBe(status);
  expect(await jsonBody(res)).toEqual(payload);
}

test("only /chat/models and /chat/completions route; every other path is null", () => {
  for (const pathname of [
    "/api/n/local/chat",
    "/api/n/local/chat/",
    "/api/n/local/chat/completions/",
    "/api/n/local/chat/completions/extra",
    "/api/n/local/chat/models/",
    "/api/n/local/chat/models/extra",
    "/api/n/local/chatx/models",
    "/api/n/local/models",
    "/api/n/local/trpc/chat.models",
    "/api/chat/models",
    "/chat/completions",
  ]) {
    expect(routeConsoleChat(new Request("http://127.0.0.1/x"), pathname)).toBeNull();
  }
});

test("the two matching paths pick their own upstream leg and forward the node segment", async () => {
  const script: Script = new Map([
    ["/v1/models", (): Response => Response.json({ data: [{ id: "m" }] })],
    ["/v1/chat/completions", (): Response => sse("data: [DONE]\n\n")],
  ]);
  const fake = startFakeUpstream(script);
  try {
    writeKubeconfig({ nodes: [fakeNode(fake)] });

    await expectPayload(await chatRoute("/api/n/fake/chat/models"), 200, { models: ["m"] });
    const answer = await chatRoute("/api/n/fake/chat/completions", postBody(PROMPT));
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain("[DONE]");

    // The catalog leg is a body-less GET, the reply leg a POST, both with the
    // kubeconfig bearer and the path segment's endpoint — not the context's
    // default node.
    expect(fake.seen).toEqual([
      { authorization: BEARER, method: "GET", pathname: "/v1/models" },
      { authorization: BEARER, method: "POST", pathname: "/v1/chat/completions" },
    ]);
  } finally {
    await fake.stop();
  }
});

test("an invalid node segment beats the method guard on both paths", async () => {
  const fake = startFakeUpstream(new Map());
  try {
    writeKubeconfig({ nodes: [fakeNode(fake)] });

    // Raw segments: no decoding, so `%2F` and `%2C` are invalid characters,
    // `-bad` and `.hidden` fail the leading-character class, and the long name
    // passes the path regex (any non-slash) but not the 253-char segment cap.
    // Each one rides both paths and every method, so a method guard moved
    // ahead of the segment check answers 405 where the route answers 400.
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      for (const pathname of [
        "/api/n//chat/models",
        "/api/n/-bad/chat/completions",
        "/api/n/.hidden/chat/models",
        "/api/n/%2Ffake/chat/models",
        "/api/n/a%2Cb/chat/completions",
        `/api/n/${"n".repeat(254)}/chat/models`,
      ]) {
        await expectJson(await chatRoute(pathname, { method }), 400, "bad_node");
        // Checked per path, so a guard that moves after the fetch names the
        // path that opened the remote leg instead of failing only at the end.
        expect(fake.seen).toEqual([]);
      }
    }
    expect(fake.seen).toEqual([]);
  } finally {
    await fake.stop();
  }
});

test("models is GET-only and completions is POST-only, both before node validation", async () => {
  const fake = startFakeUpstream(new Map());
  try {
    writeKubeconfig({ nodes: [fakeNode(fake), gatewayNodeFixture("gw")] });

    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      // Validation ahead of the method guard answers 400 on the gateway node
      // and 404 on the unknown node instead of 405 on both.
      for (const node of ["fake", "gw", "ghost"]) {
        await expectJson(
          await chatRoute(`/api/n/${node}/chat/models`, { method }),
          405,
          "method_not_allowed",
        );
      }
    }
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      for (const node of ["fake", "gw", "ghost"]) {
        await expectJson(
          await chatRoute(`/api/n/${node}/chat/completions`, { method }),
          405,
          "method_not_allowed",
        );
      }
    }
    expect(fake.seen).toEqual([]);
  } finally {
    await fake.stop();
  }
});

test("node validation results pass through the chat route unchanged", async () => {
  const fake = startFakeUpstream(new Map());
  try {
    writeKubeconfig({ nodes: [fakeNode(fake), gatewayNodeFixture("gw")] });

    await expectJson(await chatRoute("/api/n/ghost/chat/models"), 404, "unknown_node");
    await expectJson(
      await chatRoute("/api/n/ghost/chat/completions", postBody(PROMPT)),
      404,
      "unknown_node",
    );
    await expectJson(await chatRoute("/api/n/gw/chat/models"), 400, "node_not_dispatchable");
    await expectJson(
      await chatRoute("/api/n/gw/chat/completions", postBody(PROMPT)),
      400,
      "node_not_dispatchable",
    );
    // Validation precedes the body read, so an undeliverable node is refused
    // on its own and never on the body's account.
    await expectJson(
      await chatRoute("/api/n/ghost/chat/completions", postBody("not json")),
      404,
      "unknown_node",
    );
    expect(fake.seen).toEqual([]);
  } finally {
    await fake.stop();
  }
});

test("anything that throws inside the route fails closed to 502, never a 412 or a dial-out", async () => {
  // validateConsoleNode maps an unreadable kubeconfig to 412, but the route
  // loads the config first and its catch maps the throw.
  writeKubeconfig({ raw: "apiVersion: [unterminated" });
  await expectJson(await chatRoute("/api/n/fake/chat/models"), 502, "model_catalog_unavailable");
  await expectJson(
    await chatRoute("/api/n/fake/chat/completions", postBody(PROMPT)),
    502,
    "chat_unavailable",
  );

  // A non-loopback node without a pinned certificate throws in
  // makePinnedFetch, so nothing is ever sent to far.invalid.
  writeKubeconfig({ nodes: [{ endpoint: "https://far.invalid:7843", name: "far" }] });
  await expectJson(await chatRoute("/api/n/far/chat/models"), 502, "model_catalog_unavailable");
  await expectJson(
    await chatRoute("/api/n/far/chat/completions", postBody(PROMPT)),
    502,
    "chat_unavailable",
  );
});

test("a prompt past 1 MiB is a 413; every schema reject stays a 400", async () => {
  const fake = startFakeUpstream(new Map());
  try {
    writeKubeconfig({ nodes: [fakeNode(fake)] });
    expect(OVERSIZED_PROMPT.length).toBeGreaterThan(MAX_PROMPT_BYTES);

    // Schema-valid apart from its size: the byte bound is what answers here.
    await expectJson(
      await chatRoute("/api/n/fake/chat/completions", postBody(OVERSIZED_PROMPT)),
      413,
      "chat_request_too_large",
    );
    expect(fake.seen).toEqual([]);

    const rejects: string[] = [
      "not json at all",
      JSON.stringify({ messages: [], model: "m" }),
      JSON.stringify({ messages: [{ content: "", role: "user" }], model: "m" }),
      JSON.stringify({ messages: [{ content: "hi", role: "system" }], model: "m" }),
      JSON.stringify({ messages: [{ content: "hi", role: "assistant" }], model: "m" }),
      JSON.stringify({ messages: [{ content: "hi", role: "user" }], model: "" }),
      JSON.stringify({ messages: [{ content: "hi", role: "user" }], model: "m".repeat(513) }),
      // The console owns streaming, so the client cannot pre-set it.
      JSON.stringify({ messages: [{ content: "hi", role: "user" }], model: "m", stream: false }),
      JSON.stringify({
        messages: Array.from(
          { length: 101 },
          (): Record<string, string> => ({
            content: "hi",
            role: "user",
          }),
        ),
        model: "m",
      }),
    ];
    for (const body of rejects) {
      await expectJson(
        await chatRoute("/api/n/fake/chat/completions", postBody(body)),
        400,
        "invalid_chat_request",
      );
    }
    // A POST with no body at all is a 400 too, not an unhandled throw.
    await expectJson(
      await chatRoute("/api/n/fake/chat/completions", { method: "POST" }),
      400,
      "invalid_chat_request",
    );
    expect(fake.seen).toEqual([]);
  } finally {
    await fake.stop();
  }
});

test("the catalog dedups ids in first-seen order and keeps only the id field", async () => {
  const script: Script = new Map([
    [
      "/v1/models",
      (): Response =>
        Response.json({
          data: [
            { created: 1, id: "beta", secret: "upstream-secret" },
            { id: "alpha" },
            { id: "beta" },
            { id: "gamma" },
          ],
        }),
    ],
  ]);
  const fake = startFakeUpstream(script);
  try {
    writeKubeconfig({ nodes: [fakeNode(fake)] });
    const res = await chatRoute("/api/n/fake/chat/models");
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ models: ["beta", "alpha", "gamma"] });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(text).not.toContain("upstream-secret");
    expect(text).not.toContain("created");
    expect(fake.seen).toEqual([{ authorization: BEARER, method: "GET", pathname: "/v1/models" }]);
  } finally {
    await fake.stop();
  }
});

test("every unusable catalog answer is 502 model_catalog_unavailable, size included", async () => {
  const script: Script = new Map();
  const fake = startFakeUpstream(script);
  try {
    writeKubeconfig({ nodes: [fakeNode(fake)] });

    // Unscripted: 599, outside the mapping, so the route reports its own 502.
    await expectJson(await chatRoute("/api/n/fake/chat/models"), 502, "model_catalog_unavailable");

    const unusable: [string, () => Response][] = [
      ["500", (): Response => new Response("boom", { status: 500 })],
      ["404", (): Response => new Response("missing", { status: 404 })],
      // Only completions maps 429/503 to a retryable busy answer.
      ["429", (): Response => new Response("busy", { status: 429 })],
      ["proxy html page", (): Response => new Response("<html>x</html>")],
      ["json with no data array", (): Response => Response.json({ models: ["m"] })],
      ["data is not an array", (): Response => Response.json({ data: "m" })],
      ["empty id", (): Response => Response.json({ data: [{ id: "" }] })],
      ["id past 512 chars", (): Response => Response.json({ data: [{ id: "m".repeat(513) }] })],
      // Past MAX_CATALOG_BYTES, and schema-valid until the size check fires:
      // the cap answers 502 here, never the 413 the prompt leg uses.
      ["past 2 MiB", (): Response => new Response(OVERSIZED_CATALOG)],
    ];
    for (const [label, make] of unusable) {
      script.set("/v1/models", make);
      const res = await chatRoute("/api/n/fake/chat/models");
      // `label` rides along in the comparison so a failure names the answer.
      expect({ label, status: res.status }).toEqual({ label, status: 502 });
      expect({ label, body: await jsonBody(res) }).toEqual({
        body: { error: "model_catalog_unavailable" },
        label,
      });
    }

    // The control: an empty catalog is a usable answer, not an error.
    script.set("/v1/models", (): Response => Response.json({ data: [] }));
    await expectPayload(await chatRoute("/api/n/fake/chat/models"), 200, { models: [] });
  } finally {
    await fake.stop();
  }
});

test("upstream completion statuses map to the console's own contract", async () => {
  const script: Script = new Map();
  const fake = startFakeUpstream(script);
  try {
    writeKubeconfig({ nodes: [fakeNode(fake)] });

    const cases: [() => Response, number, string][] = [
      [(): Response => new Response("busy", { status: 429 }), 429, "model_busy"],
      // A busy answer is still busy when the node advertises a stream.
      [(): Response => sse("data: busy\n\n", 429), 429, "model_busy"],
      [(): Response => new Response("maintenance", { status: 503 }), 503, "model_busy"],
      [(): Response => new Response("missing", { status: 404 }), 404, "model_unavailable"],
      [(): Response => new Response("rejected", { status: 400 }), 400, "model_rejected_chat"],
      [(): Response => new Response("gone", { status: 410 }), 502, "chat_unavailable"],
      [(): Response => new Response("boom", { status: 500 }), 502, "chat_unavailable"],
      // A 200 that is not an event stream is never streamed on.
      [(): Response => Response.json({ choices: [] }), 502, "chat_unavailable"],
      [(): Response => new Response("data: [DONE]\n\n"), 502, "chat_unavailable"],
      // Unscripted: 599.
      [(): Response => new Response("unscripted", { status: 599 }), 502, "chat_unavailable"],
    ];
    for (const [make, status, error] of cases) {
      script.set("/v1/chat/completions", make);
      await expectJson(
        await chatRoute("/api/n/fake/chat/completions", postBody(PROMPT)),
        status,
        error,
      );
    }
  } finally {
    await fake.stop();
  }
});

test("a 200 event stream is passed through with the console's own headers", async () => {
  const script: Script = new Map([
    [
      "/v1/chat/completions",
      (): Response =>
        new Response('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n', {
          headers: {
            "cache-control": "max-age=30",
            "content-type": "text/event-stream; charset=utf-8",
            "set-cookie": "upstream=hidden",
            "x-upstream": "visible",
          },
        }),
    ],
  ]);
  const fake = startFakeUpstream(script);
  try {
    writeKubeconfig({ nodes: [fakeNode(fake)] });
    const res = await chatRoute("/api/n/fake/chat/completions", postBody(PROMPT));
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain("Hi");
    // The upstream's charset, cache directive and cookies do not ride along.
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-upstream")).toBeNull();
  } finally {
    await fake.stop();
  }
});

test("a redirect from the node is refused on both legs, not followed", async () => {
  const script: Script = new Map();
  const fake = startFakeUpstream(script);
  try {
    writeKubeconfig({ nodes: [fakeNode(fake)] });
    const origin = `http://127.0.0.1:${String(fake.port)}`;
    script.set("/v1/models", (): Response => Response.redirect(`${origin}/elsewhere-models`, 302));
    script.set(
      "/v1/chat/completions",
      (): Response => Response.redirect(`${origin}/elsewhere-completions`, 302),
    );

    await expectJson(await chatRoute("/api/n/fake/chat/models"), 502, "model_catalog_unavailable");
    await expectJson(
      await chatRoute("/api/n/fake/chat/completions", postBody(PROMPT)),
      502,
      "chat_unavailable",
    );
    expect(fake.seen.map((entry) => entry.pathname)).toEqual([
      "/v1/models",
      "/v1/chat/completions",
    ]);
  } finally {
    await fake.stop();
  }
});
