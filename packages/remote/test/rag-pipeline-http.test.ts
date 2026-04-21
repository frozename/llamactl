import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  extractLinks,
  extractReadableText,
  httpFetcher,
  parseRobots,
} from '../src/rag/pipeline/fetchers/http.js';
import type { RawDoc } from '../src/rag/pipeline/types.js';

interface ServerOptions {
  robots?: string | null;
  authRequired?: string;
  pages: Record<string, { html: string; contentType?: string }>;
}

interface FakeServer {
  origin: string;
  calls: Array<{ method: string; path: string; auth: string | null }>;
  stop: () => Promise<void>;
}

async function startFakeSite(opts: ServerOptions): Promise<FakeServer> {
  const calls: FakeServer['calls'] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = (Bun as unknown as { serve: (o: unknown) => { hostname: string; port: number; stop: (force?: boolean) => Promise<void> } }).serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req: Request) {
      const url = new URL(req.url);
      calls.push({
        method: req.method,
        path: url.pathname,
        auth: req.headers.get('authorization'),
      });
      if (url.pathname === '/robots.txt') {
        if (opts.robots === null) {
          return new Response('not found', { status: 404 });
        }
        return new Response(opts.robots ?? '', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }
      if (opts.authRequired) {
        const got = req.headers.get('authorization') ?? '';
        if (got !== `Bearer ${opts.authRequired}`) {
          return new Response('unauthorized', { status: 401 });
        }
      }
      const page = opts.pages[url.pathname];
      if (!page) return new Response('not found', { status: 404 });
      return new Response(page.html, {
        status: 200,
        headers: { 'content-type': page.contentType ?? 'text/html' },
      });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    calls,
    stop: async () => {
      await server.stop(true);
    },
  };
}

async function run(
  spec: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ docs: RawDoc[]; logs: Array<{ level: string; msg: string }> }> {
  const logs: Array<{ level: string; msg: string }> = [];
  const ctx = {
    spec,
    log: (e: { level: 'info' | 'warn' | 'error'; msg: string }) =>
      logs.push({ level: e.level, msg: e.msg }),
    signal: new AbortController().signal,
    env,
  };
  const docs: RawDoc[] = [];
  for await (const doc of httpFetcher.fetch(ctx)) docs.push(doc);
  return { docs, logs };
}

let srv: FakeServer | null = null;

beforeEach(() => {
  srv = null;
});

afterEach(async () => {
  if (srv) await srv.stop();
  srv = null;
});

