// Issue frozename/llamactl#335 — the console request-inspector route's own
// guards and its remote capture error mapping, which no merged test covers:
// #890 pinned only the happy path plus the disabled-catalog case through the
// console server, and #906 pins the capture store. These call
// routeRequestInspector directly (request-inspector.test.ts and
// routing.test.ts already pin the session guard) so every assertion lands on
// the route's decisions: which paths match, the node segment before the id
// and the method, the id shape before any upstream fetch, the method guard,
// node validation pass-through, the fail-closed catch, passthrough headers,
// upstream status mapping and refused redirects.

import { afterEach, expect, test } from "bun:test";

import { routeRequestInspector } from "../../src/console/request-inspector.js";
import { cleanupConsoleTest, gatewayNodeFixture, setEnv, writeKubeconfig } from "./helpers.js";

afterEach(cleanupConsoleTest);

const ID = "5f512abf-b81a-4612-a7df-0881d0e7171d";
/** The bearer writeKubeconfig's `me` user carries. */
const BEARER = "Bearer tok-console-test";

interface SeenRequest {
  authorization: string | null;
  pathname: string;
}

type Script = Map<string, () => Response>;

interface FakeUpstream {
  port: number;
  seen: SeenRequest[];
  stop: () => Promise<void>;
}

/**
 * Loopback capture agent: records (pathname, authorization) for every
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
      seen.push({ authorization: req.headers.get("authorization"), pathname });
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

/** The route promise for `pathname`, skipping the console session guard. */
async function inspectRoute(pathname: string, method = "GET"): Promise<Response> {
  const routed = routeRequestInspector(new Request("http://127.0.0.1/x", { method }), pathname);
  if (routed === null) throw new Error(`expected a route for ${method} ${pathname}`);
  return await routed;
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function expectJson(
  res: Response,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  expect(res.status).toBe(status);
  expect(await jsonBody(res)).toEqual(body);
}

test("only the two request-inspector paths match; everything else is null", async () => {
  writeKubeconfig();
  setEnv("LLAMACTL_REQUEST_CAPTURE_FILE", undefined);

  for (const pathname of [
    "/api/n/local/trpc/env",
    "/api/n/local/requests/a/b",
    "/api/requests",
    "/api/n/local/requestsx",
  ]) {
    expect(routeRequestInspector(new Request("http://127.0.0.1/x"), pathname)).toBeNull();
  }

  // Awaited, so a rejected promise fails here rather than passing unnoticed.
  await expectJson(await inspectRoute("/api/n/local/requests"), 200, {
    enabled: false,
    requests: [],
  });
  await expectJson(await inspectRoute(`/api/n/local/requests/${ID}`), 404, {
    error: "request_not_found",
  });
});

test("an invalid node segment beats the id check and the method check", async () => {
  writeKubeconfig();
  setEnv("LLAMACTL_REQUEST_CAPTURE_FILE", undefined);

  // Raw segments: no decoding, so %2F and %2C are invalid characters, and
  // the last one pairs a bad segment with a well-formed id.
  for (const method of ["GET", "POST"]) {
    for (const pathname of [
      "/api/n//requests",
      "/api/n/-bad/requests",
      "/api/n/%2Flocal/requests",
      `/api/n/a%2Cb/requests/${ID}`,
    ]) {
      await expectJson(await inspectRoute(pathname, method), 400, { error: "bad_node" });
    }
  }
});

test("a malformed request id beats the method check and any upstream fetch", async () => {
  const fake = startFakeUpstream(new Map());
  try {
    writeKubeconfig({ nodes: [fakeNode(fake)] });
    setEnv("LLAMACTL_REQUEST_CAPTURE_FILE", undefined);

    // REQUEST_ID is lowercase-only, so the upper-cased id is malformed too;
    // `fake` proves the guard runs before the remote leg, not just for local.
    for (const method of ["GET", "DELETE"]) {
      for (const pathname of [
        "/api/n/local/requests/not-a-uuid",
        `/api/n/local/requests/${ID.toUpperCase()}`,
        "/api/n/fake/requests/not-a-uuid",
        `/api/n/fake/requests/${ID.toUpperCase()}`,
      ]) {
        await expectJson(await inspectRoute(pathname, method), 404, { error: "request_not_found" });
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

test("non-GET methods are refused on both routes", async () => {
  writeKubeconfig();
  setEnv("LLAMACTL_REQUEST_CAPTURE_FILE", undefined);

  await expectJson(await inspectRoute("/api/n/local/requests", "POST"), 405, {
    error: "method_not_allowed",
  });
  await expectJson(await inspectRoute(`/api/n/local/requests/${ID}`, "PUT"), 405, {
    error: "method_not_allowed",
  });
});

test("node validation results pass through the inspector unchanged", async () => {
  writeKubeconfig();
  setEnv("LLAMACTL_REQUEST_CAPTURE_FILE", undefined);

  await expectJson(await inspectRoute("/api/n/ghost/requests"), 404, { error: "unknown_node" });

  writeKubeconfig({ nodes: [gatewayNodeFixture("gw")] });
  await expectJson(await inspectRoute("/api/n/gw/requests"), 400, {
    error: "node_not_dispatchable",
  });
});

test("anything that throws inside the route is a 502, never a 412 or a dial-out", async () => {
  // validateConsoleNode maps an unreadable kubeconfig to 412, but the route
  // catches the loadConfig throw first.
  writeKubeconfig({ raw: "apiVersion: [unterminated" });
  setEnv("LLAMACTL_REQUEST_CAPTURE_FILE", undefined);
  await expectJson(await inspectRoute("/api/n/local/requests"), 502, {
    error: "capture_unavailable",
  });

  // A non-loopback node without a pinned certificate throws in
  // makePinnedFetch, so nothing is ever sent to far.invalid.
  writeKubeconfig({ nodes: [{ name: "far", endpoint: "https://far.invalid:7843" }] });
  await expectJson(await inspectRoute("/api/n/far/requests"), 502, {
    error: "capture_unavailable",
  });
});

test("a remote capture list and detail pass through with no-store and a bearer token", async () => {
  const list = { enabled: true, requests: [{ id: ID }] };
  const detail = { id: ID, path: "/v1/chat/completions", status: 200 };
  const json = (payload: unknown): Response =>
    // The upstream's charset must not leak: the route re-stamps content-type.
    new Response(JSON.stringify(payload), {
      headers: { "cache-control": "max-age=60", "content-type": "application/json; charset=utf-8" },
      status: 200,
    });

  const script: Script = new Map([["/fleet/request-capture", (): Response => json(list)]]);
  const fake = startFakeUpstream(script);
  try {
    writeKubeconfig({ nodes: [fakeNode(fake)] });
    setEnv("LLAMACTL_REQUEST_CAPTURE_FILE", undefined);

    const res = await inspectRoute("/api/n/fake/requests");
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual(list);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(fake.seen).toEqual([{ authorization: BEARER, pathname: "/fleet/request-capture" }]);

    script.set(`/fleet/request-capture/${ID}`, (): Response => json(detail));
    const routed = await inspectRoute(`/api/n/fake/requests/${ID}`);
    expect(routed.status).toBe(200);
    expect(await jsonBody(routed)).toEqual(detail);
    expect(fake.seen[1]?.pathname).toBe(`/fleet/request-capture/${ID}`);
    expect(fake.seen[1]?.authorization).toBe(BEARER);
  } finally {
    await fake.stop();
  }
});

test("upstream statuses map to the console's own contract, all no-store", async () => {
  const script: Script = new Map([
    ["/fleet/request-capture", (): Response => new Response("missing", { status: 404 })],
    [`/fleet/request-capture/${ID}`, (): Response => new Response("missing", { status: 404 })],
  ]);
  const fake = startFakeUpstream(script);
  try {
    writeKubeconfig({ nodes: [fakeNode(fake)] });
    setEnv("LLAMACTL_REQUEST_CAPTURE_FILE", undefined);

    // A node with capture disabled answers 404 on the catalog: the console
    // reads that as an empty catalog, but only on the list route.
    const list = await inspectRoute("/api/n/fake/requests");
    await expectJson(list, 200, { enabled: false, requests: [] });
    expect(list.headers.get("cache-control")).toBe("no-store");

    const detail = await inspectRoute(`/api/n/fake/requests/${ID}`);
    await expectJson(detail, 404, { error: "request_not_found" });
    expect(detail.headers.get("cache-control")).toBe("no-store");

    script.set("/fleet/request-capture", (): Response => new Response("boom", { status: 500 }));
    script.set(
      `/fleet/request-capture/${ID}`,
      (): Response => new Response("down", { status: 503 }),
    );
    const listFailed = await inspectRoute("/api/n/fake/requests");
    await expectJson(listFailed, 502, { error: "capture_unavailable" });
    expect(listFailed.headers.get("cache-control")).toBe("no-store");

    const detailFailed = await inspectRoute(`/api/n/fake/requests/${ID}`);
    await expectJson(detailFailed, 502, { error: "capture_unavailable" });
    expect(detailFailed.headers.get("cache-control")).toBe("no-store");

    // A 200 that is not JSON (a proxy error page) is never streamed on.
    script.set(
      "/fleet/request-capture",
      (): Response =>
        new Response("<html>proxy</html>", { headers: { "content-type": "text/html" } }),
    );
    const html = await inspectRoute("/api/n/fake/requests");
    await expectJson(html, 502, { error: "capture_unavailable" });
    expect(html.headers.get("cache-control")).toBe("no-store");
  } finally {
    await fake.stop();
  }
});

test("a redirect from the upstream is refused, not followed", async () => {
  const script: Script = new Map();
  const fake = startFakeUpstream(script);
  try {
    writeKubeconfig({ nodes: [fakeNode(fake)] });
    setEnv("LLAMACTL_REQUEST_CAPTURE_FILE", undefined);

    script.set(
      "/fleet/request-capture",
      (): Response => Response.redirect(`http://127.0.0.1:${String(fake.port)}/elsewhere`, 302),
    );
    await expectJson(await inspectRoute("/api/n/fake/requests"), 502, {
      error: "capture_unavailable",
    });
    expect(fake.seen.map((entry) => entry.pathname)).toEqual(["/fleet/request-capture"]);
  } finally {
    await fake.stop();
  }
});
