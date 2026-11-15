// #282 DF-09: oMLX SSD prefix-cache identity + retain/invalidate
// (artifact/build/cache-epoch checks).
//
// The classification is pinned to OMLX_MODEL_SETTINGS_REVISION
// (feec0a0e4eda6ad5c227a5f9ee216c6fb6d2fe9b) and was verified against local
// oMLX c71ec6836fb4fd7a39d14fe0530fe84540e4cb72.
//
// References:
//   cache/paged_cache.py compute_block_hash
//     (model_name + tokens + extra_keys only);
//   engine/batched.py:293-298 and engine/vlm.py:753-760
//     (TurboQuant wired only when enabled);
//   cache/prefix_cache.py
//     stored __turboquant_v2__ state;
//   paged_ssd_cache.py:1163/1251
//     reading both the __turboquant__ and __turboquant_v2__ markers
//     (the SSD format changes across builds, which is why engineBuild is part
//     of the identity);
//   scheduler.py:5314
//     "SpecPrefill: sparse KV data can't be stored in paged cache";
//   the separate make_mtp_cache in patches/mlx_lm_mtp;
//   model_settings.py defaults (bits 4, skip_last True).
//
// Getting engineBuild from the installed oMLX, and storing the previous
// identity, belong to the later modelhost wiring slice.

import { createHash } from "node:crypto";

import type { OmlxManagedModelSettings } from "./omlx-model-settings.js";

export const OMLX_CACHE_IDENTITY_VERSION = 1;

export const OMLX_CACHE_AFFECTING_SETTINGS_KEYS = [
  "turboquant_kv_enabled",
  "turboquant_kv_bits",
  "turboquant_skip_last",
] as const;

/**
 * The 15 managed keys that do not affect cache content. Each key is listed in
 * OMLX_MANAGED_MODEL_SETTINGS_KEYS order with a one-line reason.
 */
export const OMLX_CACHE_NEUTRAL_SETTINGS_KEYS = [
  "max_context_window", // context window size, not model weights
  "max_tokens", // max generation tokens, not model weights
  "chat_template_kwargs", // prompt templating, not model weights
  "forced_ct_kwargs", // constrained decoding grammar, not model weights
  "enable_thinking", // thinking mode flag, not model weights
  "preserve_thinking", // thinking block preservation, not model weights
  "thinking_budget_enabled", // thinking token budget, not model weights
  "thinking_budget_tokens", // thinking token budget amount, not model weights
  "reasoning_parser", // reasoning output parser, not model weights
  "specprefill_enabled", // speculative prefill toggle, KV can't be cached (scheduler.py:5314)
  "specprefill_draft_model", // speculative prefill draft model ref, KV can't be cached
  "specprefill_keep_pct", // speculative prefill keep pct, KV can't be cached
  "specprefill_threshold", // speculative prefill threshold, KV can't be cached
  "mtp_enabled", // multi-token prediction toggle, separate make_mtp_cache
  "mtp_num_draft_tokens", // MTP draft token count, separate make_mtp_cache
] as const;

export interface OmlxCacheArtifact {
  /** Path to the model artifact (usually a directory; oMLX models are
   *  typically directories containing weight shards plus config files). */
  path: string;
  /** Optional size in bytes of the weight files (sum of *.safetensors shards
   *  plus config.json / model.safetensors.index.json). Must not come from
   *  the directory's own stat, because replacing a shard does not change it. */
  sizeBytes?: number;
  /** Optional max mtimeMs of the weight files (max over the *.safetensors
   *  shards plus config.json / model.safetensors.index.json). */
  mtimeMs?: number;
  /** Optional sha256 of the weights or a manifest of them. Preferred when
   *  available and takes precedence over sizeBytes/mtimeMs. */
  sha256?: string;
}

export interface OmlxCacheIdentityInput {
  /** Model identifier string. */
  modelId: string;
  /** The oMLX build/revision string (git SHA or version). */
  engineBuild: string;
  /** An operator bump that forces invalidation. Default 0. */
  cacheEpoch?: number;
  /** Model artifact identity. */
  artifact: OmlxCacheArtifact;
  /** Optional TurboQuant and other managed model settings. */
  settings?: OmlxManagedModelSettings;
}

export type OmlxCacheIdentityFailure =
  | "ArtifactIdentityUnavailable"
  | "EngineBuildUnavailable"
  | "CacheEpochInvalid";

