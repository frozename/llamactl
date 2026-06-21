import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmbersynthNode } from "../src/config/embersynth.js";

import { mkdtempSync, rmSync } from "../src/safe-fs.js";
import {
  readGatewayCatalog,
  updateGatewayCatalog,
  writeGatewayCatalog,
} from "../src/workload/gateway-catalog/io.js";

function node(id: string): EmbersynthNode {
  return {
    id,
    label: id,
    endpoint: "http://h/v1",
    transport: "http",
    enabled: true,
    capabilities: [],
    tags: [],
    providerType: "openai-compatible",
    modelId: "default",
    priority: 5,
  };
}

describe("gateway-catalog io concurrency", () => {
  let tmp: string;
  let prevEm: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gc-io-conc-"));
    prevEm = process.env["LLAMACTL_EMBERSYNTH_CONFIG"];
    process.env["LLAMACTL_EMBERSYNTH_CONFIG"] = join(tmp, "em.yaml");
  });

  afterEach(() => {
    if (prevEm === undefined) delete process.env["LLAMACTL_EMBERSYNTH_CONFIG"];
    else process.env["LLAMACTL_EMBERSYNTH_CONFIG"] = prevEm;
    rmSync(tmp, { recursive: true, force: true });
  });

  // TEST-FIRST #1 — proves the lost-update race. Two callers each derive
  // their `next` set by reading the catalog and APPENDING a distinct node.
  // Fired concurrently (Promise.all of two un-awaited update calls), each
  // transform observes its own read. On the UNSERIALIZED base the second
  // writer clobbers the first → one node is permanently lost. The atomic
  // mutex forces each transform to read FRESH inside the lock, so both
  // survive.
  test("concurrent adds — both nodes survive (lost-update guard)", async () => {
    // seed so both writers start from a non-empty, shared base
    writeGatewayCatalog("embersynth", [node("base")]);

    await Promise.all([
      updateGatewayCatalog("embersynth", (current) => [...current, node("alpha")]),
      updateGatewayCatalog("embersynth", (current) => [...current, node("beta")]),
    ]);

    const ids = readGatewayCatalog("embersynth")
      .map((n) => n.id)
      .sort();
    expect(ids).toEqual(["alpha", "base", "beta"]);
  });

  // TEST-FIRST #2 — guards against the merge-union regression. A cleanup
  // expresses its change as a REDUCED set (drop "gone", keep "keep"),
  // exactly as `removeCompositeEntries` produces. REPLACE semantics must
  // make the removed node actually disappear. A merge-union implementation
  // would resurrect "gone" from the prior read and FAIL this.
  test("reduced set replaces — removed node is gone (no merge-union)", async () => {
    writeGatewayCatalog("embersynth", [node("keep"), node("gone")]);

    await updateGatewayCatalog("embersynth", (current) => current.filter((n) => n.id !== "gone"));

    const ids = readGatewayCatalog("embersynth").map((n) => n.id);
    expect(ids).toEqual(["keep"]);
    expect(ids).not.toContain("gone");
  });
});
