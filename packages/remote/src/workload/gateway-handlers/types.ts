import type { ClusterNode } from '../../config/schema.js';
import type { ApplyEvent, ApplyResult, WorkloadClient } from '../apply.js';
import type { ModelRun } from '../schema.js';

/**
 * Gateway-kind workload handler. Each gateway flavour (sirius,
 * embersynth, an llamactl agent acting as a gateway) ships its own
 * handler implementing this interface.
 *
 * Handlers own their config-file IO, their reload protocol, and
 * their notion of what a manifest's `target.value` means. The
 * dispatch layer (`registry.ts`) is gateway-agnostic — it only knows
 * how to pick a handler by calling each one's `canHandle`.
 */
export interface GatewayHandler {
  /** Short stable identifier for logs + condition reasons. */
  kind: string;
  /**
   * Decide whether this handler owns the given node. Implementations
   * must be cheap + side-effect-free; the dispatch layer calls
   * `canHandle` on every handler in registration order and picks the
   * first match.
   */
  canHandle(node: ClusterNode): boolean;
  apply(opts: GatewayApplyOptions): Promise<ApplyResult>;
}

export interface GatewayApplyOptions {
  manifest: ModelRun;
  node: ClusterNode;
  /** Reuse the same per-node client factory applyOne() uses for
   *  non-gateway workloads — the agent-as-gateway fallback delegates
   *  straight back to it. Sirius + embersynth handlers generally
   *  don't need it. */
  getClient: (nodeName: string) => WorkloadClient;
  onEvent?: (e: ApplyEvent) => void;
}

/**
 * Invoked by `applyOne` when `spec.gateway: true`. Implementations
 * resolve the target node from kubeconfig, pick a handler, and
 * return the resulting ApplyResult. Broken out as a standalone type
 * so `applyOne` can accept it as an injectable parameter without
 * importing the registry directly — keeps the core apply module
 * handler-free at the type level.
 */
export type GatewayDispatch = (opts: {
  manifest: ModelRun;
  getClient: (nodeName: string) => WorkloadClient;
  onEvent?: (e: ApplyEvent) => void;
}) => Promise<ApplyResult | null>;
