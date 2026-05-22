export interface WorkloadTarget {
  name: string;
  endpoint: string;
  kind: 'ModelHost' | 'ModelRun';
  /** Eviction priority (0-100). Lower = evict first. Defaults to 50 when omitted. */
  priority?: number;
}

export interface WorkloadProbeOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  priorConsecutiveErrors?: number;
  /**
   * If true, allow probes to non-loopback / non-private targets. Default false
   * (supervisor's expected use case is local + LAN-private workloads only).
   * Set true to opt into probing public hosts (still SSRF-bounded by the
   * fetch URL, but at least intentional).
   */
  allowPublicEndpoints?: boolean;
}

export interface WorkloadProbeResult {
  reachable: boolean;
  healthLatencyMs: number;
  models: string[];
  consecutiveErrors: number;
}

export class InvalidEndpointError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidEndpointError'; }
}

/**
 * Validates an endpoint URL for SSRF safety. Rejects non-http(s) schemes,
 * link-local (169.254.0.0/16, fe80::/10), unspecified (0.0.0.0, ::),
 * and (unless allowPublic) non-loopback non-private hosts.
 */
export function validateProbeEndpoint(endpoint: string, allowPublic = false): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new InvalidEndpointError(`invalid URL: ${endpoint}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidEndpointError(`unsupported scheme ${url.protocol} (only http/https)`);
  }
  const host = url.hostname.toLowerCase();
  if (host === '0.0.0.0' || host === '::' || host === '[::]') {
    throw new InvalidEndpointError(`unspecified host ${host} not allowed`);
  }
  // Link-local IPv4
  if (host.startsWith('169.254.')) {
    throw new InvalidEndpointError(`link-local host ${host} not allowed (likely metadata endpoint)`);
  }
  // Link-local IPv6
  if (host.startsWith('fe80:') || host.startsWith('[fe80:')) {
    throw new InvalidEndpointError(`link-local IPv6 host ${host} not allowed`);
  }
  if (allowPublic) return;
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
  const privateIPv4 =
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host));
  const localDomain = host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home') || host.endsWith('.internal');
  if (!loopback && !privateIPv4 && !localDomain) {
    throw new InvalidEndpointError(
      `host ${host} not in loopback/RFC1918/.local/.lan — pass allowPublicEndpoints to override`,
    );
  }
}

/** Redact userinfo (user:pass@) from a URL for safe logging/journaling. */
export function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      return url.toString();
    }
    return endpoint;
  } catch {
    return endpoint;
  }
}

export async function probeWorkload(
  target: WorkloadTarget,
  opts: WorkloadProbeOptions = {},
): Promise<WorkloadProbeResult> {
  const { fetch: fetchFn = globalThis.fetch, timeoutMs = 5000, priorConsecutiveErrors = 0, allowPublicEndpoints = false } = opts;

  try {
    validateProbeEndpoint(target.endpoint, allowPublicEndpoints);
  } catch (err) {
    if (err instanceof InvalidEndpointError) {
      return { reachable: false, healthLatencyMs: 0, models: [], consecutiveErrors: priorConsecutiveErrors + 1 };
    }
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const healthRes = await fetchFn(`${target.endpoint}/health`, { signal: controller.signal });
    const latency = Date.now() - start;

    if (!healthRes.ok) {
      clearTimeout(timer);
      return { reachable: false, healthLatencyMs: latency, models: [], consecutiveErrors: priorConsecutiveErrors + 1 };
    }

    let models: string[] = [];
    try {
      // Reuse the same per-probe timeout budget for /v1/models. A malicious
      // endpoint that returns /health fast then stalls /v1/models would
      // otherwise hang the tick. The controller.signal is the same so the
      // outer timeout aborts both.
      const modelsRes = await fetchFn(`${target.endpoint}/v1/models`, { signal: controller.signal });
      if (modelsRes.ok) {
        const body = await modelsRes.json() as { data: Array<{ id: string }> };
        models = body.data.map((m) => m.id);
      }
    } catch {
      // models fetch failure does not make the endpoint unreachable
    } finally {
      clearTimeout(timer);
    }

    return { reachable: true, healthLatencyMs: latency, models, consecutiveErrors: 0 };
  } catch {
    clearTimeout(timer);
    return { reachable: false, healthLatencyMs: Date.now() - start, models: [], consecutiveErrors: priorConsecutiveErrors + 1 };
  }
}
