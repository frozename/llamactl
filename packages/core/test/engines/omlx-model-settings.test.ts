import { describe, expect, test } from "bun:test";

import { OMLX_NATIVE_STATUS_REVISION } from "../../src/engines/omlx.js";

// #282 DF-09: per-model oMLX settings with a byte-exact model_settings.json
// round trip. The module does not exist at the pinned base; the specifier is
// widened to `string` so tsc cannot resolve it — a literal specifier would be
// a resolution error, not an assertion failure.
const MODULE_SPEC = "../../src/engines/omlx-model-settings.js" as string;

type OmlxModelSettingsDocument = {
  version: number;
  models: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

type ParseOk = {
  ok: true;
  document: OmlxModelSettingsDocument;
  canonical: boolean;
};

type ParseFailure = { ok: false; reason: string };
type ParseResult = ParseOk | ParseFailure;

type MergeOk = { ok: true; document: OmlxModelSettingsDocument };
type MergeFailure = { ok: false; reason: "SpeculativeConflict"; conflicts: string[] };
type MergeResult = MergeOk | MergeFailure;

type OmlxModelSettingsModule = {
  OMLX_MODEL_SETTINGS_REVISION: string;
  OMLX_MANAGED_MODEL_SETTINGS_KEYS: readonly string[];
  renderOmlxModelSettings(document: OmlxModelSettingsDocument): string;
  parseOmlxModelSettings(text: string): ParseResult;
  mergeOmlxModelSettings(
    document: OmlxModelSettingsDocument | null,
    modelId: string,
    desired: Record<string, unknown>,
  ): MergeResult;
  omlxModelSettingsConflicts(settings: Record<string, unknown>): string[];
};

// Fixture in the layout of oMLX feec0a0e ModelSettingsManager._save —
// json.dump(indent=2, ensure_ascii=False) with no trailing newline — but it is
// NOT literal _save output: it carries hand-added unknown keys at both levels,
// the non-canonical lexeme 2.50, and partial entries, to exercise preservation.
const OMLX_FIXTURE = `{
  "version": 1,
  "models": {
    "Qwen3-8B-MLX-4bit": {
      "max_context_window": 40960,
      "force_sampling": false,
      "enable_thinking": true,
      "turboquant_kv_bits": 4,
      "turboquant_skip_last": true,
      "qwen35_ane_prefill_fraction": 0.53,
      "qwen35_ane_prefill_cpu_down_fraction": 0.0,
      "mtp_enabled": false,
      "is_pinned": false,
      "dflash_in_memory_cache_max_bytes": 8589934592,
      "future_knob": {
        "a": [
          1,
          2.50
        ]
      },
      "display_name": "Qwén 8B"
    },
    "gemma-4-e4b": {
      "temperature": 0.7,
      "is_hidden": false
    }
  },
  "x_upstream_note": "kept"
}`;

async function load(): Promise<OmlxModelSettingsModule | null> {
  try {
    return (await import(MODULE_SPEC)) as OmlxModelSettingsModule;
  } catch {
    return null;
  }
}

function parseDocument(mod: OmlxModelSettingsModule, text: string): OmlxModelSettingsDocument {
  const parsed = mod.parseOmlxModelSettings(text);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    throw new Error(`parse failed: ${parsed.reason}`);
  }
  return parsed.document;
}

function mergeDocument(
  mod: OmlxModelSettingsModule,
  document: OmlxModelSettingsDocument | null,
  modelId: string,
  desired: Record<string, unknown>,
): OmlxModelSettingsDocument {
  const merged = mod.mergeOmlxModelSettings(document, modelId, desired);
  expect(merged.ok).toBe(true);
  if (!merged.ok) {
    throw new Error(`merge failed: ${merged.reason}`);
  }
  return merged.document;
}

