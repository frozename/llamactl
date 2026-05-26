export interface ProbeHealthOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface ProbeHealthResult {
  reachable: boolean;
}

/**
 * Lightweight liveness probe for a locally-known endpoint. Hits /health,
 * which both llamactl-agent (since the /healthz alias landed) and raw
 * llama-server expose.
 *
 * Accepts loopback aliases (0.0.0.0, ::1, localhost, 127.0.0.1) and normalizes
 * them so the probe always hits a routable URL: 0.0.0.0 -> 127.0.0.1, IPv6
 * literals get bracket-wrapped.
 */
export async function probeHealthEndpoint(
  host: string,
  port: number,
  opts: ProbeHealthOptions = {},
): Promise<ProbeHealthResult> {
  const { fetch: fetchFn = globalThis.fetch, timeoutMs = 1000 } = opts;
  const endpoint = formatEndpoint(host, port);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${endpoint}/health`, { signal: controller.signal });
    return { reachable: res.ok };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

export function formatEndpoint(host: string, port: number): string {
  const normalized = host === '0.0.0.0' ? '127.0.0.1' : host;
  const isIPv6 = normalized.includes(':') && !normalized.startsWith('[');
  const hostPart = isIPv6 ? `[${normalized}]` : normalized;
  return `http://${hostPart}:${port}`;
}
