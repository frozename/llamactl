import { describe, test } from "bun:test";
import { join } from "node:path";

import { expectPins, flat, readOrEmpty, REPO, sectionBody, SECTIONS } from "./helpers.js";

// Part of #519: docs and implementation surfaces must agree that invalid
// NodeRun-shaped files are reported by residencyStatus and rendered by the CLI.
describe("#519 residency status invalid NodeRun warnings", () => {
  test("D1: the knobs section documents invalidNodeRunWarnings and listInvalidNodeRuns", () => {
    expectPins(flat(sectionBody(SECTIONS.knobs) ?? ""), "knobs", [
      "`invalidNodeRunWarnings`",
      "`listInvalidNodeRuns`",
      "failed validation",
    ]);
  });

  test("D2: source pins wire invalid NodeRuns through the store, router, status and CLI", () => {
    const store = readOrEmpty(join(REPO, "packages/remote/src/workload/noderun-store.ts"));
    expectPins(store, "noderun-store", ["export function listInvalidNodeRuns"]);

    const procedures = readOrEmpty(join(REPO, "packages/remote/src/residency/procedures.ts"));
    expectPins(procedures, "procedures", ["invalidNodeRunWarnings"]);

    const router = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    expectPins(router, "router", ["listInvalidNodeRuns("]);

    const cli = readOrEmpty(join(REPO, "packages/cli/src/commands/residency.ts"));
    expectPins(cli, "cli", ["invalidNodeRunWarnings"]);
  });
});