describe("#282 DF-09 oMLX model settings document contract", () => {
  test("C1 render emits 2-space indent, insertion order, no trailing newline", async () => {
    const m = await load();
    expect(m, "omlx-model-settings module missing").not.toBeNull();
    if (m === null) {
      throw new Error("unreachable");
    }

    // Kills: appending "\n", sorting keys, indent 4.
    const input: OmlxModelSettingsDocument = {
      version: 1,
      models: {
        b: { z: 1 },
        a: { y: [1, { k: "é" }] },
      },
    };
    const expected = `{
  "version": 1,
  "models": {
    "b": {
      "z": 1
    },
    "a": {
      "y": [
        1,
        {
          "k": "é"
        }
      ]
    }
  }
}`;
    expect(m.renderOmlxModelSettings(input)).toBe(expected);
    expect(m.renderOmlxModelSettings(input)).toBe(m.renderOmlxModelSettings(input));
  });

  test("C2 parse(render(x)) deep-equals x", async () => {
    const m = await load();
    expect(m, "omlx-model-settings module missing").not.toBeNull();
    if (m === null) {
      throw new Error("unreachable");
    }

    // Kills: a parse that strips unknown keys or rebuilds entries from a
    // known-key list.
    const docs: OmlxModelSettingsDocument[] = [
      { version: 1, models: {} },
      {
        version: 1,
        models: {
          "m-nested": {
            chat_template_kwargs: { enable_thinking: false, nested: { a: [1, "x", null] } },
            forced_ct_kwargs: ["enable_thinking"],
          },
        },
      },
      {
        version: 1,
        models: {
          "m-arrays": { future_list: [1, 2.5, "three", false, null, { deep: [true] }] },
        },
        x_top: { anything: [1, { two: 2 }] },
      },
      {
        version: 1,
        models: {
          "m-uni": { display_name: "Qwén 8B", note: "café ☕ fin" },
        },
      },
    ];
    for (const doc of docs) {
      const parsed = m.parseOmlxModelSettings(m.renderOmlxModelSettings(doc));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        throw new Error(`round-trip parse failed: ${parsed.reason}`);
      }
      expect(parsed.document).toEqual(doc);
    }
  });

  test("C3 fixture parses canonical and renders byte-exact", async () => {
    const m = await load();
    expect(m, "omlx-model-settings module missing").not.toBeNull();
    if (m === null) {
      throw new Error("unreachable");
    }

    // Kills: removing the context.source / JSON.rawJSON number-preserving
    // reviver — 0.0 would render as 0 and 2.50 as 2.5.
    const parsed = m.parseOmlxModelSettings(OMLX_FIXTURE);
    expect(parsed).toMatchObject({ ok: true, canonical: true });
    if (!parsed.ok) {
      throw new Error(`fixture parse failed: ${parsed.reason}`);
    }
    expect(m.renderOmlxModelSettings(parsed.document)).toBe(OMLX_FIXTURE);
  });

  test("C4 non-canonical inputs parse ok with canonical:false", async () => {
    const m = await load();
    expect(m, "omlx-model-settings module missing").not.toBeNull();
    if (m === null) {
      throw new Error("unreachable");
    }

    // Kills: hard-coding canonical:true.
    const trailingNewline = m.parseOmlxModelSettings(`${OMLX_FIXTURE}\n`);
    expect(trailingNewline).toMatchObject({ ok: true, canonical: false });

    // JS reorders integer-like keys ahead of string keys, so "10" renders
    // before "b" even though the source lists "b" first.
    const reorderedKeys = m.parseOmlxModelSettings(
      '{"version":1,"models":{"b":{"x":1},"10":{"y":2}}}',
    );
    expect(reorderedKeys).toMatchObject({ ok: true, canonical: false });
  });

  test("C5 fail-closed rejections", async () => {
    const m = await load();
    expect(m, "omlx-model-settings module missing").not.toBeNull();
    if (m === null) {
      throw new Error("unreachable");
    }

    // Deliberately diverges from upstream _load, which defaults version and
    // models and skips bad entries: llamactl refuses to rewrite a file it
    // cannot fully understand.
    // Kills: accepting version 2, or defaulting a missing models to {}.
    const cases: [string, string][] = [
      ["{", "InvalidJson"],
      ["[]", "NotAnObject"],
      ['{"version":2,"models":{}}', "UnsupportedVersion"],
      ['{"models":{}}', "UnsupportedVersion"],
      ['{"version":1,"models":[]}', "MalformedModels"],
      ['{"version":1}', "MalformedModels"],
      ['{"version":1,"models":{"a":"x"}}', "MalformedModelEntry"],
    ];
    for (const [text, reason] of cases) {
      expect(m.parseOmlxModelSettings(text)).toMatchObject({ ok: false, reason });
    }
  });

  test("C6 merge into an empty document emits upstream field order", async () => {
    const m = await load();
    expect(m, "omlx-model-settings module missing").not.toBeNull();
    if (m === null) {
      throw new Error("unreachable");
    }

    // Kills: emitting keys in desired-object insertion order instead of
    // upstream field order — mtp_enabled leads the desired literal but sorts
    // last in the managed set.
    const document = mergeDocument(m, null, "Qwen3-8B-MLX-4bit", {
      mtp_enabled: true,
      max_context_window: 40960,
      enable_thinking: false,
    });
    expect(m.renderOmlxModelSettings(document)).toBe(`{
  "version": 1,
  "models": {
    "Qwen3-8B-MLX-4bit": {
      "max_context_window": 40960,
      "enable_thinking": false,
      "mtp_enabled": true
    }
  }
}`);
  });

  test("C7 merge preserves unknown and unmanaged keys byte-exact", async () => {
    const m = await load();
    expect(m, "omlx-model-settings module missing").not.toBeNull();
    if (m === null) {
      throw new Error("unreachable");
    }

    // Kills: replacing the whole entry with desired, and keeping stale
    // managed keys.
    const document = mergeDocument(m, parseDocument(m, OMLX_FIXTURE), "Qwen3-8B-MLX-4bit", {
      max_context_window: 32768,
      preserve_thinking: true,
    });
    expect(m.renderOmlxModelSettings(document)).toBe(`{
  "version": 1,
  "models": {
    "Qwen3-8B-MLX-4bit": {
      "max_context_window": 32768,
      "force_sampling": false,
      "qwen35_ane_prefill_fraction": 0.53,
      "qwen35_ane_prefill_cpu_down_fraction": 0.0,
      "is_pinned": false,
      "dflash_in_memory_cache_max_bytes": 8589934592,
      "future_knob": {
        "a": [
          1,
          2.50
        ]
      },
      "display_name": "Qwén 8B",
      "preserve_thinking": true
    },
    "gemma-4-e4b": {
      "temperature": 0.7,
      "is_hidden": false
    }
  },
  "x_upstream_note": "kept"
}`);
  });

  test("C8 merge is idempotent and does not mutate its input", async () => {
    const m = await load();
    expect(m, "omlx-model-settings module missing").not.toBeNull();
    if (m === null) {
      throw new Error("unreachable");
    }

    // Kills: in-place mutation of existing.models[id].
    const doc = parseDocument(m, OMLX_FIXTURE);
    const before = m.renderOmlxModelSettings(doc);
    const desired = { max_context_window: 32768, preserve_thinking: true };

    const first = mergeDocument(m, doc, "Qwen3-8B-MLX-4bit", desired);
    expect(m.renderOmlxModelSettings(doc)).toBe(before);

    const reparsed = parseDocument(m, m.renderOmlxModelSettings(first));
    const second = mergeDocument(m, reparsed, "Qwen3-8B-MLX-4bit", desired);
    expect(m.renderOmlxModelSettings(second)).toBe(m.renderOmlxModelSettings(first));

    const appended = mergeDocument(m, doc, "brand-new-9", { max_context_window: 8192 });
    const appendedParsed = parseDocument(m, m.renderOmlxModelSettings(appended));
    expect(Object.keys(appendedParsed.models)).toEqual([
      "Qwen3-8B-MLX-4bit",
      "gemma-4-e4b",
      "brand-new-9",
    ]);
  });

  test("C9 contract constants", async () => {
    const m = await load();
    expect(m, "omlx-model-settings module missing").not.toBeNull();
    if (m === null) {
      throw new Error("unreachable");
    }

    // Kills: adding ttl_seconds or a dflash key to the managed set.
    expect(m.OMLX_MODEL_SETTINGS_REVISION).toBe(OMLX_NATIVE_STATUS_REVISION);
    expect(m.OMLX_MANAGED_MODEL_SETTINGS_KEYS).toEqual([
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
    ]);
  });

  test("C10 speculative-decoding exclusivity mirrors upstream __post_init__", async () => {
    const m = await load();
    expect(m, "omlx-model-settings module missing").not.toBeNull();
    if (m === null) {
      throw new Error("unreachable");
    }

    // Kills: deleting the post-merge conflict check in
    // mergeOmlxModelSettings, and a check that looks only at desired rather
    // than the merged entry.
    expect(m.omlxModelSettingsConflicts({ mtp_enabled: true, dflash_enabled: true })).toEqual([
      "mtp_enabled+dflash_enabled",
    ]);
    expect(
      m.omlxModelSettingsConflicts({
        vlm_mtp_enabled: true,
        dflash_enabled: true,
        specprefill_enabled: true,
        mtp_enabled: true,
        turboquant_kv_enabled: true,
      }),
    ).toEqual([
      "mtp_enabled+dflash_enabled",
      "vlm_mtp_enabled+dflash_enabled",
      "vlm_mtp_enabled+specprefill_enabled",
      "vlm_mtp_enabled+mtp_enabled",
      "vlm_mtp_enabled+turboquant_kv_enabled",
    ]);
    expect(m.omlxModelSettingsConflicts({ mtp_enabled: true, dflash_enabled: false })).toEqual([]);
    expect(m.omlxModelSettingsConflicts({ vlm_mtp_enabled: false, mtp_enabled: true })).toEqual([]);

    // A stale DFlash file left by buildDflashModelSettings: dflash_enabled is
    // unmanaged, so it survives the merge and must trip the post-merge check.
    const dflashVariant = OMLX_FIXTURE.replace(
      '      "display_name": "Qwén 8B"\n    },',
      '      "display_name": "Qwén 8B",\n      "dflash_enabled": true\n    },',
    );
    expect(dflashVariant).not.toBe(OMLX_FIXTURE);
    const refused = m.mergeOmlxModelSettings(parseDocument(m, dflashVariant), "Qwen3-8B-MLX-4bit", {
      mtp_enabled: true,
    });
    expect(refused).toEqual({
      ok: false,
      reason: "SpeculativeConflict",
      conflicts: ["mtp_enabled+dflash_enabled"],
    });

    const untouched = mergeDocument(m, parseDocument(m, dflashVariant), "Qwen3-8B-MLX-4bit", {
      max_context_window: 4096,
    });
    expect(m.renderOmlxModelSettings(untouched)).toContain('"dflash_enabled": true');

    const vlmVariant = OMLX_FIXTURE.replace(
      '      "display_name": "Qwén 8B"\n    },',
      '      "display_name": "Qwén 8B",\n      "vlm_mtp_enabled": true\n    },',
    );
    expect(vlmVariant).not.toBe(OMLX_FIXTURE);
    const vlmRefused = m.mergeOmlxModelSettings(parseDocument(m, vlmVariant), "Qwen3-8B-MLX-4bit", {
      turboquant_kv_enabled: true,
    });
    expect(vlmRefused).toEqual({
      ok: false,
      reason: "SpeculativeConflict",
      conflicts: ["vlm_mtp_enabled+turboquant_kv_enabled"],
    });
  });
});
