/**
 * HTTP source fetcher. Breadth-first crawl with:
 *   - per-host rate limiter (leaky bucket, setTimeout-based);
 *   - robots.txt parsed once per host and consulted before each
 *     request unless `ignore_robots: true`;
 *   - same-origin filter + depth cap;
 *   - optional Bearer auth resolved through the unified secret
 *     resolver (`env:`, `keychain:`, `file:` refs);
 *   - doc id = canonical URL (fragment stripped, query preserved).
 *
 * The text extractor is deliberately cheap: strip noisy elements
 * (`<script>`, `<style>`, `<nav>`, `<footer>`, `<header>`), prefer
 * `<main>` or `<article>` content, fall back to `<body>`, then
 * collapse tags and whitespace. Good enough for doc crawls; we
 * don't replace a real search-engine extractor.
 */
import type { Fetcher, FetcherContext, RawDoc } from "../types.js";
import type { HostResolver } from "./ssrf-guard.js";

import { resolveSecret } from "../../../config/secret.js";
import { HttpSourceSpecSchema } from "../schema.js";
import { assertPublicUrl, SsrfBlockedError } from "./ssrf-guard.js";

/** Cap on redirect hops we will follow before giving up. */
const MAX_REDIRECTS = 5;

type HttpSourceSpec = ReturnType<typeof HttpSourceSpecSchema.parse>;

interface QueueItem {
  url: string;
  depth: number;
}

/** Everything one BFS step needs — bundled so the per-item helper
 *  has a single, readable parameter. */
interface CrawlState {
  spec: HttpSourceSpec;
  ctx: FetcherContext;
  origin: string;
  rate: RateLimiter;
  robots: RobotsCache;
  authHeader: string | undefined;
  visited: Set<string>;
  queue: QueueItem[];
  /** Test-only DNS seam: when set, every `assertPublicUrl` (start, each
   *  redirect hop, and the robots fetch) resolves hostnames through it
   *  instead of real DNS, so a test can make a host resolve to a public
   *  address while a robots redirect still targets a private literal.
   *  Undefined in production → the guard's default resolver. */
  resolve: HostResolver | undefined;
}

/**
 * Resolve the optional Bearer header. `{ ok: false }` means the
 * tokenRef failed to resolve (already logged) — abort the crawl.
 */
function resolveAuthHeader(
  spec: HttpSourceSpec,
  ctx: FetcherContext,
): { ok: boolean; header?: string } {
  if (!spec.auth?.tokenRef) return { ok: true };
  try {
    const token = resolveSecret(spec.auth.tokenRef, ctx.env);
    return { ok: true, header: `Bearer ${token}` };
  } catch (err) {
    ctx.log({
      level: "error",
      msg: `http source: unable to resolve tokenRef`,
      data: { error: (err as Error).message },
    });
    return { ok: false };
  }
}

async function robotsAllows(url: URL, itemUrl: string, state: CrawlState): Promise<boolean> {
  if (state.spec.ignore_robots) return true;
  const allowed = await state.robots.isAllowed(url, state);
  if (!allowed) {
    state.ctx.log({
      level: "info",
      msg: `robots.txt disallows ${itemUrl}`,
    });
  }
  return allowed;
}

/** Fetch one page; `null` means skip it (transport error, non-2xx
 *  status, or an SSRF-guard rejection — all logged). Redirects are
 *  followed manually so the SSRF guard runs on every hop and the
 *  Authorization header is dropped when a hop crosses origins. */
async function fetchPage(url: string, state: CrawlState): Promise<Response | null> {
  let res: Response;
  try {
    res = await guardedFetch(url, state);
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      state.ctx.log({
        level: "warn",
        msg: `SSRF guard blocked ${url}`,
        data: { error: err.message },
      });
      return null;
    }
    state.ctx.log({
      level: "warn",
      msg: `fetch failed: ${url}`,
      data: { error: (err as Error).message },
    });
    return null;
  }
  if (!res.ok) {
    state.ctx.log({
      level: "warn",
      msg: `http ${String(res.status)} for ${url}`,
    });
    return null;
  }
  return res;
}

/**
 * Fetch with the SSRF guard enforced on every hop and manual redirect
 * following. On each hop the target is re-checked against the guard
 * (`assertPublicUrl`) — so a public start URL that 302s to a private
 * address (cloud metadata, loopback admin) is refused — and the
 * Authorization header is stripped when the redirect Location's origin
 * differs from the *original* request origin, so the bearer token is
 * never leaked to a different host. Throws `SsrfBlockedError` when a
 * hop targets a non-public address; returns the final non-redirect
 * Response otherwise.
 */
