import { describe, expect, it } from "bun:test";

import { stepStaleStreak } from "../src/sourceRevision.js";

describe("source staleness reload-loop safety", () => {
  it("a reloaded process does not immediately re-reload (no restart loop)", () => {
    // Process A started at "aaa"; the world moved to "bbb". A reaches the reload
    // threshold after the debounce.
    const currentRev = "bbb";
    let stateA = { streak: 0 };
    let reloadedA = false;
    for (let i = 0; i < 2; i++) {
      const r = stepStaleStreak(stateA, currentRev, "aaa", 2);
      stateA = r.state;
      reloadedA = reloadedA || r.shouldReload;
    }
    expect(reloadedA).toBe(true);

    // Process B is the reload: launchd restarts it and it captures startupRev = the
    // CURRENT rev ("bbb") at ITS startup. The first boundary therefore sees equality
    // — streak 0, no reload — so it cannot tight-loop on the same revision.
    const startupRevB = currentRev;
    const firstB = stepStaleStreak({ streak: 0 }, currentRev, startupRevB, 2);
    expect(firstB.shouldReload).toBe(false);
    expect(firstB.state).toEqual({ streak: 0 });

    // It stays put across subsequent boundaries while the source is stable.
    const secondB = stepStaleStreak(firstB.state, currentRev, startupRevB, 2);
    expect(secondB.shouldReload).toBe(false);
    expect(secondB.state).toEqual({ streak: 0 });
  });
});
