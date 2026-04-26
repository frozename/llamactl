import type { ClusterNode } from '../../config/schema.js';
import type { ApplyEvent, ApplyResult, WorkloadClient } from '../apply.js';
import type { ModelRun } from '../schema.js';
import type { ProviderConfigCommon } from '../gateway-catalog/schema.js';

/**
 * Composite-authored context passed to gateway handlers when the
 * gateway originated from a `CompositeSpec`. Plain ModelRun gateways
 * (authored outside a composite) receive `composite: undefined` and
 * handlers behave exactly as before.
 *
 * `upstreams` carries the resolved endpoints of any workloads the
 * composite named in `gateway.upstreamWorkloads[]` — the composite
 * applier runs those workloads first and captures their live
 * endpoint, then threads the resolved list through to the handler.
 * Handlers can use this to auto-populate their provider catalogs
 * (sirius-providers.yaml, embersynth profile routes) instead of
 * asking the operator to edit those files by hand.
 *
 * `providerConfig` is the composite entry's opaque per-provider
 * overrides block. Handlers interpret the shape — v1 sirius /
 * embersynth ignore it (no auto-population); reserving the field
 * in the contract now keeps the wire stable for the follow-up
 * slice that wires handlers to consume it.
 */
export interface CompositeGatewayUpstream {
  /** Component name within the composite (workload's spec.node). */
  name: string;
  /** Resolved llama-server endpoint after the workload is up. */
  endpoint: string;
  /** Cluster node the upstream runs on. */
  nodeName: string;
}

export interface CompositeGatewayContext {
  /** metadata.name of the containing composite. */
  compositeName: string;
  /** Resolved upstream workloads in composite-declaration order. */
  upstreams: readonly CompositeGatewayUpstream[];
  /** Opaque per-provider overrides from the composite entry. */
  providerConfig: ProviderConfigCommon;
}

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
  /**
   * Set by the composite applier when this gateway apply originates
   * from a CompositeSpec entry. Undefined for plain ModelRun-driven
   * gateway applies.
   */
  composite?: CompositeGatewayContext;
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
  composite?: CompositeGatewayContext;
}) => Promise<ApplyResult | null>;