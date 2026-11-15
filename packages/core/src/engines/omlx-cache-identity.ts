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
//
// Fail-closed contract: an input that cannot be derived exactly yields a
// failure reason, and decideOmlxCacheRetention maps every failure to
// invalidate. A settings key outside OMLX_CACHE_AFFECTING_SETTINGS_KEYS and
// OMLX_CACHE_NEUTRAL_SETTINGS_KEYS is unknown to this module, so its value is
// hashed into the identity rather than ignored: a change to it invalidates.

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
 * OMLX_MANAGED_MODEL_SETTINGS_KEYS order with a one-line reason. These are the
 * only settings keys left out of the identity; every other key is hashed.
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
   *  the directory's own stat, because replacing a shard does not change it.
   *  Must be a non-negative safe integer. */
  sizeBytes?: number;
  /** Optional max mtimeMs of the weight files (max over the *.safetensors
   *  shards plus config.json / model.safetensors.index.json). Must be a
   *  non-negative safe integer: truncate fs.Stats#mtimeMs with Math.trunc.
   *  A negative, fractional, NaN or infinite value fails closed. */
  mtimeMs?: number;
  /** Optional lowercase hex sha256 of the weights or a manifest of them.
   *  Preferred when available and takes precedence over sizeBytes/mtimeMs.
   *  An empty string counts as absent and falls back to sizeBytes/mtimeMs;
   *  any other value that is not 64 lowercase hex digits fails closed. */
  sha256?: string;
}

export interface OmlxCacheIdentityInput {
  /** Model identifier string. Surrounding whitespace is ignored; an empty or
   *  non-string value fails closed with ModelIdUnavailable. */
  modelId: string;
  /** The oMLX build/revision string (git SHA or version). Surrounding
   *  whitespace is ignored; an empty or non-string value fails closed with
   *  EngineBuildUnavailable. */
  engineBuild: string;
  /** An operator bump that forces invalidation. Default 0. */
  cacheEpoch?: number;
  /** Model artifact identity. */
  artifact: OmlxCacheArtifact;
  /** Optional model settings. Neutral keys are ignored, the TurboQuant keys
   *  are normalised, and any other key is hashed canonically. A value with no
   *  canonical JSON form fails closed with SettingsInvalid. */
  settings?: OmlxManagedModelSettings;
}

export type OmlxCacheIdentityFailure =
  | "ModelIdUnavailable"
  | "ArtifactIdentityUnavailable"
  | "EngineBuildUnavailable"
  | "CacheEpochInvalid"
  | "SettingsInvalid";

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

type NormalizedSettings = {
  turboquant: NormalizedTurboQuant;
  /** Non-neutral, non-TurboQuant keys; null when there are none. */
  unknown: Record<string, unknown> | null;
};

const AFFECTING_KEYS: ReadonlySet<string> = new Set(OMLX_CACHE_AFFECTING_SETTINGS_KEYS);
const NEUTRAL_KEYS: ReadonlySet<string> = new Set(OMLX_CACHE_NEUTRAL_SETTINGS_KEYS);

/** A prototype-less record, so that an own "__proto__" key (JSON.parse makes
 *  one) is stored as data instead of hitting the Object.prototype setter. */
function createRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeArtifact(value: unknown): NormalizedArtifact | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const artifact = value as Partial<Record<keyof OmlxCacheArtifact, unknown>>;
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
  if (isNonNegativeSafeInteger(sizeBytes) && isNonNegativeSafeInteger(mtimeMs)) {
    return { path, sizeBytes, mtimeMs };
  }
  return null;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * True when JSON.stringify of the value is lossless: null, booleans, strings,
 * finite numbers, and arrays or plain objects of those. NaN and Infinity both
 * stringify to null, a Date or Map to {} and undefined inside an array to
 * null, so hashing them could make distinct values collide.
 */
function hasCanonicalJson(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(hasCanonicalJson);
  }
  if (isPlainObject(value)) {
    return Object.values(value).every(hasCanonicalJson);
  }
  return false;
}

