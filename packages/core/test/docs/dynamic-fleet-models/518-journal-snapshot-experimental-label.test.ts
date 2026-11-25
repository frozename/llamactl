import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { existsSync } from "../../../src/safe-fs.js";
import { DOC, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #518 (b): journal-snapshot experimental labels.
// Kills: the doc paragraph missing the overlay producer
// (readFleetSnapshotOrLocalRoutes), naming the wrong match unit, keeping
// the "carry no label yet" limit, omitting the without-include contract,
// or fleet.ts lacking labelJournalExperimentalWorkloads / enough
// isExperimentalRoute references.
describe("#518 journal-snapshot experimental label doc", () => {
  test("D1: qualification section documents the journal overlay contract", () => {
    expect(existsSync(DOC)).toBe(true);
    const q = flat(sectionBody(/^## Qualification and promotion/) ?? "");
    expect(q).toContain("readFleetSnapshotOrLocalRoutes");
    expect(q).toMatch(/journal[^.]*snapshot[^.]*(label|overlay)/i);
    expect(q).not.toContain("carry no label yet");
    expect(q).toMatch(/workload name/i);
    expect(q).toMatch(
      /without[^.]*include=local-routes[^.]*unchanged|unchanged[^.]*without[^.]*include=local-routes/i,
    );
  });

  test("D2: fleet route source labels journal workloads via isExperimentalRoute", () => {
    const fleet = readOrEmpty(join(REPO, "packages/remote/src/routes/fleet.ts"));
    expect(fleet).toContain("labelJournalExperimentalWorkloads");
    expect(fleet.split("isExperimentalRoute").length - 1).toBeGreaterThanOrEqual(2);
  });
});
