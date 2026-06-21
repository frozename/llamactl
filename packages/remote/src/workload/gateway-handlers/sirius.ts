import { currentContext, loadConfig, resolveToken } from "@llamactl/core/config/kubeconfig";
import { type ClusterNode, resolveNodeKind } from "@llamactl/core/config/schema";

import type { ApplyResult } from "../apply.js";
import type { ApplyConflict } from "../gateway-catalog/index.js";
import type { GatewayApplyOptions, GatewayHandler } from "./types.js";

import { loadSiriusProviders, type SiriusProvider } from "../../config/sirius-providers.js";
import {
  applyCompositeEntries,
  deriveSiriusEntries,
  readGatewayCatalog,
  writeGatewayCatalog,
} from "../gateway-catalog/index.js";

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

function siriusConflictResult(
  opts: GatewayApplyOptions,
  conflicts: ApplyConflict[],
  now: string,
): ApplyResult {
  const [c] = conflicts;
  if (!c) throw new Error("gateway conflict list unexpectedly empty");
  const reason = c.kind === "name" ? "SiriusUpstreamNameCollision" : "SiriusUpstreamShapeMismatch";
  const message =
    c.kind === "name"
      ? `entry '${c.name}' already exists as an operator-authored provider; remove it or change composite spec`
      : `entry '${c.name}': ${c.detail}`;
  return pending(opts, reason, message, now);
}

/**
 * Compute the catalog union WITHOUT writing it. Detecting name/shape
 * conflicts is pure (no side effect), so it runs in the validate phase
 * before any disk write. `next` is the union of current + derived
 * entries — validation reads it so a composite's just-derived upstream
 * is visible without persisting a (possibly-doomed) catalog first.
 *
 * The actual `writeGatewayCatalog` is deferred to `writeSiriusCatalog`
 * and only fires once the upstream / baseUrl / token all validate — so
 * a rejected apply leaves no broken catalog on disk.
 */
function computeSiriusCatalog(
  opts: GatewayApplyOptions,
  now: string,
):
  | { ok: false; result: ApplyResult }
  | { ok: true; changed: boolean; next: SiriusProvider[] | null } {
  if (!opts.composite) return { ok: true, changed: false, next: null };
  const derived = deriveSiriusEntries(opts.composite);
  const current = readGatewayCatalog("sirius");
  const result = applyCompositeEntries({
    kind: "sirius",
    compositeName: opts.composite.compositeName,
    derived,
    current,
  });
  if (result.conflicts.length > 0) {
    return { ok: false, result: siriusConflictResult(opts, result.conflicts, now) };
  }
  return { ok: true, changed: result.changed, next: result.next };
}

/**
 * Persist the computed catalog union. The LAST side effect of a
 * successful apply — called only after the upstream / baseUrl / token
 * have all validated, so an invalid config never writes a catalog.
 */
function writeSiriusCatalog(
  opts: GatewayApplyOptions,
  next: SiriusProvider[],
  now: string,
): { ok: false; result: ApplyResult } | { ok: true } {
  try {
    writeGatewayCatalog("sirius", next);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      result: failure(
        opts,
        "SiriusCatalogWriteFailed",
        `could not write sirius-providers.yaml: ${(err as Error).message}`,
        now,
      ),
    };
  }
}

function resolveSiriusUpstream(
  opts: GatewayApplyOptions,
  now: string,
  /**
   * Computed catalog union (current + composite-derived) when this
   * apply originates from a composite, else null. Validating against
   * the union lets a composite's just-derived upstream satisfy the
   * "exists" check WITHOUT first persisting the catalog — so the disk
   * write can be deferred to the end and skipped on rejection. For a
   * plain (non-composite) apply this is null and we read disk as before.
   */
  computedProviders: SiriusProvider[] | null,
): { ok: false; result: ApplyResult } | { ok: true; upstream: string; modelId: string } {
  const targetValue = opts.manifest.spec.target.value;
  const slash = targetValue.indexOf("/");
  if (slash <= 0) {
    return {
      ok: false,
      result: failure(
        opts,
        "SiriusTargetMalformed",
        `sirius gateway manifests require spec.target.value in '<upstream>/<model>' form; got '${targetValue}'`,
        now,
      ),
    };
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
  // Composite applies validate against the computed union (which
  // already includes the just-derived upstream) so no catalog write is
  // needed before this check. Plain applies read the operator-maintained
  // file from disk exactly as before.
  let providers: SiriusProvider[];
  if (computedProviders !== null) {
    providers = computedProviders;
  } else {
    try {
      providers = loadSiriusProviders();
    } catch (err) {
      return {
        ok: false,
        result: failure(
          opts,
          "SiriusProvidersUnreadable",
          `failed to read sirius-providers.yaml: ${(err as Error).message}`,
          now,
        ),
      };
    }
  }
  if (providers.length === 0) {
    opts.onEvent?.({
      type: "gateway-pending",
      message: `${opts.manifest.metadata.name}: host-side sirius-providers.yaml empty/absent — deferring upstream validation to sirius /providers/reload`,
    });
  } else {
    const match = providers.find((p) => p.name === upstream);
    if (!match) {
      return {
        ok: false,
        result: pending(
          opts,
          "SiriusUpstreamMissing",
          `upstream '${upstream}' not found in sirius-providers.yaml; run \`llamactl sirius add-provider ${upstream} …\` first`,
          now,
        ),
      };
    }
  }

  return { ok: true, upstream, modelId };
}

async function performSiriusReload(
  opts: GatewayApplyOptions,
  baseUrl: string,
  upstream: string,
  modelId: string,
  token: string,
  now: string,
): Promise<ApplyResult> {
  // POST /providers/reload. Bearer-authed using the user resolved
  // from the current kubeconfig context.
  const reloadUrl = normalizeBaseUrl(baseUrl) + "/providers/reload";
  try {
    const res = await fetch(reloadUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ source: "llamactl-workload", name: opts.manifest.metadata.name }),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 500);
      return failure(
        opts,
        "SiriusReloadFailed",
        `POST ${reloadUrl} returned ${String(res.status)}${body ? `: ${body}` : ""}`,
        now,
      );
    }
  } catch (err) {
    return failure(
      opts,
      "SiriusReloadUnreachable",
      `POST ${reloadUrl} failed: ${(err as Error).message}`,
      now,
    );
  }

  const endpoint = `${normalizeBaseUrl(baseUrl)}/v1/chat/completions`;
  opts.onEvent?.({
    type: "gateway-pending",
    message: `${opts.manifest.metadata.name}: sirius reloaded — '${modelId}' via upstream '${upstream}' now routable at ${endpoint}`,
  });
  return {
    action: "started",
    statusSection: {
      phase: "Running",
      serverPid: null,
      endpoint,
      lastTransitionTime: now,
      conditions: [
        {
          type: "Applied",
          status: "True",
          reason: "SiriusReloaded",
          message: `sirius reloaded providers/${upstream}; model '${modelId}' is routable`,
          lastTransitionTime: now,
        },
      ],
    },
  };
}