async function guardedFetch(startUrl: string, state: CrawlState): Promise<Response> {
  const originOrigin = new URL(startUrl).origin;
  let currentUrl = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(currentUrl, {
      allowPrivate: state.spec.allow_private_targets,
      resolve: state.resolve,
    });

    // Only carry the bearer to the same origin as the original request.
    const sameOrigin = new URL(currentUrl).origin === originOrigin;
    const headers: Record<string, string> = { "User-Agent": "llamactl-pipeline/1" };
    if (state.authHeader && sameOrigin) headers.Authorization = state.authHeader;

    const res = await fetchWithTimeout(
      currentUrl,
      { headers, redirect: "manual", signal: state.ctx.signal },
      state.spec.timeout_ms,
    );

    if (!isRedirect(res.status)) return res;

    const location = res.headers.get("location");
    if (location === null || location === "") return res;
    // Resolve the Location relative to the current URL (may be relative).
    currentUrl = new URL(location, currentUrl).toString();
  }

  throw new Error(`too many redirects (>${String(MAX_REDIRECTS)}) starting at ${startUrl}`);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Same-origin + protocol + dedupe filter over extracted links;
 *  survivors join the BFS queue at depth + 1. */
function enqueueLinks(html: string, pageUrl: URL, depth: number, state: CrawlState): void {
  for (const raw of extractLinks(html, pageUrl)) {
    const next = canonicalize(raw);
    if (state.visited.has(next)) continue;
    let u: URL;
    try {
      u = new URL(next);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (state.spec.same_origin && u.origin !== state.origin) continue;
    state.visited.add(next);
    state.queue.push({ url: next, depth: depth + 1 });
  }
}

/**
 * Crawl one queue entry: robots check, rate-limit wait, fetch,
 * text extraction, and link expansion. Returns the doc to yield
 * (absent when the entry was skipped) plus a `stop` flag set when
 * the abort signal fired during the rate-limit wait.
 */
async function crawlOne(
  item: QueueItem,
  state: CrawlState,
): Promise<{ stop: boolean; doc?: RawDoc }> {
  const url = new URL(item.url);

  // SSRF gate first — before robots.txt is even fetched — so a private
  // target never produces any outbound request (robots or page).
  try {
    await assertPublicUrl(item.url, {
      allowPrivate: state.spec.allow_private_targets,
      resolve: state.resolve,
    });
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      state.ctx.log({
        level: "warn",
        msg: `SSRF guard blocked ${item.url}`,
        data: { error: err.message },
      });
      return { stop: false };
    }
    throw err;
  }

  if (!(await robotsAllows(url, item.url, state))) return { stop: false };

  const abortedDuringWait = await state.rate.wait(url.hostname, state.ctx.signal);
  if (abortedDuringWait) return { stop: true };

  const res = await fetchPage(item.url, state);
  if (res === null) return { stop: false };

  const contentType = res.headers.get("content-type") ?? "";
  const html = await res.text();
  const isHtml = contentType.includes("html") || /<html[\s>]/i.test(html.slice(0, 512));
  const text = isHtml ? extractReadableText(html) : html;
  const doc: RawDoc = {
    id: item.url,
    content: text,
    metadata: {
      source_kind: "http",
      url: item.url,
      fetched_at: new Date().toISOString(),
      status: res.status,
      content_type: contentType,
      depth: item.depth,
      ...(state.spec.tag ?? {}),
    },
  };

  if (isHtml && item.depth < state.spec.max_depth) {
    enqueueLinks(html, url, item.depth, state);
  }
  return { stop: false, doc };
}

async function* runCrawl(
  ctx: FetcherContext,
  resolve: HostResolver | undefined,
): AsyncGenerator<RawDoc> {
  const spec = HttpSourceSpecSchema.parse(ctx.spec);
  const auth = resolveAuthHeader(spec, ctx);
  if (!auth.ok) return;

  const state: CrawlState = {
    spec,
    ctx,
    origin: new URL(spec.url).origin,
    rate: new RateLimiter(spec.rate_limit_per_sec),
    robots: new RobotsCache(),
    authHeader: auth.header,
    visited: new Set<string>([canonicalize(spec.url)]),
    queue: [{ url: canonicalize(spec.url), depth: 0 }],
    resolve,
  };

  while (state.queue.length > 0) {
    if (ctx.signal.aborted) return;
    const item = state.queue.shift();
    if (item === undefined) break;

    const { stop, doc } = await crawlOne(item, state);
    if (stop) return;
    if (doc) yield doc;
  }
}

export const httpFetcher: Fetcher = {
  kind: "http",
  fetch(ctx) {
    // Production: real DNS via the guard's default resolver.
    return runCrawl(ctx, undefined);
  },
};

/**
 * Test-only crawl entry that injects a DNS resolver into the SSRF
 * guard for every hop (start, redirect, and robots). Lets a test make
 * a hostname resolve to a public address while a robots/page redirect
 * still targets a private literal — proving the per-hop guard (now
 * applied to robots too) refuses the private hop. Not part of the
 * public Fetcher surface.
 */
