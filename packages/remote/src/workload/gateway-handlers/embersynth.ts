import { resolveNodeKind, type ClusterNode } from '../../config/schema.js';
import type { ApplyResult } from '../apply.js';
import type { GatewayApplyOptions, GatewayHandler } from './types.js';

/**
 * Embersynth gateway handler. Matches gateway-kind nodes whose cloud
 * binding names the `embersynth` provider.
 *
 * Full semantics (ensure profile / syntheticModels entry exists in
 * `embersynth.yaml`, then POST /reload) land in K.7.3. K.7.1 wires
 * the dispatch only — a matched handler returns Pending with a
 * clear `EmbersynthHandlerNotImplemented` condition so the seam is
 * visible to operators without pretending to do work.
 */
export const embersynthHandler: GatewayHandler = {
  kind: 'embersynth',
  canHandle(node: ClusterNode): boolean {
    return resolveNodeKind(node) === 'gateway' && node.cloud?.provider === 'embersynth';
  },
  async apply(opts: GatewayApplyOptions): Promise<ApplyResult> {
    const now = new Date().toISOString();
    const msg =
      `embersynth handler selected for '${opts.manifest.spec.node}'; ` +
      `profile/syntheticModels registration + /reload wiring lands in K.7.3 — ` +
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
            reason: 'EmbersynthHandlerNotImplemented',
            message: msg,
            lastTransitionTime: now,
          },
        ],
      },
    };
  },
};
