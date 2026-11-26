// #520: the idleEviction status renderer must surface session protection. A
// row held by active sessions prints the SessionsActive ids, an unknown session
// probe prints SessionsUnknown, and rows without sessionHold keep their #519
// rendering. At the pinned base pushIdleEvictionLines never reads sessionHold,
// so R5 and R6 fail BY ASSERTION — never by an import or type error.
import { describe, expect, test } from "bun:test";

import { renderResidencyStatus } from "../src/commands/residency.js";

type RenderInput = Parameters<typeof renderResidencyStatus>[0];

const NOW_MS = 1_000_000;

// Minimal status payload modelled on the idle-eviction fixtures in
// residency.test.ts: enough sections for the renderer to reach the idle block.
const BASE_STATUS = {
  node: "n1",
  nodeRun: { present: true },
  policy: { present: true, residency: { idleEvictSeconds: 60 } },
  budget: { memoryGiB: 24, source: "noderun" },
  store: {
    path: "/tmp/residency/operations.sqlite",
    present: true,
    nonterminalCount: 0,
    nonterminal: [],
    scope: "serving-process",
  },
  leases: { status: "unavailable", scope: "serving-process" },
};

function renderWithIdleRows(workloads: readonly object[]): string {
  const payload = {
    ...BASE_STATUS,
    idleEviction: {
      status: "available",
      scope: "serving-process",
      advisory: true,
      idleEvictSeconds: 60,
      workloads,
    },
  };
  return renderResidencyStatus(payload as unknown as RenderInput, NOW_MS);
}

describe("#520 residency status idle-evict session-hold rendering", () => {
  test("R5: a SessionsActive hold renders its session ids", () => {
    // Kills: the renderer ignoring sessionHold and printing the lease fallback.
    const rendered = renderWithIdleRows([
      {
        workload: "wl-a",
        due: false,
        dueAtMs: NOW_MS - 1000,
        activeLeaseCount: 0,
        sessionHold: { reason: "SessionsActive", sessions: ["s1", "s2"] },
      },
    ]);
    expect(rendered).toContain("  wl-a  held SessionsActive: s1, s2  leases 0");
    expect(rendered).not.toContain("not due (leased or draining)");
  });

  test("R6: a SessionsUnknown hold renders without session ids", () => {
    // Kills: the renderer omitting the fail-closed unknown hold.
    const rendered = renderWithIdleRows([
      {
        workload: "wl-a",
        due: false,
        dueAtMs: NOW_MS - 1000,
        activeLeaseCount: 0,
        sessionHold: { reason: "SessionsUnknown", sessions: [] },
      },
    ]);
    expect(rendered).toContain("  wl-a  held SessionsUnknown  leases 0");
  });

  test("G6: rows without sessionHold keep the due and MinResidency rendering", () => {
    // Guard, passes on base: existing #519 rows render unchanged.
    const rendered = renderWithIdleRows([
      {
        workload: "wl-a",
        due: true,
        dueAtMs: NOW_MS - 1000,
        activeLeaseCount: 0,
      },
      {
        workload: "wl-min",
        due: false,
        dueAtMs: NOW_MS + 30_000,
        activeLeaseCount: 0,
        minResidencyUntilMs: NOW_MS + 30_000,
      },
    ]);
    expect(rendered).toContain("  wl-a  due  leases 0");
    expect(rendered).toContain("  wl-min  held MinResidency for 30s  leases 0");
  });
});
