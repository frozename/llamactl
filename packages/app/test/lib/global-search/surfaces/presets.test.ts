// packages/app/test/lib/global-search/surfaces/presets.test.ts
import { describe, expect, test } from "bun:test";

import { matchPresets } from "../../../../src/lib/global-search/surfaces/presets";

describe("matchPresets", () => {
  test("empty needle returns []", () => {
    const items = [{ name: "fast" }];
    const out = matchPresets("", items);
    expect(out).toEqual([]);
  });

  test("a match on name alone works", () => {
    const items = [{ name: "fast-coder" }];
    const out = matchPresets("fast", items);
    expect(out.length).toBe(1);
  });

  test("a match on description alone works", () => {
    const items = [{ name: "fast", description: "coding assistant" }];
    const out = matchPresets("coding", items);
    expect(out.length).toBe(1);
  });

  test("a description-only match scores 0.5 even when description starts with needle", () => {
    const items = [{ name: "fast", description: "coding helper" }];
    const out = matchPresets("coding", items);
    expect(out.length).toBe(1);
    expect(out[0]!.score).toBe(0.5);
  });

  test("a name prefix scores 0.8 and a name mid-string match scores 0.5", () => {
    const prefixItems = [{ name: "fast-coder" }];
    const midItems = [{ name: "afastb" }];
    const prefixOut = matchPresets("fast", prefixItems);
    const midOut = matchPresets("fast", midItems);
    expect(prefixOut.length).toBe(1);
    expect(prefixOut[0]!.score).toBe(0.8);
    expect(midOut.length).toBe(1);
    expect(midOut[0]!.score).toBe(0.5);
  });

  test("matching ignores case", () => {
    const items = [{ name: "FastCoder" }];
    const out = matchPresets("fast", items);
    expect(out.length).toBe(1);
  });

  test("a missing description does not break matching or produce 'undefined' text", () => {
    const items = [{ name: "fast" }];
    const out = matchPresets("undefined", items);
    expect(out.length).toBe(0);
  });

  test("every hit opens the shared Presets module tab", () => {
    const items = [{ name: "fast" }];
    const out = matchPresets("fast", items);
    const [hit] = out;
    expect(hit).toBeDefined();
    expect(hit!.surface).toBe("preset");
    expect(hit!.parentId).toBe("fast");
    expect(hit!.parentTitle).toBe("fast");
    const a = hit!.action;
    expect(a.kind).toBe("open-tab");
    if (a.kind === "open-tab") {
      const tab = a.tab;
      expect(tab.tabKey).toBe("module:presets");
      expect(tab.title).toBe("Presets");
      expect(tab.kind).toBe("module");
      expect("instanceId" in tab).toBe(false);
      expect(typeof tab.openedAt).toBe("number");
    }
  });
});
