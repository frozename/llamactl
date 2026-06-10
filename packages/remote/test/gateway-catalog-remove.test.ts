import { describe, expect, test } from "bun:test";

import type { SiriusProvider } from "../src/config/sirius-providers.js";

import { removeCompositeEntries } from "../src/workload/gateway-catalog/remove.js";

const own = (
  names: string[],
): { source: "composite"; compositeNames: string[]; specHash: string } => ({
  source: "composite" as const,
  compositeNames: names,
  specHash: "h",
});

describe("removeCompositeEntries", () => {
  test("drops entry when last composite removed", () => {
    const r = removeCompositeEntries({
      kind: "sirius",
      compositeName: "mc",
      current: [
        { name: "a", kind: "openai-compatible", baseUrl: "http://h/v1", ownership: own(["mc"]) },
      ] satisfies SiriusProvider[],
    });
    expect(r.changed).toBe(true);
    expect(r.removedNames).toEqual(["a"]);
    expect(r.next.length).toBe(0);
  });

  test("keeps entry with shorter compositeNames list when others remain", () => {
    const r = removeCompositeEntries({
      kind: "sirius",
      compositeName: "mc",
      current: [
        {
          name: "a",
          kind: "openai-compatible",
          baseUrl: "http://h/v1",
          ownership: own(["mc", "other"]),
        },
      ] satisfies SiriusProvider[],
    });
    expect(r.changed).toBe(true);
    expect(r.removedNames).toEqual([]);
    expect(r.next.length).toBe(1);
    expect(r.next[0]!.ownership.compositeNames).toEqual(["other"]);
  });

  test("leaves operator-owned entries untouched", () => {
    const r = removeCompositeEntries({
      kind: "sirius",
      compositeName: "mc",
      current: [
        { name: "op", kind: "openai", apiKeyRef: "$X" },
        { name: "cm", kind: "openai-compatible", baseUrl: "http://h/v1", ownership: own(["mc"]) },
      ] satisfies SiriusProvider[],
    });
    expect(r.next.length).toBe(1);
    expect(r.next[0]!.name).toBe("op");
    expect(r.removedNames).toEqual(["cm"]);
  });

  test("no-op when composite name not present", () => {
    const r = removeCompositeEntries({
      kind: "sirius",
      compositeName: "mc",
      current: [
        { name: "a", kind: "openai-compatible", baseUrl: "http://h/v1", ownership: own(["other"]) },
      ] satisfies SiriusProvider[],
    });
    expect(r.changed).toBe(false);
    expect(r.next.length).toBe(1);
  });
});
