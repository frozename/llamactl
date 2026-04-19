import { resolveNodeKind, type ClusterNode } from '../../config/schema.js';
import type { ApplyResult } from '../apply.js';
import type { GatewayApplyOptions, GatewayHandler } from './types.js';

/**
 * Sirius gateway handler. Matches gateway-kind nodes whose cloud
 * binding names the `sirius` provider.
 *
 * K.7.1 ships the dispatch wiring only — the actual YAML-write +
 * `/providers/reload` flow lands in K.7.2. For now we return a
 * clear `SiriusHandlerNotImplemented` condition so operators see
 * the handler *was* picked (the dispatch seam works) and the wet-
 * run wiring is the next follow-up.
 */
export const siriusHandler: GatewayHandler = {
  kind: 'sirius',
  canHandle(node: ClusterNode): boolean {
    return resolveNodeKind(node) === 'gateway' && node.cloud?.provider === 'sirius';
  },
  async apply(opts: GatewayApplyOptions): Promise<ApplyResult> {
    const now = new Date().toISOString();
    const msg =
      `sirius handler selected for '${opts.manifest.spec.node}'; ` +
      `registry write + /providers/reload wiring lands in K.7.2 — ` +
      `manifest target='${opts.manifest.spec.target.value}' recorded but no upstream mutation yet`;
    opts.onEvent?.({ type: 'gateway-pending', message: `${opts.manifest.metadata.name}: ${msg}` });
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
            reason: 'SiriusHandlerNotImplemented',
            message: msg,
            lastTransitionTime: now,
          },
        ],
      },
    };
  },
};
