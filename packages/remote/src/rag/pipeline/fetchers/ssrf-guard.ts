/**
 * SSRF guard for the HTTP RAG fetcher. A pipeline manifest is
 * operator-supplied, but "operator-supplied" is not "trusted to point
 * at the cloud metadata endpoint": a manifest URL (or any link it
 * crawls into, or any redirect Location it follows) can target
 * loopback admin panels, link-local metadata (169.254.169.254),
 * RFC1918 internal services, or a hostname that *resolves* to one of
 * those (DNS rebinding). This module rejects all of those before a
 * request is issued and re-checks on every redirect hop.
 *
 * The guard fails closed: an unparseable URL, a non-http(s) scheme,
 * an unresolvable host, or a host that resolves to any non-public
 * address is rejected. The only escape hatch is the explicit
 * `allow_private_targets` manifest flag (default false), used by
 * tests and by operators who knowingly crawl an internal host.
 *
 * Residual (documented, not closed): the guard resolves the host and
 * checks the result, but the subsequent `fetch()` does its own DNS
 * resolution, so a TOCTOU window remains where a racing rebind could
 * return a private address to the fetch that the guard never saw.
 * Closing that fully needs pinning the resolved IP into the connection
 * (custom agent / lookup hook), which Bun's fetch does not expose
 * today. The host-resolution check still defeats the common static
 * rebind (a hostname whose A record is simply 127.0.0.1).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** Parse a dotted-quad IPv4 into 4 octets, or null if malformed. */
function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => {
    if (!/^\d{1,3}$/.test(p)) return Number.NaN;
    return Number.parseInt(p, 10);
  });
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets as [number, number, number, number];
}

/** True for IPv4 addresses that must never be fetched. */
function isBlockedIpv4(ip: string): boolean {
  const octets = parseIpv4(ip);
  if (!octets) return false;
  const [a, b] = octets;
  // 0.0.0.0/8 — "this host" / unspecified.
  if (a === 0) return true;
  // 10.0.0.0/8 — RFC1918 private.
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback.
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (cloud metadata 169.254.169.254).
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — RFC1918 private.
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — RFC1918 private.
  if (a === 192 && b === 168) return true;
  return false;
}

/** Parse a colon-separated run of hex groups, or null if malformed. */
function parseHexGroups(part: string): number[] | null {
  if (part === "") return [];
  const out: number[] = [];
  for (const g of part.split(":")) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out.push(Number.parseInt(g, 16));
  }
  return out;
}

/** Split an embedded-IPv4 tail off an IPv6 string into two 16-bit
 *  groups. Returns the remaining head and the tail groups (empty when
 *  there is no IPv4 tail), or null on a malformed tail. */
function splitV4Tail(s: string): { head: string; tail: number[] } | null {
  const lastColon = s.lastIndexOf(":");
  if (lastColon < 0 || !s.slice(lastColon + 1).includes(".")) return { head: s, tail: [] };
  const v4 = parseIpv4(s.slice(lastColon + 1));
  if (!v4) return null;
  const tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
  let head = s.slice(0, lastColon + 1);
  if (head.endsWith(":") && !head.endsWith("::")) head = head.slice(0, -1);
  return { head, tail };
}

/**
 * Expand an IPv6 address to its 8 16-bit groups, handling `::`
 * compression and embedded IPv4 (`::ffff:127.0.0.1`). Returns a fixed
 * length-8 tuple, or null on malformed input.
 */
