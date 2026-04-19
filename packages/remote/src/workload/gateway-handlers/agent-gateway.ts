import { resolveNodeKind, type ClusterNode } from '../../config/schema.js';
import type { ApplyResult } from '../apply.js';
import type { GatewayApplyOptions, GatewayHandler } from './types.js';

/**
 * Sentinel handler: when `spec.gateway: true` is pointed at a plain
 * `agent`-kind node, treat that as a regular llama-server workload.
 * The dispatch layer detects this handler by its `kind` field and
 * returns `null` from `dispatchGatewayApply` so applyOne falls
 * through to its non-gateway code path.
 *
 * Rationale: an agent running llama-server IS functionally a gateway
 * for its local models. Operators that set `gateway: true` on an
 * agent manifest probably don't care about the distinction; we honor
 * the intent (a working server) rather than returning a Pending
 * that would force them to rewrite the manifest.
 */
export const AGENT_GATEWAY_HANDLER_KIND = 'agent-gateway';

export const agentGatewayHandler: GatewayHandler = {
  kind: AGENT_GATEWAY_HANDLER_KIND,
  canHandle(node: ClusterNode): boolean {
    return resolveNodeKind(node) === 'agent';
  },
  // Never actually called by the dispatcher — matched-by-kind short-
  // circuits first. Kept for interface uniformity and as a defensive
  // fallback if someone invokes it directly in a test.
  async apply(_opts: GatewayApplyOptions): Promise<ApplyResult> {
    throw new Error(
      'agentGatewayHandler.apply() should not be called; dispatcher detects this handler and falls back to serverStart',
    );
  },
};
