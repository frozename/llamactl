import { describe, expect, test } from "bun:test";

import { computeModelRunSpecDigest } from "../../src/residency/spec-digest.js";

const baseManifest = {
  apiVersion: "llamactl/v1",
  kind: "ModelRun",
  metadata: { name: "qwen-prod", labels: { tier: "a" } },
  spec: {
    node: "mac-mini",
    model: "Qwen3.6-35B-A3B",
    args: ["-c", "32768", "-ctk", "q8_0"],
  },
};

describe("computeModelRunSpecDigest", () => {
  test("identical inputs produce identical digests", () => {
    const args = ["-c", "32768"];
    expect(computeModelRunSpecDigest(baseManifest, args)).toBe(
      computeModelRunSpecDigest(structuredClone(baseManifest), [...args]),
    );
  });

  test("object key order does not change the digest", () => {
    const shuffled = {
      spec: {
        args: ["-c", "32768", "-ctk", "q8_0"],
        model: "Qwen3.6-35B-A3B",
        node: "mac-mini",
      },
      metadata: { labels: { tier: "a" }, name: "qwen-prod" },
      kind: "ModelRun",
      apiVersion: "llamactl/v1",
    };
    expect(computeModelRunSpecDigest(shuffled, [])).toBe(
      computeModelRunSpecDigest(baseManifest, []),
    );
  });

  test("undefined-valued properties are ignored", () => {
    const withUndef = structuredClone(baseManifest) as Record<string, unknown>;
    withUndef.extras = undefined;
    (withUndef.spec as Record<string, unknown>).timeout = undefined;
    expect(computeModelRunSpecDigest(withUndef, [])).toBe(
      computeModelRunSpecDigest(baseManifest, []),
    );
  });

  test("different arg order produces different digests", () => {
    const a = computeModelRunSpecDigest(baseManifest, ["-c", "32768"]);
    const b = computeModelRunSpecDigest(baseManifest, ["32768", "-c"]);
    expect(a).not.toBe(b);
  });

  test("different arg values produce different digests", () => {
    const a = computeModelRunSpecDigest(baseManifest, ["-c", "32768"]);
    const b = computeModelRunSpecDigest(baseManifest, ["-c", "65536"]);
    expect(a).not.toBe(b);
  });

  test("same name but different args do not alias", () => {
    const a = computeModelRunSpecDigest(baseManifest, ["--mtp-head", "draft.gguf"]);
    const b = computeModelRunSpecDigest(baseManifest, []);
    expect(a).not.toBe(b);
  });

  test("changed placement (spec.node) produces different digests", () => {
    const other = structuredClone(baseManifest);
    other.spec.node = "gpu1";
    expect(computeModelRunSpecDigest(other, [])).not.toBe(
      computeModelRunSpecDigest(baseManifest, []),
    );
  });

  test("output is 64 lowercase hex chars", () => {
    const digest = computeModelRunSpecDigest(baseManifest, ["-c", "32768"]);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("input objects are not mutated", () => {
    const manifest = structuredClone(baseManifest);
    const snapshot = structuredClone(manifest);
    const args = ["-c", "32768"];
    const argsSnapshot = [...args];
    computeModelRunSpecDigest(manifest, args);
    expect(manifest).toEqual(snapshot);
    expect(args).toEqual(argsSnapshot);
  });
});