/** undefined when a present TurboQuant key has the wrong type. */
function normalizeTurboQuant(settings: Record<string, unknown>): NormalizedTurboQuant | undefined {
  const enabled = settings["turboquant_kv_enabled"];
  const bits = settings["turboquant_kv_bits"];
  const skipLast = settings["turboquant_skip_last"];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return undefined;
  }
  if (bits !== undefined && (typeof bits !== "number" || !Number.isFinite(bits))) {
    return undefined;
  }
  if (skipLast !== undefined && typeof skipLast !== "boolean") {
    return undefined;
  }
  return enabled === true ? { bits: bits ?? 4, skipLast: skipLast ?? true } : null;
}

/** The non-neutral, non-TurboQuant keys; undefined when a value has no
 *  canonical JSON form, null when there are no such keys. */
function collectUnknownSettings(
  settings: Record<string, unknown>,
): Record<string, unknown> | null | undefined {
  const unknown = createRecord();
  let unknownCount = 0;
  for (const [key, value] of Object.entries(settings)) {
    if (AFFECTING_KEYS.has(key) || NEUTRAL_KEYS.has(key) || value === undefined) {
      continue;
    }
    if (!hasCanonicalJson(value)) {
      return undefined;
    }
    unknown[key] = value;
    unknownCount += 1;
  }
  return unknownCount > 0 ? unknown : null;
}

function normalizeSettings(settings: unknown): NormalizedSettings | null {
  if (settings === undefined) {
    return { turboquant: null, unknown: null };
  }
  if (!isPlainObject(settings)) {
    return null;
  }
  const turboquant = normalizeTurboQuant(settings);
  const unknown = collectUnknownSettings(settings);
  if (turboquant === undefined || unknown === undefined) {
    return null;
  }
  return { turboquant, unknown };
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
    const result = createRecord();
    for (const [key, value] of entries) {
      result[key] = sortObjectKeys(value);
    }
    return result;
  }
  return obj;
}

/**
 * Derive the versioned cache identity, or the reason it cannot be derived.
 * Every field that is missing, mistyped or has no canonical form yields a
 * failure reason instead of an identity.
 */
export function deriveOmlxCacheIdentity(input: OmlxCacheIdentityInput): OmlxCacheIdentityResult {
  const modelId = normalizeNonEmptyString(input.modelId);
  if (modelId === null) {
    return { ok: false, reason: "ModelIdUnavailable" };
  }

  const artifact = normalizeArtifact(input.artifact);
  if (artifact === null) {
    return { ok: false, reason: "ArtifactIdentityUnavailable" };
  }

  const engineBuild = normalizeNonEmptyString(input.engineBuild);
  if (engineBuild === null) {
    return { ok: false, reason: "EngineBuildUnavailable" };
  }

  const cacheEpoch = normalizeCacheEpoch(input.cacheEpoch);
  if (cacheEpoch === null) {
    return { ok: false, reason: "CacheEpochInvalid" };
  }

  const settings = normalizeSettings(input.settings);
  if (settings === null) {
    return { ok: false, reason: "SettingsInvalid" };
  }

  // unknownSettings is present only when there are unknown keys, so an input
  // without any keeps the same identity it had before this field existed.
  const payload = {
    artifact,
    cacheEpoch,
    engineBuild,
    modelId,
    turboquant: settings.turboquant,
    ...(settings.unknown === null ? {} : { unknownSettings: settings.unknown }),
    v: OMLX_CACHE_IDENTITY_VERSION,
  };

  const canonical = canonicalString(payload);
  const hash = createHash("sha256").update(canonical).digest("hex");
  const identity = `omlx-cache-v1:${hash}`;

  return { ok: true, identity };
}

/**
 * Retain the cache only when the derived identity exactly matches the
 * previous one. A missing previous identity, a changed identity and every
 * derivation failure invalidate.
 */
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
