// #282 DF-09: per-model oMLX settings over the model_settings.json document,
// following the jundot/omlx omlx/model_settings.py file format at
// feec0a0e4eda6ad5c227a5f9ee216c6fb6d2fe9b. Pure module: no IO, no engine
// calls, nothing imported that touches the filesystem.
//
// Parsing deliberately fails closed: upstream _load defaults version and
// models and skips bad entries, but llamactl refuses to rewrite a file it
// cannot fully understand.

export const OMLX_MODEL_SETTINGS_REVISION = "feec0a0e4eda6ad5c227a5f9ee216c6fb6d2fe9b";

export const OMLX_MODEL_SETTINGS_FILE = "model_settings.json";

export const OMLX_MODEL_SETTINGS_VERSION = 1;

/**
 * Managed keys in upstream ModelSettings dataclass order. Exclusions, each
 * deliberate:
 * - dflash_* belongs to hostedModels[].dflash (buildDflashModelSettings owns it);
 * - ttl_seconds and is_pinned would bypass llamactl residency;
 * - model_alias changes the served id that matchHostedModel relies on;
 * - trust_remote_code is a security opt-in;
 * - vlm_mtp_*, qwen35_ane_*, guided_grammar* and the UI metadata keys are
 *   unmanaged: preserved verbatim across merges, never written from a manifest.
 */
export const OMLX_MANAGED_MODEL_SETTINGS_KEYS = [
  "max_context_window",
  "max_tokens",
  "chat_template_kwargs",
  "forced_ct_kwargs",
  "enable_thinking",
  "preserve_thinking",
  "thinking_budget_enabled",
  "thinking_budget_tokens",
  "reasoning_parser",
  "turboquant_kv_enabled",
  "turboquant_kv_bits",
  "turboquant_skip_last",
  "specprefill_enabled",
  "specprefill_draft_model",
  "specprefill_keep_pct",
  "specprefill_threshold",
  "mtp_enabled",
  "mtp_num_draft_tokens",
] as const;

export interface OmlxManagedModelSettings {
  max_context_window?: number;
  max_tokens?: number;
  chat_template_kwargs?: Record<string, unknown>;
  forced_ct_kwargs?: string[];
  enable_thinking?: boolean;
  preserve_thinking?: boolean;
  thinking_budget_enabled?: boolean;
  thinking_budget_tokens?: number;
  reasoning_parser?: string;
  turboquant_kv_enabled?: boolean;
  turboquant_kv_bits?: 2 | 2.5 | 3 | 3.5 | 4 | 6 | 8;
  turboquant_skip_last?: boolean;
  specprefill_enabled?: boolean;
  specprefill_draft_model?: string;
  specprefill_keep_pct?: number;
  specprefill_threshold?: number;
  mtp_enabled?: boolean;
  mtp_num_draft_tokens?: number;
}

export type OmlxModelSettingsDocument = {
  version: number;
  models: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

export type OmlxModelSettingsParseResult =
  | { ok: true; document: OmlxModelSettingsDocument; canonical: boolean }
  | {
      ok: false;
      reason:
        | "InvalidJson"
        | "NotAnObject"
        | "UnsupportedVersion"
        | "MalformedModels"
        | "MalformedModelEntry";
      detail?: string;
    };

export type OmlxModelSettingsMergeResult =
  | { ok: true; document: OmlxModelSettingsDocument }
  | { ok: false; reason: "SpeculativeConflict"; conflicts: string[] };

/**
 * Upstream _save is json.dump(indent=2, ensure_ascii=False) with no trailing
 * newline. JSON.stringify is the byte-exact equivalent (non-ASCII is emitted
 * raw), and rawJSON values round-trip their original number lexemes.
 */
export function renderOmlxModelSettings(document: OmlxModelSettingsDocument): string {
  return JSON.stringify(document, null, 2);
}

const MANAGED_MODEL_SETTINGS_KEY_SET: ReadonlySet<string> = new Set(
  OMLX_MANAGED_MODEL_SETTINGS_KEYS,
);

type RawJsonFactory = (text: string) => unknown;

// The repo compiles against lib ES2023, which has no JSON.rawJSON declaration;
// reach it through a narrow local cast (every runtime the agent ships on has it).
const createRawJson: RawJsonFactory | undefined = (JSON as unknown as { rawJSON?: RawJsonFactory })
  .rawJSON;

type ReviverContext = { source?: string };

// A number whose source lexeme differs from JSON.stringify's canonical form
// (2.50, 0.0, 1e3) is kept as rawJSON so a rewrite is byte-identical. Without
// this, "0.0" would render back as "0" and the file would churn.
function preserveNumberLexeme(_key: string, value: unknown, context?: ReviverContext): unknown {
  const source = context?.source;
  if (
    typeof value === "number" &&
    source !== undefined &&
    createRawJson !== undefined &&
    JSON.stringify(value) !== source
  ) {
    return createRawJson(source);
  }
  return value;
}

// A rawJSON box is typeof "object" but is not a plain object, so the prototype
// check below rejects it wherever an object is required.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseOmlxModelSettings(text: string): OmlxModelSettingsParseResult {
  let root: unknown;
  try {
    root = JSON.parse(text, preserveNumberLexeme);
  } catch (error) {
    return { ok: false, reason: "InvalidJson", detail: errorMessage(error) };
  }
  if (!isPlainObject(root)) {
    return { ok: false, reason: "NotAnObject" };
  }
  if (root["version"] !== OMLX_MODEL_SETTINGS_VERSION) {
    return {
      ok: false,
      reason: "UnsupportedVersion",
      detail: `version must be ${String(OMLX_MODEL_SETTINGS_VERSION)}`,
    };
  }
  const models = root["models"];
  if (!isPlainObject(models)) {
    return { ok: false, reason: "MalformedModels" };
  }
  const validated: Record<string, Record<string, unknown>> = {};
  for (const [modelId, entry] of Object.entries(models)) {
    if (!isPlainObject(entry)) {
      return { ok: false, reason: "MalformedModelEntry", detail: `models.${modelId}` };
    }
    validated[modelId] = entry;
  }
  const document: OmlxModelSettingsDocument = {
    ...root,
    version: OMLX_MODEL_SETTINGS_VERSION,
    models: validated,
  };
  return { ok: true, document, canonical: renderOmlxModelSettings(document) === text };
}

