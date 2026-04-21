import { resolveNodeKind, type ClusterNode } from '../../config/schema.js';
import { loadSiriusProviders } from '../../config/sirius-providers.js';
import { resolveToken, loadConfig, currentContext } from '../../config/kubeconfig.js';
import type { ApplyResult } from '../apply.js';
import type { GatewayApplyOptions, GatewayHandler } from './types.js';

/**
 * Sirius gateway handler.
 *
 * Contract: the manifest's `spec.target.value` is `<upstream>/<model>`
 * (for example `openai/gpt-4o` or `fleet-gpu1/gemma-4`). The
 * `<upstream>` must name an entry in `sirius-providers.yaml`. Applying
 * this manifest is a "tell sirius to rediscover" action:
 *
 *   1. Confirm the named upstream exists in sirius-providers.yaml.
 *      If missing → Pending + SiriusUpstreamMissing (the operator
 *      needs to `llamactl sirius add-provider` first).
 *   2. POST <node.cloud.baseUrl>/providers/reload with bearer auth.
 *      2xx → Running, endpoint=<baseUrl>, Applied=True.
 *      non-2xx → Failed + SiriusReloadFailed with response preview.
 *      Network error → Failed + SiriusReloadFailed with the error text.
 *
 * llamactl does not rewrite sirius-providers.yaml here — sirius's
 * responsibility is re-querying each provider's `/v1/models` on
 * reload. Schema extensions (per-model tags, allowedModels list, etc.)
 * are a deliberate follow-up so this slice stays compatible with the
 * sirius-providers.yaml shape today.
 */
export const siriusHandler: GatewayHandler = {
  kind: 'sirius',
  canHandle(node: ClusterNode): boolean {
    return resolveNodeKind(node) === 'gateway' && node.cloud?.provider === 'sirius';
  },
  async apply(opts: GatewayApplyOptions): Promise<ApplyResult> {
    const now = new Date().toISOString();
    const targetValue = opts.manifest.spec.target.value;
    const slash = targetValue.indexOf('/');
    if (slash <= 0) {
      return failure(
        opts,
        'SiriusTargetMalformed',
        `sirius gateway manifests require spec.target.value in '<upstream>/<model>' form; got '${targetValue}'`,
        now,
      );
    }
    const upstream = targetValue.slice(0, slash);
    const modelId = targetValue.slice(slash + 1);

    // Best-effort host-side validation. We read the same YAML sirius
    // does, so a "not found" here matches what sirius would report
    // itself. When the file is absent or empty — typical for
    // containerized sirius deployments where the providers config
    // lives in a ConfigMap mount inside the pod — skip the check and
    // defer to sirius's /providers/reload response, which returns the
    // authoritative error if the upstream is truly missing. Eager
    // host-side validation stays the first line of defense whenever
    // the operator maintains their own `sirius-providers.yaml` via
    // `llamactl sirius add-provider`.
    let providers;
    try {
      providers = loadSiriusProviders();
    } catch (err) {
      return failure(
        opts,
        'SiriusProvidersUnreadable',
        `failed to read sirius-providers.yaml: ${(err as Error).message}`,
        now,
      );
    }
    if (providers.length === 0) {
      opts.onEvent?.({
        type: 'gateway-pending',
        message: `${opts.manifest.metadata.name}: host-side sirius-providers.yaml empty/absent — deferring upstream validation to sirius /providers/reload`,
      });
    } else {
      const match = providers.find((p) => p.name === upstream);
      if (!match) {
        return pending(
          opts,
          'SiriusUpstreamMissing',
          `upstream '${upstream}' not found in sirius-providers.yaml; run \`llamactl sirius add-provider ${upstream} …\` first`,
          now,
        );
      }
    }

    const baseUrl = opts.node.cloud?.baseUrl;
    if (!baseUrl) {
      return failure(
        opts,
        'SiriusBaseUrlMissing',
        `gateway node '${opts.node.name}' has no cloud.baseUrl — edit kubeconfig`,
        now,
      );
    }

    // POST /providers/reload. Bearer-authed using the user resolved
    // from the current kubeconfig context.
    const reloadUrl = normalizeBaseUrl(baseUrl) + '/providers/reload';
    let token: string;
    try {
      const cfg = loadConfig();
      const ctx = currentContext(cfg);
      const user = cfg.users.find((u) => u.name === ctx.user);
      if (!user) throw new Error(`current user '${ctx.user}' not in kubeconfig`);
      token = resolveToken(user);
    } catch (err) {
      return failure(
        opts,
        'SiriusTokenUnresolved',
        `could not resolve bearer token for sirius reload: ${(err as Error).message}`,
        now,
      );
    }

    try {
      const res = await fetch(reloadUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ source: 'llamactl-workload', name: opts.manifest.metadata.name }),
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 500);
        return failure(
          opts,
          'SiriusReloadFailed',
          `POST ${reloadUrl} returned ${res.status}${body ? `: ${body}` : ''}`,
          now,
        );
      }
    } catch (err) {
      return failure(
        opts,
        'SiriusReloadUnreachable',
        `POST ${reloadUrl} failed: ${(err as Error).message}`,
        now,
      );
    }

    const endpoint = `${normalizeBaseUrl(baseUrl)}/v1/chat/completions`;
    opts.onEvent?.({
      type: 'gateway-pending',
      message: `${opts.manifest.metadata.name}: sirius reloaded — '${modelId}' via upstream '${upstream}' now routable at ${endpoint}`,
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
            reason: 'SiriusReloaded',
            message: `sirius reloaded providers/${upstream}; model '${modelId}' is routable`,
            lastTransitionTime: now,
          },
        ],
      },
    };
  },
};

function normalizeBaseUrl(url: string): string {
  // Strip a trailing /v1 or /v1/ so we can construct paths off the
  // root consistently. Sirius serves both /providers/reload and /v1.
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
