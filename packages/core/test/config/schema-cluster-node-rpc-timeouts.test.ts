/**
 * Pin ClusterNodeSchema's rpcTimeouts block (#221): per-node deadlines for
 * controller -> node RPCs. The block is strict so a misspelled key refuses
 * the node instead of being silently stripped, and each deadline is a
 * positive integer inside setTimeout's 2^31-1 ms clamp.
 */

import { describe, expect, test } from "bun:test";

import { ClusterNodeSchema } from "../../src/config/schema.js";

const BASE = { name: "gpu1", endpoint: "https://gpu1.lan:7843" };

describe("ClusterNodeSchema rpcTimeouts (#221)", () => {
  test("keeps a node's rpcTimeouts block", () => {
    const r = ClusterNodeSchema.safeParse({
      ...BASE,
      rpcTimeouts: { queryMs: 2000, mutateMs: 5000 },
    });
    expect(r.success).toBe(true);
    expect(r.data?.rpcTimeouts).toEqual({ queryMs: 2000, mutateMs: 5000 });
  });

  test("keeps a partial block", () => {
    const r = ClusterNodeSchema.safeParse({ ...BASE, rpcTimeouts: { queryMs: 2000 } });
    expect(r.success).toBe(true);
    expect(r.data?.rpcTimeouts).toEqual({ queryMs: 2000 });
  });

  test.each([
    { label: "queryMs 0", rpcTimeouts: { queryMs: 0 } },
    { label: "queryMs -1", rpcTimeouts: { queryMs: -1 } },
    { label: "queryMs 1.5", rpcTimeouts: { queryMs: 1.5 } },
    { label: "queryMs above the setTimeout clamp", rpcTimeouts: { queryMs: 2147483648 } },
    { label: "mutateMs 0", rpcTimeouts: { mutateMs: 0 } },
    { label: "misspelled queryMS", rpcTimeouts: { queryMS: 2000 } },
  ])("rejects invalid rpcTimeouts: $label", ({ rpcTimeouts }) => {
    const r = ClusterNodeSchema.safeParse({ ...BASE, rpcTimeouts });
    expect(r.success).toBe(false);
  });

  test("a node without rpcTimeouts parses with the field undefined", () => {
    const r = ClusterNodeSchema.safeParse(BASE);
    expect(r.success).toBe(true);
    expect(r.data?.rpcTimeouts).toBeUndefined();
  });
});
