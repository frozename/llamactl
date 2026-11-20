// #519: the ranking status read-out rendered by `llamactl residency status`.
// renderResidencyStatus gains a pushRankingLines block between the switch
// gates and the leases section: the available header plus resident and
// drain-charged lines, one-line disabled and unavailable reports, and
// nothing at all for a payload without the section (an older agent). At
// the pinned base the renderer has no ranking block, so every case except
// the no-section guard fails BY ASSERTION — never by an import or type
// error.
import { describe, expect, test } from "bun:test";

import * as residencyMod from "../src/commands/residency.js";

// The ranking section the renderer reads, described structurally so the
// file typechecks on both sides of the fix.
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
    };

type RenderInput = Parameters<typeof residencyMod.renderResidencyStatus>[0];

// Minimal status payload modelled on the fixtures in residency.test.ts:
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
  return residencyMod.renderResidencyStatus(payload as RenderInput);
}

function statusWith(ranking: RankingSection | undefined): object {
  return ranking === undefined ? { ...BASE_STATUS } : { ...BASE_STATUS, ranking };
}

describe("llamactl residency status ranking lines (#519)", () => {
  test("C1: available ranking prints the header, resident and drain lines in order", () => {
    // Kills: pushRankingLines missing or misordered — the Ranking block
    // must sit after the Switch gates block and before Leases.
    const out = renderStatus(
      statusWith({
        status: "available",
        scope: "serving-process",
        advisory: true,
        residentPreference: 2,
        coldLoadPenaltyMs: 500,
        resident: ["a", "b"],
        drainCharged: ["c"],
      }),
    );
    expect(out).toContain(
      "Ranking: resident preference 2, cold-load penalty 500ms (advisory; scope: serving-process)",
    );
    expect(out).toContain("  resident: a, b");
    expect(out).toContain("  drain charged: c");
    const switchIdx = out.indexOf("Switch gates:");
    const rankingIdx = out.indexOf("Ranking:");
    const leasesIdx = out.indexOf("Leases:");
    expect(switchIdx).toBeGreaterThanOrEqual(0);
    expect(rankingIdx).toBeGreaterThan(switchIdx);
    expect(leasesIdx).toBeGreaterThan(rankingIdx);
  });

  test("C2: empty resident and drain lists print resident: none and no drain line", () => {
    // Kills: an empty resident list rendering as a blank or missing line,
    // or an empty drain list still printing a drain charged line.
    const out = renderStatus(
      statusWith({
        status: "available",
        scope: "serving-process",
        advisory: true,
        residentPreference: 2,
        coldLoadPenaltyMs: 500,
        resident: [],
        drainCharged: [],
      }),
    );
    expect(out).toContain("  resident: none");
    expect(out).not.toContain("drain charged");
  });

  test("C3: a disabled section prints the disabled line", () => {
    // Kills: the disabled state rendering as unavailable or available.
    const out = renderStatus(statusWith({ status: "disabled", scope: "serving-process" }));
    expect(out).toContain("Ranking: disabled (scope: serving-process)");
  });

  test("C4: each unavailable reason prints its detail line", () => {
    // Kills: the reason map missing an entry or printing the raw reason
    // token instead of the operator-facing detail.
    const cases: [reason: string, line: string][] = [
      ["NotServingNode", "Ranking: unavailable (not the serving node; scope: serving-process)"],
      ["UnifiedProxyOff", "Ranking: unavailable (unified proxy off; scope: serving-process)"],
      ["StoreAbsent", "Ranking: unavailable (no residency store; scope: serving-process)"],
      ["StoreUnreadable", "Ranking: unavailable (store unreadable; scope: serving-process)"],
      [
        "LifecycleUnreadable",
        "Ranking: unavailable (lifecycle rows unreadable; scope: serving-process)",
      ],
    ];
    for (const [reason, line] of cases) {
      const out = renderStatus(
        statusWith({ status: "unavailable", scope: "serving-process", reason }),
      );
      expect(out).toContain(line);
    }
  });

  test("C5: a payload without the ranking key prints no Ranking line", () => {
    // Guard: passes on the base too — an older agent's payload has no
    // ranking section and must render unchanged.
    const out = renderStatus(statusWith(undefined));
    expect(out).not.toContain("Ranking:");
  });
});
