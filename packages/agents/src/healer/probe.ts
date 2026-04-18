import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/**
 * Fleet health probe. Reads the operator YAMLs llamactl authors and
 * issues a bounded-timeout GET against every gateway + sirius-provider
 * baseUrl, returning a structured report. Pure enough to be unit-
 * testable without a subprocess, a live sirius-api, or an MCP client
 * — the loop + journal layers compose this.
 */

export type ProbeState = 'healthy' | 'unhealthy';

export interface ProbeResult {
  name: string;
  kind: 'gateway' | 'provider';
  baseUrl: string;
  state: ProbeState;
  status: number;
  latencyMs: number;
  error?: string;
}

export interface ProbeReport {
  ts: string;
  probes: ProbeResult[];
  /** Count of probes currently in the 'unhealthy' state. */
  unhealthy: number;
}

export interface ProbeFleetOptions {
  kubeconfigPath: string;
  siriusProvidersPath: string;
  timeoutMs?: number;
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injectable clock. Defaults to Date.now. */
  now?: () => number;
}

interface KubeconfigNode {
  name: string;
  endpoint?: string;
  kind?: 'agent' | 'gateway' | 'provider' | 'cloud';
  cloud?: { provider: string; baseUrl: string };
  provider?: { gateway: string; providerName: string };
}

interface KubeconfigShape {
  currentContext?: string;
  contexts?: Array<{ name: string; cluster: string }>;
  clusters?: Array<{ name: string; nodes?: KubeconfigNode[] }>;
}

interface SiriusProvidersShape {
  providers?: Array<{ name: string; kind: string; baseUrl?: string }>;
}

function readYamlIfExists(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return parseYaml(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function resolveKind(n: KubeconfigNode): 'agent' | 'gateway' | 'provider' {
  if (n.kind === 'gateway' || n.kind === 'cloud') return 'gateway';
  if (n.kind === 'agent' || n.kind === 'provider') return n.kind;
  if (n.provider) return 'provider';
  if (n.cloud) return 'gateway';
  return 'agent';
}

async function probeOne(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof globalThis.fetch,
  now: () => number,
): Promise<{ state: ProbeState; status: number; latencyMs: number; error?: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const startedAt = now();
  try {
    const res = await fetchImpl(url, { signal: ctl.signal });
    const latencyMs = now() - startedAt;
    return {
      state: res.ok ? 'healthy' : 'unhealthy',
      status: res.status,
      latencyMs,
    };
  } catch (err) {
    return {
      state: 'unhealthy',
      status: 0,
      latencyMs: now() - startedAt,
      error: (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeFleet(opts: ProbeFleetOptions): Promise<ProbeReport> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? 1500;

  const kube = readYamlIfExists(opts.kubeconfigPath) as KubeconfigShape | null;
  const sirius = readYamlIfExists(opts.siriusProvidersPath) as SiriusProvidersShape | null;
  const ctx = kube?.contexts?.find((c) => c.name === kube.currentContext);
  const cluster = kube?.clusters?.find((c) => c.name === ctx?.cluster);

  const gateways = (cluster?.nodes ?? [])
    .filter((n) => resolveKind(n) === 'gateway' && n.cloud?.baseUrl)
    .map((n) => ({ name: n.name, baseUrl: n.cloud!.baseUrl }));

  const providers = (sirius?.providers ?? []).filter((p) => typeof p.baseUrl === 'string' && p.baseUrl.length > 0);

  const probes: ProbeResult[] = [];
  const gatewayProbes = await Promise.all(
    gateways.map(async (g) => ({
      g,
      probe: await probeOne(g.baseUrl, timeoutMs, fetchImpl, now),
    })),
  );
  for (const { g, probe } of gatewayProbes) {
    probes.push({
      name: g.name,
      kind: 'gateway',
      baseUrl: g.baseUrl,
      ...probe,
    });
  }

  const providerProbes = await Promise.all(
    providers.map(async (p) => ({
      p,
      probe: await probeOne(p.baseUrl!, timeoutMs, fetchImpl, now),
    })),
  );
  for (const { p, probe } of providerProbes) {
    probes.push({
      name: p.name,
      kind: 'provider',
      baseUrl: p.baseUrl!,
      ...probe,
    });
  }

  const unhealthy = probes.filter((p) => p.state === 'unhealthy').length;
  return { ts: new Date(now()).toISOString(), probes, unhealthy };
}

/**
 * Compare two reports and return probes whose state flipped between
 * them. Used by the loop to emit prominent "state change" journal
 * entries without spamming on steady-state ticks.
 */
export function stateTransitions(prev: ProbeReport | null, next: ProbeReport): Array<{
  name: string;
  kind: 'gateway' | 'provider';
  from: ProbeState | 'unknown';
  to: ProbeState;
}> {
  const prevByKey = new Map<string, ProbeState>();
  for (const p of prev?.probes ?? []) prevByKey.set(`${p.kind}:${p.name}`, p.state);
  const out: Array<{ name: string; kind: 'gateway' | 'provider'; from: ProbeState | 'unknown'; to: ProbeState }> = [];
  for (const p of next.probes) {
    const key = `${p.kind}:${p.name}`;
    const from = prevByKey.get(key) ?? 'unknown';
    if (from !== p.state) {
      out.push({ name: p.name, kind: p.kind, from, to: p.state });
    }
  }
  return out;
}
