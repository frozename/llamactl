import type { RunbookToolClient } from '../types.js';

/**
 * Composite fetcher — calls `llamactl.composite.list` through the in-
 * proc MCP client and normalizes its envelope into a typed summary the
 * healer loop consumes. Mirrors `facade-probe.ts` in shape: one text-
 * content envelope, unwrapped, then reshaped into a minimal view the
 * loop can reason about without pulling the whole composite YAML
 * serializer into this package.
 *
 * `llamactl.composite.list` returns (after unwrapping):
 *   { count: number, composites: Composite[] }
 *
 * where each `Composite` matches the schema in
 * `packages/remote/src/composite/schema.ts`:
 *   metadata.name, spec.*, status?.phase, status?.components[]
 *
 * We keep the full `rawYaml` view on each returned entry so the loop's
 * remediation plan can feed `manifestYaml` back into
 * `llamactl.composite.apply` without a second tool round-trip (the
 * re-apply verb wants the manifest YAML, not a name).
 */

export type CompositePhase =
  | 'Pending'
  | 'Applying'
  | 'Ready'
  | 'Degraded'
  | 'Failed';

export type CompositeComponentState =
  | 'Pending'
  | 'Applying'
  | 'Ready'
  | 'Failed';

export interface CompositeComponentSummary {
  kind: 'service' | 'workload' | 'rag' | 'gateway';
  name: string;
  state: CompositeComponentState;
  message?: string;
}

export interface CompositeSummary {
  name: string;
  phase: CompositePhase | 'Unknown';
  components: CompositeComponentSummary[];
  /** Raw manifest JSON re-serialized as YAML so the loop can plug it
   *  straight into `llamactl.composite.apply`'s `manifestYaml` input.
   *  Cached here to avoid a second tool-round-trip per Degraded entry. */
  manifestYaml: string;
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

interface CompositeListEnvelope {
  count?: number;
  composites?: Array<{
    apiVersion?: string;
    kind?: string;
    metadata?: { name?: string };
    status?: {
      phase?: string;
      components?: Array<{
        ref?: { kind?: string; name?: string };
        state?: string;
        message?: string;
      }>;
    };
  }>;
}

function parseEnvelope(result: McpCallResult): CompositeListEnvelope {
  const text = firstTextBlock(result);
  if (text === undefined) {
    throw new Error('llamactl.composite.list: missing text content block');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `llamactl.composite.list: JSON parse failed — ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('llamactl.composite.list: envelope is not an object');
  }
  return parsed as CompositeListEnvelope;
}

/**
 * Safe YAML-ish re-serializer. The composite applier consumes
 * manifestYaml via `parseComposite` (YAML → validated manifest), and
 * the `yaml` package happily parses JSON as a subset of YAML, so we
 * avoid a transitive dependency on `yaml` here by passing the
 * original manifest back as pretty JSON. The applier's YAML parser
 * accepts this without complaint — smoke-tested via the e2e suite.
 */
function toManifestYaml(raw: unknown): string {
  return JSON.stringify(raw, null, 2);
}

function normalizeComponentKind(
  raw: string | undefined,
): CompositeComponentSummary['kind'] {
  if (raw === 'service' || raw === 'workload' || raw === 'rag' || raw === 'gateway') {
    return raw;
  }
  // Defensive — if the server emits an unknown kind we don't want to
  // crash the loop; treat it as 'service' and let the apply path
  // surface the real validation error downstream.
  return 'service';
}

function normalizeComponentState(
  raw: string | undefined,
): CompositeComponentState {
  if (raw === 'Pending' || raw === 'Applying' || raw === 'Ready' || raw === 'Failed') {
    return raw;
  }
  return 'Pending';
}

function normalizePhase(raw: string | undefined): CompositeSummary['phase'] {
  if (
    raw === 'Pending' ||
    raw === 'Applying' ||
    raw === 'Ready' ||
    raw === 'Degraded' ||
    raw === 'Failed'
  ) {
    return raw;
  }
  return 'Unknown';
}

export async function fetchComposites(
  toolClient: RunbookToolClient,
): Promise<CompositeSummary[]> {
  const raw = (await toolClient.callTool({
    name: 'llamactl.composite.list',
    arguments: {},
  })) as McpCallResult;

  if (raw?.isError === true) {
    const text = firstTextBlock(raw) ?? 'llamactl.composite.list returned isError';
    throw new Error(text.slice(0, 500));
  }

  const env = parseEnvelope(raw);
  const list = env.composites ?? [];
  const out: CompositeSummary[] = [];
  for (const entry of list) {
    const name = entry?.metadata?.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    const phase = normalizePhase(entry.status?.phase);
    const components: CompositeComponentSummary[] = [];
    for (const c of entry.status?.components ?? []) {
      const summary: CompositeComponentSummary = {
        kind: normalizeComponentKind(c.ref?.kind),
        name: typeof c.ref?.name === 'string' ? c.ref.name : '',
        state: normalizeComponentState(c.state),
      };
      if (typeof c.message === 'string' && c.message.length > 0) {
        summary.message = c.message;
      }
      components.push(summary);
    }
    out.push({
      name,
      phase,
      components,
      manifestYaml: toManifestYaml(entry),
    });
  }
  return out;
}

/**
 * Predicate: does this composite need a re-apply remediation? Fires on
 *   - overall status Degraded or Failed, OR
 *   - overall status Ready/Pending/Applying but at least one component
 *     reports `state: 'Failed'` (component-level issue the aggregate
 *     hasn't reflected yet — still worth re-applying).
 *
 * A composite with no `status` block (phase: 'Unknown') does NOT
 * trigger a re-apply: that means it was listed but never applied (or
 * the status wasn't persisted yet), and kicking it into apply on a
 * stale empty status would create churn.
 */
export function shouldRemediateComposite(summary: CompositeSummary): boolean {
  if (summary.phase === 'Degraded' || summary.phase === 'Failed') return true;
  if (summary.phase === 'Unknown') return false;
  return summary.components.some((c) => c.state === 'Failed');
}

/** Short human-readable reason string used in journal entries. */
export function formatCompositeReason(summary: CompositeSummary): string {
  const failed = summary.components.filter((c) => c.state === 'Failed').length;
  const total = summary.components.length;
  if (summary.phase === 'Degraded' || summary.phase === 'Failed') {
    return total > 0
      ? `composite ${summary.name} reports ${summary.phase} (${failed}/${total} components Failed), re-applying`
      : `composite ${summary.name} reports ${summary.phase}, re-applying`;
  }
  return `composite ${summary.name} has ${failed}/${total} component(s) in Failed state, re-applying`;
}
