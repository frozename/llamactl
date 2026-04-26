/**
 * Composite dependency DAG — pure functions over `CompositeSpec`.
 * The applier (Phase 4) consumes `topologicalOrder` to decide
 * component apply order; `reverseOrder` drives rollback + destroy.
 *
 * Cycles are rejected with a helpful error message naming the
 * nodes still left unprocessed when Kahn's algorithm terminates
 * early. The implementation stays library-free — at this scope a
 * topological-sort dependency would be far more surface than we
 * need.
 */
import type {
  CompositeSpec,
  ComponentRef,
  DependencyEdge,
} from './schema.js';
import { workloadRefName } from './schema.js';

/**
 * List every declared component as a `ComponentRef`. Order within
 * each kind matches the authoring order in the spec, so callers
 * that want to stable-sort within ties get deterministic output.
 */
export function listComponents(spec: CompositeSpec): ComponentRef[] {
  const out: ComponentRef[] = [];
  for (const s of spec.services) out.push({ kind: 'service', name: s.name });
  for (const w of spec.workloads)
    out.push({ kind: 'workload', name: workloadRefName(w) });
  for (const r of spec.ragNodes) out.push({ kind: 'rag', name: r.name });
  for (const g of spec.gateways) out.push({ kind: 'gateway', name: g.name });
  // `?? []` is defensive: schema-validated specs always carry an array
  // (Zod fills the default), but a handful of tests construct specs
  // by hand with `as any` and predate the `pipelines` field — keep them
  // green without forcing every fixture to track every new field.
  for (const p of spec.pipelines ?? [])
    out.push({ kind: 'pipeline', name: p.name });
  return out;
}

/**
 * Infer edges the operator didn't declare explicitly:
 *   - ragNode.backingService → implicit edge rag → service.
 *   - gateway.upstreamWorkloads → implicit edge gateway → workload.
 *   - pipeline.destination.ragNode → implicit edge pipeline → rag,
 *     but only when the destination names an inline ragNode (operator
 *     pipelines pointing at an externally-declared rag node stay
 *     edge-free here; the applier still validates the reference).
 *
 * We do NOT auto-link workloads to pgvector services on the same
 * node — that's application-level wiring and the operator must
 * declare it explicitly if they want apply-order guarantees.
 */
export function impliedEdges(spec: CompositeSpec): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  for (const r of spec.ragNodes) {
    if (r.backingService) {
      edges.push({
        from: { kind: 'rag', name: r.name },
        to: { kind: 'service', name: r.backingService },
      });
    }
  }
  for (const g of spec.gateways) {
    for (const up of g.upstreamWorkloads) {
      edges.push({
        from: { kind: 'gateway', name: g.name },
        to: { kind: 'workload', name: up },
      });
    }
  }
  const ragNodeNames = new Set(spec.ragNodes.map((r) => r.name));
  for (const p of spec.pipelines ?? []) {
    const destRagNode = p.spec.destination.ragNode;
    if (ragNodeNames.has(destRagNode)) {
      edges.push({
        from: { kind: 'pipeline', name: p.name },
        to: { kind: 'rag', name: destRagNode },
      });
    }
  }
  return edges;
}

function edgeKey(e: DependencyEdge): string {
  return `${e.from.kind}/${e.from.name}=>${e.to.kind}/${e.to.name}`;
}

/**
 * Explicit + implied edges, deduped by (from, to).
 */
export function allEdges(spec: CompositeSpec): DependencyEdge[] {
  const seen = new Map<string, DependencyEdge>();
  for (const e of [...spec.dependencies, ...impliedEdges(spec)]) {
    const k = edgeKey(e);
    if (!seen.has(k)) seen.set(k, e);
  }
  return Array.from(seen.values());
}

function refKey(r: ComponentRef): string {
  return `${r.kind}/${r.name}`;
}

/**
 * Kahn's algorithm. `from` depends on `to` — so for the topological
 * order we emit nodes whose dependencies have all been emitted
 * (nodes with zero remaining *outgoing* edges to un-emitted nodes).
 *
 * Equivalent framing: invert the edges so they point from
 * dependency → dependent (to → from). A node's in-degree in the
 * inverted graph = the number of edges where it's the `from` side
 * (i.e., how many things it depends on). Process zero-in-degree
 * nodes first; decrement the in-degree of each dependent when one
 * completes.
 */
export function topologicalOrder(spec: CompositeSpec): ComponentRef[] {
  const nodes = listComponents(spec);
  const edges = allEdges(spec);

  // Index nodes + preserve declaration order for stable tie-breaks.
  const byKey = new Map<string, { ref: ComponentRef; order: number }>();
  for (let i = 0; i < nodes.length; i++) {
    byKey.set(refKey(nodes[i]!), { ref: nodes[i]!, order: i });
  }

  // Build: `from depends on to`.
  // dependents.get(k) = nodes that depend on k (i.e., downstream of k).
  // remaining.get(k) = count of deps k still waits on.
  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const k of byKey.keys()) {
    dependents.set(k, []);
    remaining.set(k, 0);
  }
  for (const e of edges) {
    const fromKey = refKey(e.from);
    const toKey = refKey(e.to);
    // Only count edges whose endpoints are real. The schema refine
    // rejects dangling edges, but `allEdges` also emits implied
    // edges that could point at missing components if impliedEdges
    // is called on a partially-invalid spec. Be defensive.
    if (!byKey.has(fromKey) || !byKey.has(toKey)) continue;
    dependents.get(toKey)!.push(fromKey);
    remaining.set(fromKey, (remaining.get(fromKey) ?? 0) + 1);
  }

  // Zero-in-degree queue, seeded in declaration order for stable ties.
  const zero: string[] = [];
  for (const [k, count] of remaining) {
    if (count === 0) zero.push(k);
  }
  zero.sort((a, b) => byKey.get(a)!.order - byKey.get(b)!.order);

  const out: ComponentRef[] = [];
  while (zero.length > 0) {
    const k = zero.shift()!;
    out.push(byKey.get(k)!.ref);
    const downstream = dependents.get(k) ?? [];
    // Sort the newly-freed nodes by declaration order so ties stay
    // stable across runs.
    const freed: string[] = [];
    for (const d of downstream) {
      const next = (remaining.get(d) ?? 0) - 1;
      remaining.set(d, next);
      if (next === 0) freed.push(d);
    }
    freed.sort((a, b) => byKey.get(a)!.order - byKey.get(b)!.order);
    // Insert in-order at the head so overall processing stays
    // insertion-sorted.
    zero.unshift(...freed);
    zero.sort((a, b) => byKey.get(a)!.order - byKey.get(b)!.order);
  }

  if (out.length !== nodes.length) {
    const stuck: string[] = [];
    for (const [k, count] of remaining) {
      if (count > 0) stuck.push(k.replace('/', '/'));
    }
    throw new Error(
      `cycle detected among: ${stuck.join(', ')}`,
    );
  }

  return out;
}

/**
 * Reverse of `topologicalOrder` — for teardown / rollback. The
 * caller supplies the already-sorted array so this stays a pure
 * array reversal; no recomputation of the DAG.
 */
export function reverseOrder(order: ComponentRef[]): ComponentRef[] {
  return [...order].reverse();
}
