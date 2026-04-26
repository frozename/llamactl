import type { ClusterNode, Config } from '@llamactl/remote';

export interface NodeFailure {
  nodeName: string;
  reason: 'timeout' | 'rejected' | 'aborted';
  detail?: string;
}

export interface FanOutOpts<T> {
  /** Agent nodes to dispatch to; caller has already excluded self. */
  nodes: readonly ClusterNode[];
  /** Per-node fetcher. Receives the node and an AbortSignal scoped
   *  to this node's per-node timeout (or the outer signal, whichever
   *  fires first). Returns hits or throws. */
  perNodeFetch: (node: ClusterNode, signal: AbortSignal) => Promise<T[]>;
  /** Per-node timeout in milliseconds; default 2000. */
  perNodeTimeoutMs?: number;
  /** Outer abort signal — cancels every in-flight node call. */
  signal?: AbortSignal;
}

export interface FanOutResult<T> {
  hits: T[];
  failures: NodeFailure[];
}

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Filter kubeconfig agent nodes for cross-node fan-out:
 *   - Limit to nodes in the current context's cluster
 *   - Treat nodes with no `kind` field as agents (backwards compat)
 *   - Exclude `gateway` and `rag` nodes (those aren't search peers)
 *   - Exclude the active node (caller already searches it via the
 *     normal single-node path)
 */
export function listAgentNodes(cfg: Config, activeNodeName: string): ClusterNode[] {
  const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
  if (!ctx) return [];
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  if (!cluster) return [];
  return cluster.nodes.filter((n) => {
    const kind = (n as { kind?: string }).kind ?? 'agent';
    if (kind !== 'agent') return false;
    if (n.name === activeNodeName) return false;
    return true;
  });
}

/**
 * Parallel-dispatch a per-node fetcher across a set of nodes. Each
 * node call gets a child AbortController racing the per-node timeout
 * (and the outer signal if provided). Failures are captured per-node
 * and surfaced in `failures`; successes merge into `hits`.
 *
 * Never rejects — the caller wants partial success even if every node
 * fails. The outer signal cancellation reaches each in-flight fetcher
 * via its child signal.
 */
export async function fanOutSurface<T>(opts: FanOutOpts<T>): Promise<FanOutResult<T>> {
  if (opts.nodes.length === 0) return { hits: [], failures: [] };
  const timeoutMs = opts.perNodeTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const failures: NodeFailure[] = [];
  const hits: T[] = [];

  const settled = await Promise.allSettled(
    opts.nodes.map(async (node) => {
      const child = new AbortController();
      const onOuterAbort = (): void => child.abort();
      opts.signal?.addEventListener('abort', onOuterAbort);
      const timer = setTimeout(() => child.abort(), timeoutMs);
      try {
        const result = await opts.perNodeFetch(node, child.signal);
        return { node: node.name, ok: true as const, hits: result };
      } catch (err) {
        const reason = child.signal.aborted
          ? (opts.signal?.aborted ? 'aborted' : 'timeout')
          : 'rejected';
        return {
          node: node.name,
          ok: false as const,
          reason,
          detail: (err as Error).message,
        };
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onOuterAbort);
      }
    }),
  );

  for (const r of settled) {
    if (r.status === 'rejected') continue; // shouldn't happen — inner catches
    const v = r.value;
    if (v.ok) {
      hits.push(...v.hits);
    } else {
      failures.push({
        nodeName: v.node,
        reason: v.reason,
        ...(v.detail ? { detail: v.detail } : {}),
      });
    }
  }
  return { hits, failures };
}
