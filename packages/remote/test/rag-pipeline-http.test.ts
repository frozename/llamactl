import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { RawDoc } from "../src/rag/pipeline/types.js";

import {
  __crawlWithResolver,
  extractLinks,
  extractReadableText,
  httpFetcher,
  parseRobots,
} from "../src/rag/pipeline/fetchers/http.js";
import { assertPublicUrl, SsrfBlockedError } from "../src/rag/pipeline/fetchers/ssrf-guard.js";

interface PageSpec {
  html?: string;
  contentType?: string;
  /** When set, the page responds 302 to this Location instead of HTML.
   *  `(origin) => string` lets a test target the *other* server whose
   *  port is only known after it starts. */
  redirectTo?: string | ((selfOrigin: string) => string);
}

interface ServerOptions {
  robots?: string | null;
  authRequired?: string;
  pages: Record<string, PageSpec>;
}

interface FakeServer {
  origin: string;
  calls: { method: string; path: string; auth: string | null }[];
  stop: () => Promise<void>;
}

async function startFakeSite(opts: ServerOptions): Promise<FakeServer> {
  await Promise.resolve();
  const calls: FakeServer["calls"] = [];
  let selfOrigin = "";

  const server = (
    Bun as unknown as {
      serve: (o: unknown) => {
        hostname: string;
        port: number;
        stop: (force?: boolean) => Promise<void>;
      };
    }
  ).serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req: Request) {
      await Promise.resolve();
      const url = new URL(req.url);
      calls.push({
        method: req.method,
        path: url.pathname,
        auth: req.headers.get("authorization"),
      });
      if (url.pathname === "/robots.txt") {
        if (opts.robots === null) {
          return new Response("not found", { status: 404 });
        }
        return new Response(opts.robots ?? "", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      if (opts.authRequired) {
        const got = req.headers.get("authorization") ?? "";
        if (got !== `Bearer ${opts.authRequired}`) {
          return new Response("unauthorized", { status: 401 });
        }
      }
      const page = opts.pages[url.pathname];
      if (!page) return new Response("not found", { status: 404 });
      if (page.redirectTo !== undefined) {
        const location =
          typeof page.redirectTo === "function" ? page.redirectTo(selfOrigin) : page.redirectTo;
        return new Response("", { status: 302, headers: { location } });
      }
      return new Response(page.html ?? "", {
        status: 200,
        headers: { "content-type": page.contentType ?? "text/html" },
      });
    },
  });
  selfOrigin = `http://127.0.0.1:${String(server.port)}`;
  return {
    origin: selfOrigin,
    calls,
    stop: async (): Promise<void> => {
      await server.stop(true);
    },
  };
}

async function runRaw(
  spec: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ docs: RawDoc[]; logs: { level: string; msg: string }[] }> {
  const logs: { level: string; msg: string }[] = [];
  const ctx = {
    spec,
    log: (e: { level: "info" | "warn" | "error"; msg: string }): number =>
      logs.push({ level: e.level, msg: e.msg }),
    signal: new AbortController().signal,
    env,
  };
  const docs: RawDoc[] = [];
  for await (const doc of httpFetcher.fetch(ctx)) docs.push(doc);
  return { docs, logs };
}

/**
 * Default harness helper: the fake server binds to 127.0.0.1, which
 * the SSRF guard rejects by default. These tests legitimately target
 * loopback, so opt in via `allow_private_targets` unless the spec
 * already set it.
 */
async function run(
  spec: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ docs: RawDoc[]; logs: { level: string; msg: string }[] }> {
  const withEscape = { allow_private_targets: true, ...spec };
  return await runRaw(withEscape, env);
}

let srv: FakeServer | null = null;

beforeEach(() => {
  srv = null;
});

afterEach(async () => {
  if (srv) await srv.stop();
  srv = null;
});