export function __crawlWithResolver(
  ctx: FetcherContext,
  resolve: HostResolver,
): AsyncGenerator<RawDoc> {
  return runCrawl(ctx, resolve);
}

function canonicalize(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    u.hash = "";
    return u.toString();
  } catch {
    return urlStr;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const outer = init.signal;
  const onAbort = (): void => {
    controller.abort();
  };
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener("abort", onAbort);
  }
}

/**
 * Strip noisy tags, prefer the semantic content region, collapse
 * what's left to plain text. Regex-level only — we're not building a
 * real parser.
 */
export function extractReadableText(html: string): string {
  let h = html;
  h = h.replaceAll(/<!--[\s\S]*?-->/g, "");
  h = h.replaceAll(/<script[\s\S]*?<\/script>/gi, "");
  h = h.replaceAll(/<style[\s\S]*?<\/style>/gi, "");
  h = h.replaceAll(/<nav[\s\S]*?<\/nav>/gi, "");
  h = h.replaceAll(/<footer[\s\S]*?<\/footer>/gi, "");
  h = h.replaceAll(/<header[\s\S]*?<\/header>/gi, "");

  const main = /<main[\s\S]*?<\/main>/i.exec(h);
  const article = /<article[\s\S]*?<\/article>/i.exec(h);
  const body = /<body[\s\S]*?<\/body>/i.exec(h);
  const chosen = main?.[0] ?? article?.[0] ?? body?.[0] ?? h;

  return chosen
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll(/\s+/g, " ")
    .trim();
}

export function extractLinks(html: string, base: URL): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /href\s*=\s*"([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (href === undefined) continue;
    let resolved: string;
    try {
      resolved = new URL(href, base).toString();
    } catch {
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

/**
 * Per-host leaky bucket. Each `wait()` call parks the caller until
 * at least `1000 / rate` ms have elapsed since the last release on
 * the same hostname. Resolves `true` when `signal` aborted while
 * (or before) waiting, so callers can bail out instead of issuing
 * an already-aborted fetch.
 */
class RateLimiter {
  private readonly intervalMs: number;
  private readonly nextAllowed = new Map<string, number>();

  constructor(ratePerSec: number) {
    this.intervalMs = Math.max(1, Math.floor(1000 / ratePerSec));
  }

  async wait(host: string, signal: AbortSignal): Promise<boolean> {
    const now = Date.now();
    const earliest = this.nextAllowed.get(host) ?? 0;
    const delay = Math.max(0, earliest - now);
    this.nextAllowed.set(host, Math.max(now, earliest) + this.intervalMs);
    if (delay > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
    }
    return signal.aborted;
  }
}

/**
 * One-robots-fetch-per-host cache. Parses `User-agent: *` Disallow
 * entries; any other user-agent block is ignored for v1.
 */
class RobotsCache {
  private readonly disallows = new Map<string, string[]>();
  private readonly fetched = new Set<string>();

  async isAllowed(url: URL, state: CrawlState): Promise<boolean> {
    const host = url.origin;
    if (!this.fetched.has(host)) {
      this.fetched.add(host);
      try {
        // Route robots.txt through the same guarded fetch the page path
        // uses (manual redirects + per-hop assertPublicUrl + hop cap), so
        // a public host whose /robots.txt 302s to a private target
        // (loopback admin, 169.254.169.254) has that hop refused before
        // it is issued, instead of being auto-followed unguarded.
        const res = await guardedFetch(`${host}/robots.txt`, state);
        if (res.ok) {
          const body = await res.text();
          this.disallows.set(host, parseRobots(body));
        } else {
          this.disallows.set(host, []);
        }
      } catch {
        // Any failure (transport, timeout, or an SSRF-blocked redirect)
        // leaves the host with no Disallow rules — permissive, matching
        // the prior missing-robots behavior. The blocked private target
        // is never fetched: guardedFetch checks each hop before issuing.
        this.disallows.set(host, []);
      }
    }
    const rules = this.disallows.get(host) ?? [];
    const path = url.pathname + url.search;
    for (const rule of rules) {
      if (rule === "") continue;
      if (path.startsWith(rule)) return false;
    }
    return true;
  }
}

/**
 * Extract Disallow entries under `User-agent: *`. No wildcards, no
 * Allow rules, no non-default user-agents — matches the brief.
 */
export function parseRobots(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const disallow: string[] = [];
  let inStar = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) {
      // Blank line ends the current group, per the robots.txt spec.
      inStar = false;
      continue;
    }
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      inStar = value === "*";
    } else if (field === "disallow" && inStar) {
      disallow.push(value);
    }
  }
  return disallow;
}
