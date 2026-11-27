import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { DOC, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #518 (c): peer-advertised degraded stage.
describe("#518 peer-advertised degraded stage doc", () => {
  test("qualification section documents the degraded peer admission contract", () => {
    // Kills: a missing doc paragraph, or a producer/forwarder without degraded.
    expect(readOrEmpty(DOC)).not.toBe("");
    const q = flat(sectionBody(/^## Qualification and promotion/) ?? "");
    expect(q).toContain("llamactl.io/qualification: degraded");
    expect(q).toMatch(/degraded[^.]*never[^.]*lift[^.]*experimental/i);
    expect(q).toContain("admitPeerRoute");
    expect(q).toMatch(/healthy peer[^.]*admit/i);
    expect(q).toMatch(/local routes?[^.]*(authoritative|always win)/i);
    expect(q).toMatch(/legacy[^.]*comparator[^.]*ignores degraded/i);
    expect(q).toMatch(/first admitted peer route by workload name[^.]*leads/i);

    const fleet = readOrEmpty(join(REPO, "packages/remote/src/routes/fleet.ts"));
    expect(fleet).toContain("degraded");
    const poller = readOrEmpty(join(REPO, "packages/remote/src/server/peer-snapshot-poller.ts"));
    expect(poller).toContain("degraded");
  });
});