describe("httpFetcher", () => {
  test("depth=0 fetches only the start URL", async () => {
    srv = await startFakeSite({
      pages: {
        "/": { html: '<html><body>root <a href="/a">a</a></body></html>' },
        "/a": { html: "<html><body>inner</body></html>" },
      },
    });
    const { docs } = await run({
      kind: "http",
      url: `${srv.origin}/`,
      max_depth: 0,
      rate_limit_per_sec: 100,
    });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.id).toBe(`${srv.origin}/`);
  });

  test("depth=1 follows one hop", async () => {
    srv = await startFakeSite({
      pages: {
        "/": {
          html: '<html><body>root <a href="/a">a</a> <a href="/b">b</a></body></html>',
        },
        "/a": { html: "<html><body>a page</body></html>" },
        "/b": { html: "<html><body>b page</body></html>" },
      },
    });
    const { docs } = await run({
      kind: "http",
      url: `${srv.origin}/`,
      max_depth: 1,
      rate_limit_per_sec: 100,
    });
    const ids = docs.map((d) => d.id).sort();
    expect(ids).toEqual([`${srv.origin}/`, `${srv.origin}/a`, `${srv.origin}/b`].sort());
  });

  test("same_origin filters off-site links", async () => {
    srv = await startFakeSite({
      pages: {
        "/": {
          html:
            "<html><body>" +
            '<a href="https://other.example/x">offsite</a>' +
            '<a href="/local">local</a>' +
            "</body></html>",
        },
        "/local": { html: "<html><body>local page</body></html>" },
      },
    });
    const { docs } = await run({
      kind: "http",
      url: `${srv.origin}/`,
      max_depth: 1,
      same_origin: true,
      rate_limit_per_sec: 100,
    });
    const ids = docs.map((d) => d.id).sort();
    expect(ids).toEqual([`${srv.origin}/`, `${srv.origin}/local`].sort());
    // None of the recorded calls should target the offsite URL.
    expect(srv.calls.every((c) => !c.path.includes("/x"))).toBe(true);
  });

  test("robots.txt Disallow blocks the forbidden path", async () => {
    srv = await startFakeSite({
      robots: "User-agent: *\nDisallow: /private\n",
      pages: {
        "/": {
          html: '<html><body><a href="/public">ok</a><a href="/private">no</a></body></html>',
        },
        "/public": { html: "<html><body>public</body></html>" },
        "/private": { html: "<html><body>private</body></html>" },
      },
    });
    const { docs } = await run({
      kind: "http",
      url: `${srv.origin}/`,
      max_depth: 1,
      rate_limit_per_sec: 100,
    });
    const ids = docs.map((d) => d.id);
    expect(ids).toContain(`${srv.origin}/public`);
    expect(ids).not.toContain(`${srv.origin}/private`);
  });

  test("ignore_robots: true bypasses robots.txt", async () => {
    srv = await startFakeSite({
      robots: "User-agent: *\nDisallow: /private\n",
      pages: {
        "/": {
          html: '<html><body><a href="/private">p</a></body></html>',
        },
        "/private": { html: "<html><body>private content</body></html>" },
      },
    });
    const { docs } = await run({
      kind: "http",
      url: `${srv.origin}/`,
      max_depth: 1,
      ignore_robots: true,
      rate_limit_per_sec: 100,
    });
    const ids = docs.map((d) => d.id);
    expect(ids).toContain(`${srv.origin}/private`);
  });

  test("auth.tokenRef resolves via env: and sends Bearer header", async () => {
    srv = await startFakeSite({
      authRequired: "secret-token",
      pages: {
        "/": { html: "<html><body>authed</body></html>" },
      },
    });
    const { docs } = await run(
      {
        kind: "http",
        url: `${srv.origin}/`,
        max_depth: 0,
        rate_limit_per_sec: 100,
        auth: { tokenRef: "env:HTTP_FETCHER_TEST_TOKEN" },
      },
      { ...process.env, HTTP_FETCHER_TEST_TOKEN: "secret-token" },
    );
    expect(docs).toHaveLength(1);
    // Every non-robots call should carry the Bearer header.
    const docCalls = srv.calls.filter((c) => c.path !== "/robots.txt");
    expect(docCalls.every((c) => c.auth === "Bearer secret-token")).toBe(true);
  });

  test("does not revisit a URL within the same run", async () => {
    srv = await startFakeSite({
      pages: {
        "/": {
          html: '<html><body><a href="/a">a</a><a href="/a">again</a></body></html>',
        },
        "/a": { html: "<html><body>one</body></html>" },
      },
    });
    await run({
      kind: "http",
      url: `${srv.origin}/`,
      max_depth: 1,
      rate_limit_per_sec: 100,
    });
    // `/a` should be requested at most once.
    const aCalls = srv.calls.filter((c) => c.path === "/a");
    expect(aCalls.length).toBe(1);
  });

  test("missing robots.txt treated as permissive", async () => {
    srv = await startFakeSite({
      robots: null,
      pages: {
        "/": { html: "<html><body>ok</body></html>" },
      },
    });
    const { docs } = await run({
      kind: "http",
      url: `${srv.origin}/`,
      max_depth: 0,
      rate_limit_per_sec: 100,
    });
    expect(docs).toHaveLength(1);
  });
});

