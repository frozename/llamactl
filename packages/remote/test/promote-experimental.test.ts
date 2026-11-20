// RED tests for frozename/llamactl#518 slice (a): the promote tRPC
// procedure and the ops-chat dispatch path refuse an experimental rel.
// Process env is isolated into a temp dir the way
// ops-chat-dispatch.test.ts does; on the base promote resolves and
// writes the preset row, so each case fails by assertion, never by
// import.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchOpsChatTool } from "../src/ops-chat/dispatch.js";
import { router } from "../src/router.js";
import { existsSync, mkdtempSync, rmSync } from "../src/safe-fs.js";

// The builtin GLM row staged experimental in packages/core/src/catalog.ts.
const EXP_REL = "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf";

// The refusal text every #518 preset-promotion surface must carry.
const REFUSAL =
  "is experimental (#518): experimental models are served only on an exact model pin and never as a preset default";

let runtimeDir = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-promote-exp-"));
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: runtimeDir,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LOCAL_AI_PRESET_OVERRIDES_FILE: join(runtimeDir, "preset-overrides.tsv"),
    LOCAL_AI_CUSTOM_CATALOG_FILE: join(runtimeDir, "curated-models.tsv"),
    // qualificationOverridesFileFor reads this from process.env; pin it
    // inside the sandbox so a real operator file can never leak in.
    LOCAL_AI_QUALIFICATION_OVERRIDES_FILE: join(runtimeDir, "qualification-overrides.tsv"),
  });
});

afterEach(() => {
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  rmSync(runtimeDir, { recursive: true, force: true });
});

const presetFile = (): string => join(runtimeDir, "preset-overrides.tsv");

describe("#518 promote procedure refuses experimental rels", () => {
  test("promote rejects an experimental rel with BAD_REQUEST and writes nothing", async () => {
    const caller = router.createCaller({});
    const promotePromise = caller.promote({
      profile: "macbook-pro-48g",
      preset: "best",
      rel: EXP_REL,
    });
    const err: unknown = await promotePromise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: "BAD_REQUEST" });
    expect(err instanceof Error ? err.message : String(err)).toContain(REFUSAL);
    expect(existsSync(presetFile())).toBe(false);
  });

  test("ops-chat dispatch resolves a structured BAD_REQUEST refusal and writes nothing", async () => {
    const caller = router.createCaller({});
    const res = await dispatchOpsChatTool(caller, {
      name: "llamactl.catalog.promote",
      arguments: { profile: "macbook-pro-48g", preset: "best", rel: EXP_REL },
      dryRun: false,
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("BAD_REQUEST");
    expect(res.error?.message).toContain(REFUSAL);
    expect(existsSync(presetFile())).toBe(false);
  });
});