function ipv6Groups(
  ip: string,
): [number, number, number, number, number, number, number, number] | null {
  // Strip a zone id (fe80::1%eth0), then peel an embedded IPv4 tail.
  const pct = ip.indexOf("%");
  const bare = pct >= 0 ? ip.slice(0, pct) : ip;
  const split = splitV4Tail(bare);
  if (!split) return null;
  const { head, tail } = split;

  const doubleColon = head.indexOf("::");
  let groups: number[] | null;
  if (doubleColon >= 0) {
    const left = parseHexGroups(head.slice(0, doubleColon));
    const right = parseHexGroups(head.slice(doubleColon + 2));
    if (left === null || right === null) return null;
    const missing = 8 - (left.length + right.length + tail.length);
    if (missing < 0) return null;
    groups = [...left, ...Array<number>(missing).fill(0), ...right, ...tail];
  } else {
    const left = parseHexGroups(head);
    if (left === null) return null;
    groups = [...left, ...tail];
  }

  if (groups.length !== 8) return null;
  return groups as [number, number, number, number, number, number, number, number];
}

/** True for IPv6 addresses that must never be fetched. */
function isBlockedIpv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  // ::1 — loopback; :: — unspecified.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0) {
    return g7 === 1 || g7 === 0;
  }
  // fe80::/10 — link-local.
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // fc00::/7 — unique-local (ULA).
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // ::ffff:0:0/96 — IPv4-mapped: check the embedded v4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const a = (g6 >> 8) & 0xff;
    const b = g6 & 0xff;
    const c = (g7 >> 8) & 0xff;
    const d = g7 & 0xff;
    return isBlockedIpv4(`${String(a)}.${String(b)}.${String(c)}.${String(d)}`);
  }
  return false;
}

/** True if a literal IP address (v4 or v6) is non-public. */
function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isBlockedIpv4(ip);
  if (fam === 6) return isBlockedIpv6(ip);
  return false;
}

/** Hostnames that resolve to loopback regardless of DNS. */
function isLiteralLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "localhost." || h.endsWith(".localhost");
}

/**
 * The DNS resolver the guard uses to map a hostname to its addresses.
 * Injectable so tests can drive rebind scenarios without real DNS;
 * production uses `node:dns/promises` lookup over both families.
 */
export type HostResolver = (host: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (host) => {
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
};

/**
 * Reject a URL whose target is non-public. `allowPrivate` is the
 * explicit fail-closed escape hatch (`allow_private_targets` in the
 * manifest); when true the guard is a no-op. Throws `SsrfBlockedError`
 * on any violation. Resolves the host to IPs and checks every
 * returned address, defeating a static DNS rebind.
 */
async function assertHostnameResolvesPublic(host: string, resolver: HostResolver): Promise<void> {
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch (err) {
    throw new SsrfBlockedError(
      `SSRF guard: host resolution failed for ${host}: ${(err as Error).message}`,
    );
  }
  if (addresses.length === 0) {
    throw new SsrfBlockedError(`SSRF guard: host ${host} resolved to no addresses`);
  }
  for (const addr of addresses) {
    if (isBlockedIp(addr)) {
      throw new SsrfBlockedError(`SSRF guard: host ${host} resolved to non-public address ${addr}`);
    }
  }
}

export async function assertPublicUrl(
  rawUrl: string,
  opts: { allowPrivate?: boolean; resolve?: HostResolver } = {},
): Promise<void> {
  if (opts.allowPrivate) return;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`SSRF guard: unparseable URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockedError(`SSRF guard: non-http(s) scheme rejected: ${url.protocol}`);
  }

  // URL strips brackets from IPv6 literals in `hostname`.
  const host = url.hostname;

  if (isLiteralLoopbackHost(host)) {
    throw new SsrfBlockedError(`SSRF guard: loopback host rejected: ${host}`);
  }

  // Literal IP target: check it directly, no DNS.
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) {
      throw new SsrfBlockedError(`SSRF guard: non-public address rejected: ${host}`);
    }
    return;
  }

  // Hostname: resolve and check every address (DNS rebinding defence).
  await assertHostnameResolvesPublic(host, opts.resolve ?? defaultResolver);
}

// Exposed for unit tests of the address classifier.
export const __test = { isBlockedIp, isBlockedIpv4, isBlockedIpv6, ipv6Groups };
