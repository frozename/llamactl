import type { ClusterNode } from '../../config/schema.js';
import type { ApplyEvent, ApplyResult, WorkloadClient } from '../apply.js';
import type { ModelRun } from '../schema.js';
import {
  AGENT_GATEWAY_HANDLER_KIND,
  agentGatewayHandler,
} from './agent-gateway.js';
import { embersynthHandler } from './embersynth.js';
import { siriusHandler } from './sirius.js';
import type { GatewayHandler } from './types.js';

/**
 * Default set of handlers shipped with llamactl. Order is significant:
 * the dispatcher picks the first handler whose `canHandle` matches.
 * Sirius + embersynth are checked before the agent-gateway catch-all
 * so a gateway-kind node with `cloud.provider: sirius` never matches
 * the fallback path by accident.
 */
export const DEFAULT_GATEWAY_HANDLERS: readonly GatewayHandler[] = [
  siriusHandler,
  embersynthHandler,
  agentGatewayHandler,
];

export interface DispatchGatewayApplyOptions {
  manifest: ModelRun;
  getClient: (nodeName: string) => WorkloadClient;
  resolveNode: (nodeName: string) => ClusterNode | undefined;
  onEvent?: (e: ApplyEvent) => void;
  handlers?: readonly GatewayHandler[];
  /**
   * Composite-authored context forwarded to the matched handler.
   * Undefined for plain ModelRun applies; populated when the caller
   * is the composite applier and the gateway entry declared
   * `upstreamWorkloads` / `providerConfig`.
   */
  composite?: import('./types.js').CompositeGatewayContext;
}

/**
 * Resolve the target node, pick a matching handler, and delegate.
 * Returns:
 *   - `null` when the matched handler is the agent-gateway sentinel —
 *     signals "fall through to the regular non-gateway apply path."
 *   - a fully-formed ApplyResult otherwise (including the Pending
 *     result from a stub handler like sirius/embersynth pre-K.7.2).
 *
 * Never throws on "unknown gateway kind" — we return a Pending
 * ApplyResult with a clear condition so the manifest remains visible
 * to the operator rather than blowing up the reconciler loop.
 */
export async function dispatchGatewayApply(
  opts: DispatchGatewayApplyOptions,
): Promise<ApplyResult | null> {
  const handlers = opts.handlers ?? DEFAULT_GATEWAY_HANDLERS;
  const nodeName = opts.manifest.spec.node;
  const node = opts.resolveNode(nodeName);
  const now = new Date().toISOString();

  if (!node) {
    const msg =
      `gateway workload targets unknown node '${nodeName}'; ` +
      `add it to kubeconfig with \`llamactl node add\` before applying`;
    opts.onEvent?.({
      type: 'gateway-pending',
      message: `${opts.manifest.metadata.name}: ${msg}`,
    });
    return {
      action: 'pending',
      statusSection: {
        phase: 'Pending',
        serverPid: null,
        endpoint: null,
        lastTransitionTime: now,
        conditions: [
          {
            type: 'Applied',
            status: 'False',
            reason: 'GatewayNodeUnknown',
            message: msg,
            lastTransitionTime: now,
          },
        ],
      },
    };
  }

  const handler = handlers.find((h) => h.canHandle(node));
  if (!handler) {
    const msg =
      `no gateway handler matches node '${nodeName}'; ` +
      `known kinds: ${handlers.map((h) => h.kind).join(', ')}`;
    opts.onEvent?.({
      type: 'gateway-pending',
      message: `${opts.manifest.metadata.name}: ${msg}`,
    });
    return {
      action: 'pending',
      statusSection: {
        phase: 'Pending',
        serverPid: null,
        endpoint: null,
        lastTransitionTime: now,
        conditions: [
          {
            type: 'Applied',
            status: 'False',
            reason: 'GatewayHandlerNotFound',
            message: msg,
            lastTransitionTime: now,
          },
        ],
      },
    };
  }

  if (handler.kind === AGENT_GATEWAY_HANDLER_KIND) {
    opts.onEvent?.({
      type: 'gateway-pending',
      message:
        `${opts.manifest.metadata.name}: spec.gateway:true targets agent-kind node ` +
        `'${nodeName}' — falling back to serverStart`,
    });
    return null;
  }

  return handler.apply({
    manifest: opts.manifest,
    node,
    getClient: opts.getClient,
    ...(opts.onEvent !== undefined && { onEvent: opts.onEvent }),
    ...(opts.composite !== undefined && { composite: opts.composite }),
  });
}