export type OmlxCacheIdentityResult =
  | { ok: true; identity: string }
  | { ok: false; reason: OmlxCacheIdentityFailure };

export type OmlxCacheRetentionDecision =
  | { action: "retain"; reason: "IdentityMatch"; identity: string }
  | { action: "invalidate"; reason: "IdentityChanged" | "NoPreviousIdentity"; identity: string }
  | { action: "invalidate"; reason: OmlxCacheIdentityFailure; identity: null };

type NormalizedArtifact =
  | { path: string; sha256: string }
  | { path: string; sizeBytes: number; mtimeMs: number };

type NormalizedTurboQuant = { bits: number; skipLast: boolean } | null;

function normalizeArtifact(artifact: OmlxCacheArtifact): NormalizedArtifact | null {
  const path = artifact.path;
  if (typeof path !== "string" || path.length === 0) {
    return null;
  }
  const sha256 = artifact.sha256;
  if (typeof sha256 === "string" && sha256.length > 0) {
    if (/^[0-9a-f]{64}$/.test(sha256)) {
      return { path, sha256 };
    }
    return null;
  }
  const sizeBytes = artifact.sizeBytes;
  const mtimeMs = artifact.mtimeMs;
  if (typeof sizeBytes === "number" && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0) {
    if (typeof mtimeMs === "number" && Number.isFinite(mtimeMs)) {
      return { path, sizeBytes, mtimeMs };
    }
  }
  return null;
}

function normalizeEngineBuild(engineBuild: string | undefined): string | null {
  if (typeof engineBuild !== "string") {
    return null;
  }
  return engineBuild.trim().length > 0 ? engineBuild.trim() : null;
}

function normalizeCacheEpoch(cacheEpoch: number | undefined): number | null {
  if (cacheEpoch === undefined) {
    return 0;
  }
  if (typeof cacheEpoch === "number" && Number.isSafeInteger(cacheEpoch) && cacheEpoch >= 0) {
    return cacheEpoch;
  }
  return null;
}

function normalizeTurboQuant(settings: OmlxManagedModelSettings | undefined): NormalizedTurboQuant {
  if (settings?.turboquant_kv_enabled === true) {
    return {
      bits: settings.turboquant_kv_bits ?? 4,
      skipLast: settings.turboquant_skip_last ?? true,
    };
  }
  return null;
}

function canonicalString(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

function sortObjectKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }
  if (typeof obj === "object" && obj !== null) {
    const entries = Object.entries(obj).sort(function (a, b) {
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    const result: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      result[key] = sortObjectKeys(value);
    }
    return result;
  }
  return obj;
}

export function deriveOmlxCacheIdentity(input: OmlxCacheIdentityInput): OmlxCacheIdentityResult {
  const artifact = normalizeArtifact(input.artifact);
  if (artifact === null) {
    return { ok: false, reason: "ArtifactIdentityUnavailable" };
  }

  const engineBuild = normalizeEngineBuild(input.engineBuild);
  if (engineBuild === null) {
    return { ok: false, reason: "EngineBuildUnavailable" };
  }

  const cacheEpoch = normalizeCacheEpoch(input.cacheEpoch);
  if (cacheEpoch === null) {
    return { ok: false, reason: "CacheEpochInvalid" };
  }

  const turboquant = normalizeTurboQuant(input.settings);

  const payload = {
    artifact,
    cacheEpoch,
    engineBuild,
    modelId: input.modelId,
    turboquant,
    v: OMLX_CACHE_IDENTITY_VERSION,
  };

  const canonical = canonicalString(payload);
  const hash = createHash("sha256").update(canonical).digest("hex");
  const identity = `omlx-cache-v1:${hash}`;

  return { ok: true, identity };
}

export function decideOmlxCacheRetention(
  previousIdentity: string | null | undefined,
  input: OmlxCacheIdentityInput,
): OmlxCacheRetentionDecision {
  const result = deriveOmlxCacheIdentity(input);

  if (!result.ok) {
    return { action: "invalidate", reason: result.reason, identity: null };
  }

  if (previousIdentity === null || previousIdentity === undefined) {
    return { action: "invalidate", reason: "NoPreviousIdentity", identity: result.identity };
  }

  if (previousIdentity === result.identity) {
    return { action: "retain", reason: "IdentityMatch", identity: result.identity };
  }

  return { action: "invalidate", reason: "IdentityChanged", identity: result.identity };
}