describe("extractReadableText", () => {
  test("strips scripts, styles, and nav", () => {
    const html =
      "<html><head><style>body{}</style></head>" +
      "<body><nav>skip</nav><main>Hello <b>world</b>.</main>" +
      "<script>alert(1)</script></body></html>";
    const text = extractReadableText(html);
    expect(text).toContain("Hello");
    expect(text).toContain("world");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("skip");
  });
});

describe("extractLinks", () => {
  test("resolves relative URLs against base", () => {
    const base = new URL("https://example.com/dir/");
    const links = extractLinks('<a href="a.html">a</a><a href="/b">b</a>', base);
    expect(links).toContain("https://example.com/dir/a.html");
    expect(links).toContain("https://example.com/b");
  });
});

describe("parseRobots", () => {
  test("captures Disallow entries under User-agent: *", () => {
    const r = parseRobots(
      [
        "User-agent: bot",
        "Disallow: /not-me",
        "",
        "User-agent: *",
        "Disallow: /private",
        "Disallow: /secret",
      ].join("\n"),
    );
    expect(r).toEqual(["/private", "/secret"]);
  });
});

/** Assert the guard rejects a URL with an `SsrfBlockedError`. Returns
 *  the caught error so callers can make further assertions. */
async function expectBlocked(
  url: string,
  opts?: { allowPrivate?: boolean; resolve?: (host: string) => Promise<string[]> },
): Promise<void> {
  let caught: unknown;
  try {
    await assertPublicUrl(url, opts);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SsrfBlockedError);
}

/** Assert the guard allows a URL (resolves without throwing). */
async function expectAllowed(
  url: string,
  opts?: { allowPrivate?: boolean; resolve?: (host: string) => Promise<string[]> },
): Promise<void> {
  let threw = false;
  try {
    await assertPublicUrl(url, opts);
  } catch {
    threw = true;
  }
  expect(threw).toBe(false);
}

describe("assertPublicUrl (SSRF guard)", () => {
  test("rejects loopback IPv4 literals", async () => {
    await expectBlocked("http://127.0.0.1/");
    await expectBlocked("http://127.1.2.3:8080/admin");
  });

  test("rejects link-local / cloud metadata", async () => {
    await expectBlocked("http://169.254.169.254/latest/meta-data/");
  });

  test("rejects RFC1918 private ranges", async () => {
    await expectBlocked("http://10.0.0.1/");
    await expectBlocked("http://172.16.5.4/");
    await expectBlocked("http://192.168.1.1/");
  });

  test("rejects 0.0.0.0 and the localhost name", async () => {
    await expectBlocked("http://0.0.0.0/");
    await expectBlocked("http://localhost/");
    await expectBlocked("http://sub.localhost/");
  });

  test("rejects IPv6 loopback, link-local, and ULA", async () => {
    await expectBlocked("http://[::1]/");
    await expectBlocked("http://[fe80::1]/");
    await expectBlocked("http://[fc00::1]/");
    // IPv4-mapped loopback must not slip through.
    await expectBlocked("http://[::ffff:127.0.0.1]/");
  });

  test("rejects bracketed IPv6 literals via the literal path, not DNS fallback", async () => {
    // WHATWG `new URL('http://[::1]/').hostname` keeps the brackets
    // ('[::1]'), so a naive `isIP(host)` returns 0 and the literal
    // would fall through to DNS resolution as if it were a hostname.
    // Inject a resolver that returns a PUBLIC IP: if the guard ever
    // consulted DNS for one of these literals it would WRONGLY allow
    // it. A rejection here proves the bracket-stripping literal path
    // classifies and blocks the address before any resolver is asked.
    const resolvePublic = (): Promise<string[]> => Promise.resolve(["93.184.216.34"]);
    for (const url of [
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      // IPv4-mapped cloud metadata (169.254.169.254) — must be checked
      // against its embedded IPv4 class, not treated as a hostname.
      "http://[::ffff:169.254.169.254]/",
      "http://[fc00::1]/",
      "http://[fe80::1]/",
    ]) {
      await expectBlocked(url, { resolve: resolvePublic });
    }
  });

  test("rejects non-http(s) schemes", async () => {
    await expectBlocked("file:///etc/passwd");
    await expectBlocked("gopher://example.com/");
  });

  test("rejects a hostname that DNS-resolves to a private IP (rebinding)", async () => {
    const resolve = (): Promise<string[]> => Promise.resolve(["10.0.0.5"]);
    await expectBlocked("http://rebind.evil.test/", { resolve });
  });

  test("allows a public IP literal and a host resolving to a public IP", async () => {
    await expectAllowed("http://93.184.216.34/");
    const resolve = (): Promise<string[]> => Promise.resolve(["93.184.216.34"]);
    await expectAllowed("https://docs.example.com/", { resolve });
  });

  test("allow_private_targets escape hatch is a no-op", async () => {
    await expectAllowed("http://127.0.0.1/", { allowPrivate: true });
  });
});

