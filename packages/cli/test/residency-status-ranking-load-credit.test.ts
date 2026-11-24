// #519: the ranking status read-out's load-credit line rendered by
// `llamactl residency status`. pushRankingLines gains one line between
// `drain charged:` and `cooldown charged:` —
// `load credited: <model> ready in <t>` per entry, entries joined by
// ", " — driven by the new loadCredited field and nowMs, printed only
// when the list is non-empty. At the pinned base the renderer has no
// such line, so the case fails BY ASSERTION — never by an import or
// type error.
import { describe, expect, test } from "bun:test";

import * as residencyMod from "../src/commands/residency.js";

// The ranking section the renderer reads, described structurally so
// the file typechecks on both sides of the fix. loadCredited is
// optional: an older agent's payload does not carry it.
type LoadCredit = { model: string; expectedReadyAtMs: number };

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
      loadCredited?: LoadCredit[];
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

const AVAILABLE_RANKING: Extract<RankingSection, { status: "available" }> = {
  status: "available",
  scope: "serving-process",
  advisory: true,
  residentPreference: 1,
  coldLoadPenaltyMs: 0,
  resident: [],
  drainCharged: ["x"],
  cooldownCharged: [{ model: "c", untilMs: NOW_MS + 50_000 }],
  drainTier: [],
  degradedTier: [],
};

describe("llamactl residency status ranking load-credit line (#519)", () => {
  test("CL1: the load credited line prints between drain and cooldown charged", () => {
    // Kills: the renderer ignoring loadCredited, printing the line in
    // the wrong position, or printing it for an empty or missing list.
    const out = renderStatus(
      statusWith({
        ...AVAILABLE_RANKING,
        loadCredited: [
          { model: "a", expectedReadyAtMs: NOW_MS + 40_000 },
          { model: "b", expectedReadyAtMs: NOW_MS + 1_500 },
        ],
      }),
    );
    expect(out).toContain(
      "  drain charged: x\n  load credited: a ready in 40s, b ready in 1s\n  cooldown charged: c for 50s",
    );

    const missing = renderStatus(statusWith(AVAILABLE_RANKING));
    expect(missing).not.toContain("load credited");

    const empty = renderStatus(statusWith({ ...AVAILABLE_RANKING, loadCredited: [] }));
    expect(empty).not.toContain("load credited");
  });
});
