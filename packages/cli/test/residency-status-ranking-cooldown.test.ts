// #519: the ranking status read-out's cooldown and tier lines rendered by
// `llamactl residency status`. pushRankingLines gains three lines after
// `resident:` — `cooldown charged: <model> for <t>` per active charge,
// `drain tier: <workloads>` and `degraded tier: <workloads>` — driven by
// the new cooldownCharged/drainTier/degradedTier fields and nowMs. At the
// pinned base the renderer has no such lines, so the non-guard cases fail
// BY ASSERTION — never by an import or type error.
import { describe, expect, test } from "bun:test";

import * as residencyMod from "../src/commands/residency.js";

// The ranking section the renderer reads, described structurally so the
// file typechecks on both sides of the fix. The cooldown/tier fields are
// optional: an older agent's payload does not carry them.
type RankingSection =
  | { status: "disabled"; scope: "serving-process" }
  | { status: "unavailable"; scope: "serving-process"; reason: string }
  | {
      status: "available";
      scope: "serving-process";
      advisory: true;
      residentPreference: number;
      coldLoadPenaltyMs: number;
      resident: string[];
      drainCharged: string[];
      cooldownCharged?: { model: string; untilMs: number }[];
      drainTier?: string[];
      degradedTier?: string[];
    };

type RenderInput = Parameters<typeof residencyMod.renderResidencyStatus>[0];

const NOW_MS = 1_000_000;

// Minimal status payload modelled on residency-status-ranking.test.ts:
// enough sections for the renderer to reach the ranking block — a
// disabled switchGates section so ordering against it is observable, and
// an unavailable leases section.
const BASE_STATUS = {
  node: "gpu1",
  nodeRun: { present: true },
  policy: { present: true, residency: {} },
  budget: { memoryGiB: 24, source: "noderun" },
  store: {
    path: "/tmp/rs/operations.sqlite",
    present: true,
    nonterminalCount: 0,
    nonterminal: [],
    scope: "serving-process",
  },
  switchGates: { status: "disabled", scope: "serving-process" },
  leases: { status: "unavailable", scope: "serving-process" },
};

function renderStatus(payload: object): string {
  return residencyMod.renderResidencyStatus(payload as RenderInput, NOW_MS);
}

function statusWith(ranking: RankingSection | undefined): object {
  return ranking === undefined ? { ...BASE_STATUS } : { ...BASE_STATUS, ranking };
}

describe("llamactl residency status ranking cooldown lines (#519)", () => {
  test("CC1: cooldown, drain-tier and degraded-tier lines print after resident", () => {
    // Kills: pushRankingLines ignoring the new fields, or not receiving
    // nowMs (the `for <t>` remaining-time rendering needs it).
    const out = renderStatus(
      statusWith({
        status: "available",
        scope: "serving-process",
        advisory: true,
        residentPreference: 1,
        coldLoadPenaltyMs: 0,
        resident: [],
        drainCharged: [],
        cooldownCharged: [{ model: "c", untilMs: NOW_MS + 50_000 }],
        drainTier: ["e"],
        degradedTier: ["d"],
      }),
    );
    expect(out).toContain(
      "  resident: none\n  cooldown charged: c for 50s\n  drain tier: e\n  degraded tier: d",
    );
  });

  test("CC2: empty cooldown and tier lists print none of the new lines", () => {
    // Guard: passes on base too — empty lists must not print the new
    // lines while resident and drain-charged still render normally.
    const out = renderStatus(
      statusWith({
        status: "available",
        scope: "serving-process",
        advisory: true,
        residentPreference: 1,
        coldLoadPenaltyMs: 0,
        resident: ["a"],
        drainCharged: ["c"],
        cooldownCharged: [],
        drainTier: [],
        degradedTier: [],
      }),
    );
    expect(out).toContain("  resident: a");
    expect(out).toContain("  drain charged: c");
    expect(out).not.toContain("cooldown charged");
    expect(out).not.toContain("drain tier");
    expect(out).not.toContain("degraded tier");
  });

  test("CC3: an older agent's section without the new keys renders unchanged", () => {
    // Guard: passes on base too — the renderer must tolerate a payload
    // that predates cooldownCharged/drainTier/degradedTier.
    const out = renderStatus(
      statusWith({
        status: "available",
        scope: "serving-process",
        advisory: true,
        residentPreference: 1,
        coldLoadPenaltyMs: 0,
        resident: ["a"],
        drainCharged: ["c"],
      }),
    );
    expect(out).toContain("  resident: a");
    expect(out).not.toContain("cooldown charged");
    expect(out).not.toContain("drain tier");
    expect(out).not.toContain("degraded tier");
  });
});
