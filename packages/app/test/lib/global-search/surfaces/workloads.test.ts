// packages/app/test/lib/global-search/surfaces/workloads.test.ts
import { describe, expect, test } from "bun:test";

import { matchWorkloads } from "../../../../src/lib/global-search/surfaces/workloads";
import type { TabEntry } from "../../../../src/stores/tab-store";

describe("matchWorkloads", () => {
  const items = [
    { name: "qwen-72b", model: "qwen/qwen-72b", node: "gpu1" },
    { name: "embed-bge", model: "bge-small-en-v1.5", node: "atlas" },
  ];

  test("matches by workload name", () => {
    const out = matchWorkloads("qwen", items);
    expect(out.length).toBe(1);
    expect(out[0]!.parentId).toBe("qwen-72b");
  });

  test("matches by model field", () => {
    const out = matchWorkloads("bge", items);
    expect(out.length).toBe(1);
    expect(out[0]!.parentId).toBe("embed-bge");
  });

  test("matches by node field", () => {
    const out = matchWorkloads("atlas", items);
    expect(out.length).toBe(1);
  });

  test("action opens workload tab", () => {
    const out = matchWorkloads("qwen", items);
    const [hit] = out;
    expect(hit).toBeDefined();
    const a = hit?.action;
    if (!a) return;
    expect(a.kind).toBe("open-tab");
    if (a.kind === "open-tab") {
      const tab = a.tab as TabEntry;
      expect(tab.kind).toBe("workload");
      expect(tab.instanceId).toBe("qwen-72b");
    }
  });
});
