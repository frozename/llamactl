// Part of #517 — RED tests for the `ignoreModel` input of
// `exclusiveGroupLaunchRefusal`. A keep-alive supervisor records its row under
// its target, so that target's own row must not refuse its restart; every
// other occupying member of the same exclusive group still must. At the
// pinned base the input is ignored, so the ignoreModel calls refuse against
// the target itself. Stores are real SQLite files in temp dirs, seeded under
// the apply-profile fence along legal lifecycle edges.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../src/residency/apply-profile.js";
import { exclusiveGroupLaunchRefusal } from "../../src/residency/direct-lifecycle.js";
import { openResidencyOperationStore } from "../../src/residency/store.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

const GLM_REL = "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf";
const GROUP = "z13-large-gpu";
const NOW = 1_000_000_000;
const NONEXCLUSIVE_Z13 = [{ name: GROUP, exclusive: false }] as const;

let root = "";

const storePath = (): string => join(root, "operations.sqlite");

function seedPathTo(target: ResidencyState): ResidencyState[] {
  switch (target) {
    case "downloaded":
      return ["downloaded"];
    case "loading":
      return ["downloaded", "loading"];
    case "warming":
      return ["downloaded", "loading", "warming"];
    case "ready":
      return ["downloaded", "loading", "warming", "ready"];
    case "draining":
      return ["downloaded", "loading", "warming", "ready", "draining"];
    case "unloading":
      return ["downloaded", "loading", "warming", "ready", "draining", "unloading"];
    case "failed":
      return ["downloaded", "loading", "failed"];
    case "unavailable":
      throw new Error(`no seed path to residency state ${target}`);
  }
}

// The exclusivity override exists only to build the deliberate two-occupant
// ordering fixture. Group declarations are caller-supplied rather than
// persisted, so the code under test still reads the rows as exclusive.
function seedReady(model: string, opts: { overrideExclusivity?: boolean } = {}): void {
  const store = openResidencyOperationStore({ path: storePath() });
  try {
    const fence = store.claimOwnership({
      ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
      incarnation: "seed",
    });
    for (const to of seedPathTo("ready")) {
      const result = store.transitionResidencyState({
        fenceToken: fence.fenceToken,
        model,
        ...(to === "loading" ? { group: GROUP } : {}),
        to,
        expectedVersion: store.getResidencyState(model)?.version ?? 0,
        nowMs: NOW,
        ...(opts.overrideExclusivity === true ? { groups: NONEXCLUSIVE_Z13 } : {}),
      });
      expect(result.ok).toBe(true);
    }
  } finally {
    store.close();
  }
}

type RefusalInput = Parameters<typeof exclusiveGroupLaunchRefusal>[0];

function inputWithIgnore(ignoreModel: string): RefusalInput {
  return {
    id: GLM_REL,
    group: GROUP,
    storePath: storePath(),
    ignoreModel,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llamactl-own-row-refusal-"));
});

afterEach(() => {
  if (root !== "") {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

describe("#517 keep-alive own-row launch refusal", () => {
  // Kills: ignoreModel ignored. The control call in the same test keeps the
  // sandbox self-occupancy rule unchanged when no ignoreModel is supplied.
  test("O1: the target's own ready row is ignored only when ignoreModel names it", () => {
    seedReady(GLM_REL);
    expect(exclusiveGroupLaunchRefusal(inputWithIgnore(GLM_REL))).toBeNull();
    expect(exclusiveGroupLaunchRefusal({ id: GLM_REL, group: GROUP, storePath: storePath() })).toBe(
      `residency lifecycle refused ${GLM_REL} downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by ${GLM_REL} in state ready`,
    );
  });

  // Kills: ignoreModel ignoring the whole group. Filtering must remove only
  // the target row, leaving the lowest remaining occupant to name in the
  // deterministic refusal.
  test("O2: a different ready peer still refuses and names that peer", () => {
    seedReady(GLM_REL);
    seedReady("qwen-prod", { overrideExclusivity: true });
    expect(exclusiveGroupLaunchRefusal(inputWithIgnore(GLM_REL))).toBe(
      `residency lifecycle refused ${GLM_REL} downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by qwen-prod in state ready`,
    );
  });
});