describe("httpFetcher SSRF guard (integration)", () => {
  test("blocks loopback start URL when escape hatch is off", async () => {
    srv = await startFakeSite({
      pages: { "/": { html: "<html><body>internal admin</body></html>" } },
    });
    // No allow_private_targets → guard must reject the loopback target.
    const { docs, logs } = await runRaw({
      kind: "http",
      url: `${srv.origin}/`,
      max_depth: 0,
      rate_limit_per_sec: 100,
    });
    expect(docs).toHaveLength(0);
    // The SSRF gate runs before robots.txt — the server must never be
    // hit at all (not even for robots).
    expect(srv.calls).toHaveLength(0);
    expect(logs.some((l) => l.level === "warn" || l.level === "error")).toBe(true);
  });

  test("blocks a private link discovered mid-crawl", async () => {
    // Start page links to cloud metadata. The escape hatch is OFF, so
    // the start (loopback) is itself blocked — proving the guard runs
    // on every queue entry, not just the manifest URL. (A reachable
    // public start that crawls into a private link can't be expressed
    // in-process without real DNS; the per-target guard is unit-tested
    // directly in `assertPublicUrl` against 169.254.169.254 et al.)
    srv = await startFakeSite({
      pages: {
        "/": {
          html:
            "<html><body>" +
            '<a href="http://169.254.169.254/latest/meta-data/">metadata</a>' +
            "</body></html>",
        },
      },
    });
    const { docs } = await runRaw({
      kind: "http",
      url: `${srv.origin}/`,
      max_depth: 1,
      same_origin: false,
      rate_limit_per_sec: 100,
    });
    // Nothing fetched — neither the loopback start nor the metadata link.
    expect(docs).toHaveLength(0);
    expect(srv.calls).toHaveLength(0);
  });
});

describe("httpFetcher cross-origin redirect token handling", () => {
  let other: FakeServer | null = null;
  afterEach(async () => {
    if (other) await other.stop();
    other = null;
  });

  test("strips Authorization when a redirect crosses origins", async () => {
    // `other` is a different loopback origin (different port).
    other = await startFakeSite({
      authRequired: undefined,
      pages: { "/landing": { html: "<html><body>cross-origin landing</body></html>" } },
    });
    const otherOrigin = other.origin;
    srv = await startFakeSite({
      pages: {
        "/": { redirectTo: () => `${otherOrigin}/landing` },
      },
    });

    const { docs } = await run(
      {
        kind: "http",
        url: `${srv.origin}/`,
        max_depth: 0,
        same_origin: false,
        rate_limit_per_sec: 100,
        auth: { tokenRef: "env:HTTP_FETCHER_TEST_TOKEN" },
      },
      { ...process.env, HTTP_FETCHER_TEST_TOKEN: "secret-token" },
    );

    expect(docs).toHaveLength(1);
    expect(docs[0]!.content).toContain("cross-origin landing");
    // The cross-origin server must NOT have received the Bearer token.
    const otherDocCalls = other.calls.filter((c) => c.path !== "/robots.txt");
    expect(otherDocCalls.length).toBeGreaterThan(0);
    expect(otherDocCalls.every((c) => c.auth === null)).toBe(true);
    // The original origin DID receive the token (on the redirecting request).
    const srvDocCalls = srv.calls.filter((c) => c.path === "/");
    expect(srvDocCalls.some((c) => c.auth === "Bearer secret-token")).toBe(true);
  });

  test("keeps Authorization across a same-origin redirect", async () => {
    srv = await startFakeSite({
      authRequired: "secret-token",
      pages: {
        "/": { redirectTo: (self) => `${self}/landing` },
        "/landing": { html: "<html><body>same-origin landing</body></html>" },
      },
    });

    const { docs } = await run(
      {
        kind: "http",
        url: `${srv.origin}/`,
        max_depth: 0,
        same_origin: false,
        rate_limit_per_sec: 100,
        auth: { tokenRef: "env:HTTP_FETCHER_TEST_TOKEN" },
      },
      { ...process.env, HTTP_FETCHER_TEST_TOKEN: "secret-token" },
    );

    expect(docs).toHaveLength(1);
    expect(docs[0]!.content).toContain("same-origin landing");
    // The landing request kept the Bearer token (same origin → no strip).
    const landingCalls = srv.calls.filter((c) => c.path === "/landing");
    expect(landingCalls.length).toBeGreaterThan(0);
    expect(landingCalls.every((c) => c.auth === "Bearer secret-token")).toBe(true);
  });
});