describe('httpFetcher', () => {
  test('depth=0 fetches only the start URL', async () => {
    srv = await startFakeSite({
      pages: {
        '/': { html: '<html><body>root <a href="/a">a</a></body></html>' },
        '/a': { html: '<html><body>inner</body></html>' },
      },
    });
    const { docs } = await run({
      kind: 'http',
      url: `${srv.origin}/`,
      max_depth: 0,
      rate_limit_per_sec: 100,
    });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.id).toBe(`${srv.origin}/`);
  });

  test('depth=1 follows one hop', async () => {
    srv = await startFakeSite({
      pages: {
        '/': {
          html: '<html><body>root <a href="/a">a</a> <a href="/b">b</a></body></html>',
        },
        '/a': { html: '<html><body>a page</body></html>' },
        '/b': { html: '<html><body>b page</body></html>' },
      },
    });
    const { docs } = await run({
      kind: 'http',
      url: `${srv.origin}/`,
      max_depth: 1,
      rate_limit_per_sec: 100,
    });
    const ids = docs.map((d) => d.id).sort();
    expect(ids).toEqual(
      [`${srv.origin}/`, `${srv.origin}/a`, `${srv.origin}/b`].sort(),
    );
  });

  test('same_origin filters off-site links', async () => {
    srv = await startFakeSite({
      pages: {
        '/': {
          html:
            '<html><body>' +
            '<a href="https://other.example/x">offsite</a>' +
            '<a href="/local">local</a>' +
            '</body></html>',
        },
        '/local': { html: '<html><body>local page</body></html>' },
      },
    });
    const { docs } = await run({
      kind: 'http',
      url: `${srv.origin}/`,
      max_depth: 1,
      same_origin: true,
      rate_limit_per_sec: 100,
    });
    const ids = docs.map((d) => d.id).sort();
    expect(ids).toEqual([`${srv.origin}/`, `${srv.origin}/local`].sort());
    // None of the recorded calls should target the offsite URL.
    expect(srv.calls.every((c) => !c.path.includes('/x'))).toBe(true);
  });

  test('robots.txt Disallow blocks the forbidden path', async () => {
    srv = await startFakeSite({
      robots: 'User-agent: *\nDisallow: /private\n',
      pages: {
        '/': {
          html: '<html><body><a href="/public">ok</a><a href="/private">no</a></body></html>',
        },
        '/public': { html: '<html><body>public</body></html>' },
        '/private': { html: '<html><body>private</body></html>' },
      },
    });
    const { docs } = await run({
      kind: 'http',
      url: `${srv.origin}/`,
      max_depth: 1,
      rate_limit_per_sec: 100,
    });
    const ids = docs.map((d) => d.id);
    expect(ids).toContain(`${srv.origin}/public`);
    expect(ids).not.toContain(`${srv.origin}/private`);
  });

  test('ignore_robots: true bypasses robots.txt', async () => {
    srv = await startFakeSite({
      robots: 'User-agent: *\nDisallow: /private\n',
      pages: {
        '/': {
          html: '<html><body><a href="/private">p</a></body></html>',
        },
        '/private': { html: '<html><body>private content</body></html>' },
      },
    });
    const { docs } = await run({
      kind: 'http',
      url: `${srv.origin}/`,
      max_depth: 1,
      ignore_robots: true,
      rate_limit_per_sec: 100,
    });
    const ids = docs.map((d) => d.id);
    expect(ids).toContain(`${srv.origin}/private`);
  });

  test('auth.tokenRef resolves via env: and sends Bearer header', async () => {
    srv = await startFakeSite({
      authRequired: 'secret-token',
      pages: {
        '/': { html: '<html><body>authed</body></html>' },
      },
    });
    const { docs } = await run(
      {
        kind: 'http',
        url: `${srv.origin}/`,
        max_depth: 0,
        rate_limit_per_sec: 100,
        auth: { tokenRef: 'env:HTTP_FETCHER_TEST_TOKEN' },
      },
      { ...process.env, HTTP_FETCHER_TEST_TOKEN: 'secret-token' },
    );
    expect(docs).toHaveLength(1);
    // Every non-robots call should carry the Bearer header.
    const docCalls = srv.calls.filter((c) => c.path !== '/robots.txt');
    expect(docCalls.every((c) => c.auth === 'Bearer secret-token')).toBe(true);
  });

  test('does not revisit a URL within the same run', async () => {
    srv = await startFakeSite({
      pages: {
        '/': {
          html:
            '<html><body><a href="/a">a</a><a href="/a">again</a></body></html>',
        },
        '/a': { html: '<html><body>one</body></html>' },
      },
    });
    await run({
      kind: 'http',
      url: `${srv.origin}/`,
      max_depth: 1,
      rate_limit_per_sec: 100,
    });
    // `/a` should be requested at most once.
    const aCalls = srv.calls.filter((c) => c.path === '/a');
    expect(aCalls.length).toBe(1);
  });

  test('missing robots.txt treated as permissive', async () => {
    srv = await startFakeSite({
      robots: null,
      pages: {
        '/': { html: '<html><body>ok</body></html>' },
      },
    });
    const { docs } = await run({
      kind: 'http',
      url: `${srv.origin}/`,
      max_depth: 0,
      rate_limit_per_sec: 100,
    });
    expect(docs).toHaveLength(1);
  });
});

describe('extractReadableText', () => {
  test('strips scripts, styles, and nav', () => {
    const html =
      '<html><head><style>body{}</style></head>' +
      '<body><nav>skip</nav><main>Hello <b>world</b>.</main>' +
      '<script>alert(1)</script></body></html>';
    const text = extractReadableText(html);
    expect(text).toContain('Hello');
    expect(text).toContain('world');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('skip');
  });
});

describe('extractLinks', () => {
  test('resolves relative URLs against base', () => {
    const base = new URL('https://example.com/dir/');
    const links = extractLinks(
      '<a href="a.html">a</a><a href="/b">b</a>',
      base,
    );
    expect(links).toContain('https://example.com/dir/a.html');
    expect(links).toContain('https://example.com/b');
  });
});

describe('parseRobots', () => {
  test('captures Disallow entries under User-agent: *', () => {
    const r = parseRobots(
      [
        'User-agent: bot',
        'Disallow: /not-me',
        '',
        'User-agent: *',
        'Disallow: /private',
        'Disallow: /secret',
      ].join('\n'),
    );
    expect(r).toEqual(['/private', '/secret']);
  });
});
