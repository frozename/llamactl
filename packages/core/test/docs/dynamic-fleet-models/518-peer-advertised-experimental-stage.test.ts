import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { existsSync } from "../../../src/safe-fs.js";
import { DOC, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #518 (a): peer-advertised experimental stage.
// Kills: the doc paragraph missing, naming the wrong producer/forwarder,
// claiming a non-experimental peer stage propagates, omitting the
// journal-snapshot limit, or either remote source not referencing
// QUALIFICATION_LABEL.
describe("#518 peer-advertised experimental stage doc", () => {
  test("qualification section documents the peer label contract", () => {
    expect(existsSync(DOC)).toBe(true);
    const q = flat(sectionBody(/^## Qualification and promotion/) ?? "");
    for (const needle of ["buildLocalRoutesSnapshot", "collectPeerWorkloads"]) {
      expect(q, needle).toContain(needle);
    }
    expect(q).toContain("llamactl.io/qualification");
    // Only the experimental value is advertised and forwarded.
    expect(q).toMatch(/only[^.]*experimental[^.]*(advertis|forward)/i);
    expect(q).toMatch(/(advertis|forward)[^.]*only[^.]*experimental/i);
    // A non-experimental peer stage is not propagated.
    expect(q).toMatch(/non-experimental[^.]*(not|never)[^.]*propagat/i);
    // Fleet-supervisor journal snapshots carry no label — the limit.
    expect(q).toMatch(/fleet[- ]?supervisor/i);
    expect(q).toMatch(/journal[^.]*(no|without|never)[^.]*label/i);
  });

  test("remote producer and forwarder reference QUALIFICATION_LABEL", () => {
    const fleet = readOrEmpty(join(REPO, "packages/remote/src/routes/fleet.ts"));
    expect(fleet).toContain("QUALIFICATION_LABEL");
    const poller = readOrEmpty(join(REPO, "packages/remote/src/server/peer-snapshot-poller.ts"));
    expect(poller).toContain("QUALIFICATION_LABEL");
  });
});
