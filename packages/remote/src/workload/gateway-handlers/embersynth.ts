import {
  loadEmbersynthConfig,
  defaultEmbersynthConfigPath,
} from '../../config/embersynth.js';
import { resolveNodeKind, type ClusterNode } from '../../config/schema.js';
import { currentContext, loadConfig, resolveToken } from '../../config/kubeconfig.js';
import type { ApplyResult } from '../apply.js';
import type { GatewayApplyOptions, GatewayHandler } from './types.js';
import {
  deriveEmbersynthEntries,
  applyCompositeEntries,
  readGatewayCatalog,
  writeGatewayCatalog,
} from '../gateway-catalog/index.js';

/**
 * Embersynth gateway handler.
 *
 * Contract: the manifest's `spec.target.value` names a synthetic
 * model published by embersynth — either exactly (`fusion-vision`)
 * or via the profile id it derives from (`vision` → `fusion-vision`).
 * Applying the manifest is a "tell embersynth to rediscover" action:
 *
 *   1. Confirm the synthetic model exists in embersynth.yaml. If
 *      missing → Pending + EmbersynthSyntheticMissing (operator must
 *      edit embersynth.yaml or add a profile first).
 *   2. POST <node.cloud.baseUrl>/config/reload with bearer auth.
 *      2xx → Running + endpoint=<baseUrl>/v1/chat/completions.
 *      non-2xx → Failed + EmbersynthReloadFailed.
 *      Network failure → Failed + EmbersynthReloadUnreachable.
 *
 * llamactl does not rewrite embersynth.yaml here — `llamactl
 * embersynth sync` is the dedicated mutation entry point. The
 * workload handler's role is coordinating timing (reload after
 * upstream changes land), not authoring routing config.
 */
