// Pins #745: NodeFactsSchema.versions keeps the #743 build fields; see the #746 review.

import { describe, expect, test } from "bun:test";

import { NodeFactsSchema } from "../../src/config/schema.js";
import { MACHINE_PROFILES } from "../../src/types.js";

/**
 * The build stamp fields added to NodeFacts.versions by #743
 * (commit / dirty / builtAt / installKind) must survive schema
 * validation on both the full NodeFactsSchema and the
 * NodeFactsSchema.partial() path ClusterNodeSchema.facts uses —
 * zod strips unknown keys, so without explicit fields the stamp
 * silently disappears from reported node facts.
 */

const BASE_FACTS = {
  profile: MACHINE_PROFILES[0],
  memBytes: 1,
  os: "darwin",
  arch: "arm64",
  platform: "darwin-arm64",
  llamaCppBuildId: null,
  gpu: null,
  startedAt: "2026-11-01T00:00:00.000Z",
};

const VERSIONS_COMPILED = {
  llamactl: "0.0.0",
  bun: "1.4.3",
  llamaCppSrcRev: null,
  commit: "d".repeat(40),
  dirty: true,
  builtAt: "2026-11-01T00:00:00.000Z",
  installKind: "compiled" as const,
};

describe("NodeFactsSchema.versions build fields (#745)", () => {
  test("S1: versions keeps the build fields; a legacy versions object still parses", () => {
    const parsed = NodeFactsSchema.parse({ ...BASE_FACTS, versions: VERSIONS_COMPILED });
    expect(parsed.versions).toEqual(VERSIONS_COMPILED);

    const legacyVersions = { llamactl: "0.0.0", bun: "1.4.3", llamaCppSrcRev: null };
    const legacy = NodeFactsSchema.parse({ ...BASE_FACTS, versions: legacyVersions });
    expect(legacy.versions).toEqual(legacyVersions);
  });

  test("S2: NodeFactsSchema.partial() keeps the build fields (ClusterNodeSchema.facts path)", () => {
    const versions = { ...VERSIONS_COMPILED, installKind: "source" as const };
    const parsed = NodeFactsSchema.partial().parse({ versions });
    expect(parsed.versions).toEqual(versions);
  });

  test("S3: null build fields parse and are preserved", () => {
    const versions = {
      llamactl: "0.0.0",
      bun: "1.4.3",
      llamaCppSrcRev: null,
      commit: null,
      dirty: null,
      builtAt: null,
      installKind: "source" as const,
    };
    const parsed = NodeFactsSchema.parse({ ...BASE_FACTS, versions });
    expect(parsed.versions).toEqual(versions);
  });

  test("S4: an unknown installKind fails validation", () => {
    const result = NodeFactsSchema.safeParse({
      ...BASE_FACTS,
      versions: { ...VERSIONS_COMPILED, installKind: "weird" },
    });
    expect(result.success).toBe(false);
  });
});
