import type { ProbeReport, ProbeResult, ProbeState } from './probe.js';
import type { RunbookToolClient } from '../types.js';

/**
 * Facade probe — calls `nova.ops.healthcheck` through the in-proc MCP
 * client and normalizes its envelope into the same `ProbeReport` shape
 * `probeFleet` (direct HTTP probe) emits so `stateTransitions` and the
 * journal writer consume one shape regardless of source.
 *
 * Envelope mapping (see nova/packages/mcp/src/server.ts:200-250):
 *
 *   nova.ops.healthcheck returns (after unwrapping {content:[{type:'text',text}]}):
 *     {
 *       timeoutMs: number,
 *       gateways: Array<{name, baseUrl, ok, status, error?}>,
 *       siriusProviders: Array<{name, kind, baseUrl, ok, status, error?}>,
 *     }
 *
 *   → ProbeReport:
 *     {
 *       ts: <ISO now>,                         // envelope has no ts; adapter stamps it
 *       probes: [
 *         // gateways  → ProbeResult{kind:'gateway', name, baseUrl, state, status, error?, latencyMs:0}
 *         // providers → ProbeResult{kind:'provider', name, baseUrl, state, status, error?, latencyMs:0, providerKind?}
 *       ],
 *       unhealthy: <count of state==='unhealthy'>,
 *     }
 *
 * Notes on field mapping:
 *   - `ok: boolean` → `state: 'healthy' | 'unhealthy'` (same rule as `probeFleet`).
 *   - `latencyMs` is forced to 0 because nova's healthcheck doesn't surface per-probe
 *     latency today; the field is preserved in the report shape for downstream
 *     compatibility. If nova adds latency later, swap the 0 for the reported value.
 *   - `providerKind` is a new extra field on provider entries carrying the nova
 *     response's `kind` (e.g. 'openai', 'anthropic'). It does not collide with
 *     the existing `kind: 'gateway' | 'provider'` field on `ProbeResult`.
 *   - Envelope `timeoutMs` is dropped — report consumers don't read it.
 */

interface NovaHealthcheckGateway {
  name: string;
  baseUrl: string;
  ok: boolean;
  status: number;
  error?: string;
}

interface NovaHealthcheckProvider extends NovaHealthcheckGateway {
  kind?: string;
}

interface NovaHealthcheckEnvelope {
  timeoutMs?: number;
  gateways?: NovaHealthcheckGateway[];
  siriusProviders?: NovaHealthcheckProvider[];
}

interface McpCallResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

function firstTextBlock(result: McpCallResult): string | undefined {
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = content[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return undefined;
  return first.text;
}

function parseEnvelope(result: McpCallResult): NovaHealthcheckEnvelope {
  const text = firstTextBlock(result);
  if (text === undefined) {
    throw new Error('nova.ops.healthcheck: missing text content block');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`nova.ops.healthcheck: JSON parse failed — ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('nova.ops.healthcheck: envelope is not an object');
  }
  return parsed as NovaHealthcheckEnvelope;
}

function stateFromOk(ok: boolean): ProbeState {
  return ok ? 'healthy' : 'unhealthy';
}

export async function probeFleetViaNova(toolClient: RunbookToolClient): Promise<ProbeReport> {
  const raw = (await toolClient.callTool({
    name: 'nova.ops.healthcheck',
    arguments: {},
  })) as McpCallResult;

  if (raw?.isError === true) {
    const text = firstTextBlock(raw) ?? 'nova.ops.healthcheck returned isError';
    throw new Error(text.slice(0, 500));
  }

  const env = parseEnvelope(raw);
  const probes: ProbeResult[] = [];

  for (const g of env.gateways ?? []) {
    const state = stateFromOk(Boolean(g.ok));
    const entry: ProbeResult = {
      name: g.name,
      kind: 'gateway',
      baseUrl: g.baseUrl,
      state,
      status: typeof g.status === 'number' ? g.status : 0,
      latencyMs: 0,
    };
    if (typeof g.error === 'string' && g.error.length > 0) entry.error = g.error;
    probes.push(entry);
  }

  for (const p of env.siriusProviders ?? []) {
    const state = stateFromOk(Boolean(p.ok));
    const entry: ProbeResult & { providerKind?: string } = {
      name: p.name,
      kind: 'provider',
      baseUrl: p.baseUrl,
      state,
      status: typeof p.status === 'number' ? p.status : 0,
      latencyMs: 0,
    };
    if (typeof p.error === 'string' && p.error.length > 0) entry.error = p.error;
    if (typeof p.kind === 'string' && p.kind.length > 0) entry.providerKind = p.kind;
    probes.push(entry);
  }

  const unhealthy = probes.filter((p) => p.state === 'unhealthy').length;
  return {
    ts: new Date().toISOString(),
    probes,
    unhealthy,
  };
}
