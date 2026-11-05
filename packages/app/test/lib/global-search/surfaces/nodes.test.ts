// packages/app/test/lib/global-search/surfaces/nodes.test.ts
import { describe, expect, test } from "bun:test";

import { matchNodes } from "../../../../src/lib/global-search/surfaces/nodes";

describe("matchNodes", () => {
  test("empty needle returns [] even when items are non-empty", () => {
    const items = [{ name: "atlas" }];
    const out = matchNodes("", items);
    expect(out).toEqual([]);
  });

  test("matching ignores case: needle 'ATL' matches name 'atlas'", () => {
    const items = [{ name: "atlas" }];
    const out = matchNodes("ATL", items);
    expect(out.length).toBe(1);
  });

  test("a name that does not contain the needle is excluded", () => {
    const items = [{ name: "atlas" }];
    const out = matchNodes("zebra", items);
    expect(out.length).toBe(0);
  });

  test("a prefix match scores 0.8", () => {
    const items = [{ name: "atlas" }];
    const out = matchNodes("atl", items);
    expect(out.length).toBe(1);
    expect(out[0]!.score).toBe(0.8);
  });

  test("a mid-string match scores 0.5", () => {
    const items = [{ name: "atlas" }];
    const out = matchNodes("las", items);
    expect(out.length).toBe(1);
    expect(out[0]!.score).toBe(0.5);
  });

  test("effectiveKind is ignored for matching", () => {
    const items = [{ name: "atlas", effectiveKind: "cloud" }];
    const out = matchNodes("cloud", items);
    expect(out.length).toBe(0);
  });

  test("hit shape is correct", () => {
    const items = [{ name: "atlas" }];
    const out = matchNodes("atlas", items);
    const [hit] = out;
    expect(hit).toBeDefined();
    expect(hit!.surface).toBe("node");
    expect(hit!.parentId).toBe("atlas");
    expect(hit!.parentTitle).toBe("atlas");
    expect(hit!.matchKind).toBe("exact");
    const a = hit!.action;
    expect(a.kind).toBe("open-tab");
    if (a.kind === "open-tab") {
      const tab = a.tab;
      expect(tab.tabKey).toBe("node:atlas");
      expect(tab.kind).toBe("node");
      expect(tab.instanceId).toBe("atlas");
      expect(tab.title).toBe("atlas");
      expect(typeof tab.openedAt).toBe("number");
    }
  });

  test("output order and count follow the input order", () => {
    const items = [{ name: "alpha" }, { name: "atlas" }, { name: "zulu" }];
    const out = matchNodes("a", items);
    expect(out.length).toBe(2);
    expect(out[0]!.parentId).toBe("alpha");
    expect(out[1]!.parentId).toBe("atlas");
  });
});