export const siriusHandler: GatewayHandler = {
  kind: "sirius",
  canHandle(node: ClusterNode): boolean {
    return resolveNodeKind(node) === "gateway" && node.cloud?.provider === "sirius";
  },
  async apply(opts: GatewayApplyOptions): Promise<ApplyResult> {
    const now = new Date().toISOString();

    // VALIDATE FIRST, WRITE LAST. The catalog write is a persistent
    // side effect: a bad config (unreachable upstream, missing baseUrl,
    // unresolvable token) must NOT leave a broken sirius-providers.yaml
    // on disk. So compute the catalog union here (pure — no write),
    // run every validation against it, and only persist once all checks
    // pass, just before the reload.
    const catalogResult = computeSiriusCatalog(opts, now);
    if (!catalogResult.ok) return catalogResult.result;

    const upstreamResult = resolveSiriusUpstream(opts, now, catalogResult.next);
    if (!upstreamResult.ok) return upstreamResult.result;

    const baseUrl = opts.node.cloud?.baseUrl;
    if (!baseUrl) {
      return failure(
        opts,
        "SiriusBaseUrlMissing",
        `gateway node '${opts.node.name}' has no cloud.baseUrl — edit kubeconfig`,
        now,
      );
    }

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
        "SiriusTokenUnresolved",
        `could not resolve bearer token for sirius reload: ${(err as Error).message}`,
        now,
      );
    }

    // All validation passed — NOW persist the catalog (last side effect
    // before the reload). Only composites with a real diff write; plain
    // applies (next === null) never touch the file.
    if (catalogResult.changed && catalogResult.next) {
      const written = writeSiriusCatalog(opts, catalogResult.next, now);
      if (!written.ok) return written.result;
    }

    if (!opts.composite || catalogResult.changed) {
      return await performSiriusReload(
        opts,
        baseUrl,
        upstreamResult.upstream,
        upstreamResult.modelId,
        token,
        now,
      );
    }

    const endpoint = `${normalizeBaseUrl(baseUrl)}/v1/chat/completions`;
    opts.onEvent?.({
      type: "gateway-pending",
      message: `${opts.manifest.metadata.name}: sirius reloaded — '${upstreamResult.modelId}' via upstream '${upstreamResult.upstream}' now routable at ${endpoint}`,
    });
    return {
      action: "started",
      statusSection: {
        phase: "Running",
        serverPid: null,
        endpoint,
        lastTransitionTime: now,
        conditions: [
          {
            type: "Applied",
            status: "True",
            reason: "SiriusReloaded",
            message: `sirius reloaded providers/${upstreamResult.upstream}; model '${upstreamResult.modelId}' is routable`,
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
  return url.replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

function pending(
  opts: GatewayApplyOptions,
  reason: string,
  message: string,
  now: string,
): ApplyResult {
  opts.onEvent?.({
    type: "gateway-pending",
    message: `${opts.manifest.metadata.name}: ${message}`,
  });
  return {
    action: "pending",
    statusSection: {
      phase: "Pending",
      serverPid: null,
      endpoint: null,
      lastTransitionTime: now,
      conditions: [
        {
          type: "Applied",
          status: "False",
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
    type: "gateway-pending",
    message: `${opts.manifest.metadata.name}: ${message}`,
  });
  return {
    action: "pending",
    statusSection: {
      phase: "Failed",
      serverPid: null,
      endpoint: null,
      lastTransitionTime: now,
      conditions: [
        {
          type: "Applied",
          status: "False",
          reason,
          message,
          lastTransitionTime: now,
        },
      ],
    },
  };
}