// Mirrors ModelSettings.__post_init__ for the flags llamactl can reason about.
// The vlm_mtp logits-processor conflicts are left out on purpose: upstream
// _load resolves those itself (resolve_vlm_mtp_conflicts) instead of dropping
// the entry, so they are not document-level corruption here.
export function omlxModelSettingsConflicts(entry: Record<string, unknown>): string[] {
  const conflicts: string[] = [];
  if (entry["mtp_enabled"] === true && entry["dflash_enabled"] === true) {
    conflicts.push("mtp_enabled+dflash_enabled");
  }
  if (entry["vlm_mtp_enabled"] === true) {
    for (const key of [
      "dflash_enabled",
      "specprefill_enabled",
      "mtp_enabled",
      "turboquant_kv_enabled",
    ] as const) {
      if (entry[key] === true) {
        conflicts.push(`vlm_mtp_enabled+${key}`);
      }
    }
  }
  return conflicts;
}

function mergeModelEntry(
  existingEntry: Record<string, unknown>,
  desired: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(existingEntry)) {
    const desiredValue = desired[key];
    if (!MANAGED_MODEL_SETTINGS_KEY_SET.has(key)) {
      next[key] = existingEntry[key];
    } else if (desiredValue !== undefined) {
      next[key] = desiredValue;
    }
  }
  for (const key of OMLX_MANAGED_MODEL_SETTINGS_KEYS) {
    const desiredValue = desired[key];
    if (desiredValue !== undefined) {
      next[key] = desiredValue;
    }
  }
  return next;
}

/**
 * Merge one model's desired managed settings into an existing document without
 * mutating it. Top-level keys keep their order; other model entries are left
 * as-is; unmanaged keys in the target entry (including rawJSON values) are
 * preserved verbatim. Managed keys absent from desired are dropped, and the
 * remaining ones are appended in OMLX_MANAGED_MODEL_SETTINGS_KEYS order.
 *
 * BINDING for the load-path wiring: it must reconcile the dflash_* keys from
 * hostedModels[].dflash (for example set dflash_enabled false when dflash is
 * absent or disabled) before calling merge, and it must surface
 * SpeculativeConflict as a load failure, never as a silent skip.
 */
export function mergeOmlxModelSettings(
  existing: OmlxModelSettingsDocument | null,
  modelId: string,
  desired: Record<string, unknown>,
): OmlxModelSettingsMergeResult {
  const base: OmlxModelSettingsDocument = existing ?? {
    version: OMLX_MODEL_SETTINGS_VERSION,
    models: {},
  };
  const models: Record<string, Record<string, unknown>> = {};
  let merged: Record<string, unknown> | undefined;
  for (const [id, entry] of Object.entries(base.models)) {
    if (id === modelId) {
      merged = mergeModelEntry(entry, desired);
      models[id] = merged;
    } else {
      models[id] = entry;
    }
  }
  if (merged === undefined) {
    merged = mergeModelEntry({}, desired);
    models[modelId] = merged;
  }
  // Never return a document oMLX would drop on load: the check runs on the
  // merged entry so a preserved unmanaged dflash_enabled/vlm_mtp_enabled flag
  // trips it even when desired alone looks consistent.
  const conflicts = omlxModelSettingsConflicts(merged);
  if (conflicts.length > 0) {
    return { ok: false, reason: "SpeculativeConflict", conflicts };
  }
  return { ok: true, document: { ...base, models } };
}
