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
import type { Fetcher, RawDoc } from '../types.js';
import { HttpSourceSpecSchema } from '../schema.js';
import { resolveSecret } from '../../../config/secret.js';

export const httpFetcher: Fetcher = {
  kind: 'http',
  async *fetch(ctx) {
    const spec = HttpSourceSpecSchema.parse(ctx.spec);
    const start = new URL(spec.url);
    const origin = start.origin;
    const rate = new RateLimiter(spec.rate_limit_per_sec);
    const robots = new RobotsCache();
    let authHeader: string | undefined;
    if (spec.auth?.tokenRef) {
      try {
        const token = resolveSecret(spec.auth.tokenRef, ctx.env);
        authHeader = `Bearer ${token}`;
      } catch (err) {
        ctx.log({
          level: 'error',
          msg: `http source: unable to resolve tokenRef`,
          data: { error: (err as Error).message },
        });
        return;
      }
    }

    const queue: Array<{ url: string; depth: number }> = [
      { url: canonicalize(spec.url), depth: 0 },
    ];
    const visited = new Set<string>([canonicalize(spec.url)]);

    while (queue.length > 0) {
      if (ctx.signal.aborted) return;
      const item = queue.shift()!;
      const url = new URL(item.url);

      if (!spec.ignore_robots) {
        const allowed = await robots.isAllowed(url, ctx, spec.timeout_ms);
        if (!allowed) {
          ctx.log({
            level: 'info',
            msg: `robots.txt disallows ${item.url}`,
          });
          continue;
        }
      }

      await rate.wait(url.hostname, ctx.signal);
      if (ctx.signal.aborted) return;

      let res: Response;
      try {
        res = await fetchWithTimeout(
          item.url,
          {
            headers: {
              ...(authHeader ? { Authorization: authHeader } : {}),
              'User-Agent': 'llamactl-pipeline/1',
            },
            signal: ctx.signal,
          },
          spec.timeout_ms,
        );
      } catch (err) {
        ctx.log({
          level: 'warn',
          msg: `fetch failed: ${item.url}`,
          data: { error: (err as Error).message },
        });
        continue;
      }
      if (!res.ok) {
        ctx.log({
          level: 'warn',
          msg: `http ${res.status} for ${item.url}`,
        });
        continue;
      }
      const contentType = res.headers.get('content-type') ?? '';
      const html = await res.text();

      const isHtml = contentType.includes('html') ||
        /<html[\s>]/i.test(html.slice(0, 512));

      const text = isHtml ? extractReadableText(html) : html;
      const doc: RawDoc = {
        id: item.url,
        content: text,
        metadata: {
          source_kind: 'http',
          url: item.url,
          fetched_at: new Date().toISOString(),
          status: res.status,
          content_type: contentType,
          depth: item.depth,
          ...(spec.tag ?? {}),
        },
      };
      yield doc;

      if (!isHtml) continue;
      if (item.depth >= spec.max_depth) continue;

      for (const raw of extractLinks(html, url)) {
        const next = canonicalize(raw);
        if (visited.has(next)) continue;
        let u: URL;
        try {
          u = new URL(next);
        } catch {
          continue;
        }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        if (spec.same_origin && u.origin !== origin) continue;
        visited.add(next);
        queue.push({ url: next, depth: item.depth + 1 });
      }
    }
  },
};

function canonicalize(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    u.hash = '';
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
  const onAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onAbort);
  }
}

/**
 * Strip noisy tags, prefer the semantic content region, collapse
 * what's left to plain text. Regex-level only — we're not building a
 * real parser.
 */
export function extractReadableText(html: string): string {
  let h = html;
  h = h.replace(/<!--[\s\S]*?-->/g, '');
  h = h.replace(/<script[\s\S]*?<\/script>/gi, '');
  h = h.replace(/<style[\s\S]*?<\/style>/gi, '');
  h = h.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  h = h.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  h = h.replace(/<header[\s\S]*?<\/header>/gi, '');

  const main = h.match(/<main[\s\S]*?<\/main>/i);
  const article = h.match(/<article[\s\S]*?<\/article>/i);
  const body = h.match(/<body[\s\S]*?<\/body>/i);
  const chosen = main?.[0] ?? article?.[0] ?? body?.[0] ?? h;

  return chosen
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractLinks(html: string, base: URL): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /href\s*=\s*"([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1]!;
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
 * the same hostname.
 */
class RateLimiter {
  private readonly intervalMs: number;
  private readonly nextAllowed = new Map<string, number>();

  constructor(ratePerSec: number) {
    this.intervalMs = Math.max(1, Math.floor(1000 / ratePerSec));
  }

  async wait(host: string, signal: AbortSignal): Promise<void> {
    const now = Date.now();
    const earliest = this.nextAllowed.get(host) ?? 0;
    const delay = Math.max(0, earliest - now);
    this.nextAllowed.set(host, Math.max(now, earliest) + this.intervalMs);
    if (delay === 0) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, delay);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }
}

/**
 * One-robots-fetch-per-host cache. Parses `User-agent: *` Disallow
 * entries; any other user-agent block is ignored for v1.
 */
class RobotsCache {
  private readonly disallows = new Map<string, string[]>();
  private readonly fetched = new Set<string>();

  async isAllowed(
    url: URL,
    ctx: { signal: AbortSignal; log: (e: { level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }) => void },
    timeoutMs: number,
  ): Promise<boolean> {
    const host = url.origin;
    if (!this.fetched.has(host)) {
      this.fetched.add(host);
      try {
        const res = await fetchWithTimeout(
          `${host}/robots.txt`,
          { signal: ctx.signal },
          timeoutMs,
        );
        if (res.ok) {
          const body = await res.text();
          this.disallows.set(host, parseRobots(body));
        } else {
          this.disallows.set(host, []);
        }
      } catch {
        this.disallows.set(host, []);
      }
    }
    const rules = this.disallows.get(host) ?? [];
    const path = url.pathname + url.search;
    for (const rule of rules) {
      if (rule === '') continue;
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
    const line = raw.replace(/#.*/, '').trim();
    if (!line) {
      // Blank line ends the current group, per the robots.txt spec.
      inStar = false;
      continue;
    }
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      inStar = value === '*';
    } else if (field === 'disallow' && inStar) {
      disallow.push(value);
    }
  }
  return disallow;
}