export const embersynthHandler: GatewayHandler = {
  kind: 'embersynth',
  canHandle(node: ClusterNode): boolean {
    return resolveNodeKind(node) === 'gateway' && node.cloud?.provider === 'embersynth';
  },
  async apply(opts: GatewayApplyOptions): Promise<ApplyResult> {
    const now = new Date().toISOString();

    let catalogChanged = false;
    if (opts.composite) {
      const derived = deriveEmbersynthEntries(opts.composite);
      const current = readGatewayCatalog('embersynth');
      const result = applyCompositeEntries({
        kind: 'embersynth',
        compositeName: opts.composite.compositeName,
        derived,
        current,
      });
      if (result.conflicts.length > 0) {
        const c = result.conflicts[0]!;
        const reason =
          c.kind === 'name' ? 'EmbersynthUpstreamNameCollision' : 'EmbersynthUpstreamShapeMismatch';
        const message =
          c.kind === 'name'
            ? `node '${c.name}' already exists as an operator-authored embersynth node; remove it or change composite spec`
            : `node '${c.name}': ${c.detail}`;
        return pending(opts, reason, message, now);
      }
      if (result.changed) {
        try {
          writeGatewayCatalog('embersynth', result.next);
          catalogChanged = true;
        } catch (err) {
          return failure(
            opts,
            'EmbersynthCatalogWriteFailed',
            `could not write embersynth.yaml: ${(err as Error).message}`,
            now,
          );
        }
      }
    }

    const target = opts.manifest.spec.target.value.trim();
    if (!target) {
      return failure(
        opts,
        'EmbersynthTargetMalformed',
        `embersynth gateway manifests require spec.target.value to name a synthetic model`,
        now,
      );
    }
    const synthetic = target.startsWith('fusion-') ? target : `fusion-${target}`;

    // Best-effort host-side validation. When `embersynth.yaml` lives
    // on the operator's host (from `llamactl embersynth init`), we
    // cross-check the requested synthetic before calling the gateway
    // so typos surface with a clear error. When the config lives
    // only inside the embersynth pod (ConfigMap mount pattern —
    // file absent on host), skip the host check and defer to
    // embersynth's /config/reload, which authoritatively answers
    // whether the synthetic exists.
    let cfg;
    try {
      cfg = loadEmbersynthConfig(defaultEmbersynthConfigPath());
    } catch (err) {
      return failure(
        opts,
        'EmbersynthConfigUnreadable',
        `failed to read embersynth.yaml: ${(err as Error).message}`,
        now,
      );
    }
    if (!cfg) {
      opts.onEvent?.({
        type: 'gateway-pending',
        message: `${opts.manifest.metadata.name}: host-side embersynth.yaml absent — deferring synthetic-model validation to embersynth /config/reload`,
      });
    } else if (!(synthetic in cfg.syntheticModels)) {
      return pending(
        opts,
        'EmbersynthSyntheticMissing',
        `synthetic model '${synthetic}' not defined in embersynth.yaml; run \`llamactl embersynth sync\` or edit syntheticModels`,
        now,
      );
    }

    const baseUrl = opts.node.cloud?.baseUrl;
    if (!baseUrl) {
      return failure(
        opts,
        'EmbersynthBaseUrlMissing',
        `gateway node '${opts.node.name}' has no cloud.baseUrl — edit kubeconfig`,
        now,
      );
    }
    const reloadUrl = normalizeBaseUrl(baseUrl) + '/config/reload';

    let token: string;
    try {
      const kube = loadConfig();
      const ctx = currentContext(kube);
      const user = kube.users.find((u) => u.name === ctx.user);
      if (!user) throw new Error(`current user '${ctx.user}' not in kubeconfig`);
      token = resolveToken(user);
    } catch (err) {
      return failure(
        opts,
        'EmbersynthTokenUnresolved',
        `could not resolve bearer token for embersynth reload: ${(err as Error).message}`,
        now,
      );
    }

    if (!opts.composite || catalogChanged) {
      try {
        const res = await fetch(reloadUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            source: 'llamactl-workload',
            name: opts.manifest.metadata.name,
            syntheticModel: synthetic,
          }),
        });
        if (!res.ok) {
          const body = (await res.text().catch(() => '')).slice(0, 500);
          return failure(
            opts,
            'EmbersynthReloadFailed',
            `POST ${reloadUrl} returned ${res.status}${body ? `: ${body}` : ''}`,
            now,
          );
        }
      } catch (err) {
        return failure(
          opts,
          'EmbersynthReloadUnreachable',
          `POST ${reloadUrl} failed: ${(err as Error).message}`,
          now,
        );
      }
    }

    const endpoint = `${normalizeBaseUrl(baseUrl)}/v1/chat/completions`;
    opts.onEvent?.({
      type: 'gateway-pending',
      message: `${opts.manifest.metadata.name}: embersynth reloaded — '${synthetic}' routable at ${endpoint}`,
    });
    return {
      action: 'started',
      statusSection: {
        phase: 'Running',
        serverPid: null,
        endpoint,
        lastTransitionTime: now,
        conditions: [
          {
            type: 'Applied',
            status: 'True',
            reason: 'EmbersynthReloaded',
            message: `embersynth reloaded; synthetic model '${synthetic}' is routable`,
            lastTransitionTime: now,
          },
        ],
      },
    };
  },
};

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

function pending(
  opts: GatewayApplyOptions,
  reason: string,
  message: string,
  now: string,
): ApplyResult {
  opts.onEvent?.({
    type: 'gateway-pending',
    message: `${opts.manifest.metadata.name}: ${message}`,
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
          reason,
          message,
          lastTransitionTime: now,
        },
      ],
    },
  };
}

function failure(
  opts: GatewayApplyOptions,
  reason: string,
  message: string,
  now: string,
): ApplyResult {
  opts.onEvent?.({
    type: 'gateway-pending',
    message: `${opts.manifest.metadata.name}: ${message}`,
  });
  return {
    action: 'pending',
    statusSection: {
      phase: 'Failed',
      serverPid: null,
      endpoint: null,
      lastTransitionTime: now,
      conditions: [
        {
          type: 'Applied',
          status: 'False',
          reason,
          message,
          lastTransitionTime: now,
        },
      ],
    },
  };
}