describe("httpFetcher robots.txt redirect is guarded", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("a robots.txt that 302s to a private target is refused, target never fetched", async () => {
    // Model a PUBLIC host (resolves to a public IP, so the SSRF guard
    // admits the start and its /robots.txt) whose /robots.txt 302s to a
    // private literal (cloud metadata). The page path follows redirects
    // through the guarded fetch; before this fix the robots path used a
    // bare `fetch` with the default 'follow' redirect mode and no
    // per-hop guard, so the private target was fetched unguarded.
    const PUBLIC_HOST = "http://docs.public.test";
    const PRIVATE = "http://169.254.169.254/robots.txt";
    const fetched: string[] = [];

    // Resolve one URL to a Response (no redirect-following — the caller
    // models 'manual' vs 'follow' below).
    const respondTo = (u: string): Response => {
      if (u === `${PUBLIC_HOST}/robots.txt`) {
        // Redirect robots.txt to the private metadata endpoint.
        return new Response("", { status: 302, headers: { location: PRIVATE } });
      }
      if (u === PRIVATE) {
        // If the guard is bypassed this serves a permissive robots —
        // reaching here at all (fetched) is the vulnerability.
        return new Response("User-agent: *\nDisallow:\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      if (u === `${PUBLIC_HOST}/`) {
        return new Response("<html><body>public page</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    // Emulate the platform `fetch` faithfully: with the default
    // `redirect: 'follow'` (or any non-'manual' mode) a 3xx is followed
    // automatically, issuing a real request to the Location — so an
    // UNGUARDED robots fetch would hit the private target. With
    // `redirect: 'manual'` the 3xx is returned as-is, letting the caller
    // re-check the guard before the next hop. `fetched` records every URL
    // actually requested.
    const isRedirectStatus = (s: number): boolean =>
      s === 301 || s === 302 || s === 303 || s === 307 || s === 308;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      let u =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const mode = init?.redirect ?? "follow";
      for (let i = 0; i < 5; i++) {
        fetched.push(u);
        const res = respondTo(u);
        if (mode === "manual" || !isRedirectStatus(res.status)) return Promise.resolve(res);
        const loc = res.headers.get("location");
        if (loc === null || loc === "") return Promise.resolve(res);
        u = new URL(loc, u).toString();
      }
      return Promise.resolve(new Response("too many redirects", { status: 599 }));
    }) as typeof fetch;

    // The injected resolver makes the public host resolve to a public IP,
    // so the guard admits the start and the robots host; the private
    // literal in the redirect Location is still classified directly.
    const resolve = (host: string): Promise<string[]> =>
      host === "docs.public.test" ? Promise.resolve(["93.184.216.34"]) : Promise.resolve([]);

    const ctx = {
      spec: {
        kind: "http",
        url: `${PUBLIC_HOST}/`,
        max_depth: 0,
        rate_limit_per_sec: 1000,
      },
      log: (): number => 0,
      signal: new AbortController().signal,
      env: process.env,
    };

    const docs: RawDoc[] = [];
    for await (const doc of __crawlWithResolver(ctx, resolve)) docs.push(doc);

    // The private metadata endpoint must NEVER be fetched — the guard
    // refuses the redirect hop before issuing the request.
    expect(fetched).not.toContain(PRIVATE);
    // The crawl still proceeds: robots resolution failing closed leaves
    // the host permissive, and the public page is fetched and yielded.
    expect(fetched).toContain(`${PUBLIC_HOST}/`);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.content).toContain("public page");
  });
});
