import { describe, expect, test } from "bun:test";

import type * as LifecycleModule from "../src/residency/lifecycle.js";

import { BUILTIN_CATALOG } from "../src/catalog.js";

type Lifecycle = typeof LifecycleModule;

async function load(): Promise<Lifecycle> {
  const mod: Lifecycle | null = await import("../src/residency/lifecycle.js").catch(() => null);
  expect(mod).not.toBeNull();
  if (mod === null) {
    throw new Error("residency lifecycle module missing");
  }
  return mod;
}

const EXCLUSIVE_GROUPS: LifecycleModule.ResidencyGroupDeclaration[] = [
  { name: "z13-large-gpu", exclusive: true },
];

const Z13_MEMBERS: LifecycleModule.ResidencyMember[] = [
  { id: "glm", state: "ready", group: "z13-large-gpu" },
  { id: "ds", state: "downloaded", group: "z13-large-gpu" },
];

describe("residency lifecycle states", () => {
  test("L1 RESIDENCY_STATES lists the eight states in lifecycle order", async () => {
    const lc = await load();
    expect(lc.RESIDENCY_STATES).toEqual([
      "unavailable",
      "downloaded",
      "loading",
      "warming",
      "ready",
      "draining",
      "unloading",
      "failed",
    ]);
  });

  test("L2 transition table admits exactly the legal edges", async () => {
    const lc = await load();
    const legalEdges = new Set([
      "unavailable->downloaded",
      "downloaded->loading",
      "downloaded->unavailable",
      "loading->warming",
      "loading->failed",
      "loading->unloading",
      "warming->ready",
      "warming->failed",
      "warming->unloading",
      "ready->draining",
      "ready->failed",
      "draining->unloading",
      "draining->failed",
      "unloading->downloaded",
      "unloading->failed",
      "failed->downloaded",
      "failed->unavailable",
    ]);
    const expectedTargets: Record<
      LifecycleModule.ResidencyState,
      readonly LifecycleModule.ResidencyState[]
    > = {
      unavailable: ["downloaded"],
      downloaded: ["loading", "unavailable"],
      loading: ["warming", "failed", "unloading"],
      warming: ["ready", "failed", "unloading"],
      ready: ["draining", "failed"],
      draining: ["unloading", "failed"],
      unloading: ["downloaded", "failed"],
      failed: ["downloaded", "unavailable"],
    };
    for (const from of lc.RESIDENCY_STATES) {
      for (const to of lc.RESIDENCY_STATES) {
        expect(lc.isLegalResidencyTransition(from, to)).toBe(legalEdges.has(`${from}->${to}`));
      }
      expect([...lc.RESIDENCY_TRANSITIONS[from]].sort()).toEqual([...expectedTargets[from]].sort());
    }
  });

  test("L3 isResidencyState accepts only declared states", async () => {
    const lc = await load();
    expect(lc.isResidencyState("ready")).toBe(true);
    expect(lc.isResidencyState("cold")).toBe(false);
    expect(lc.isResidencyState("")).toBe(false);
    expect(lc.isResidencyState(3)).toBe(false);
    expect(lc.isResidencyState(undefined)).toBe(false);
  });

  test("L4 occupying states are exactly loading, ready and warming", async () => {
    const lc = await load();
    expect([...lc.OCCUPYING_RESIDENCY_STATES].sort()).toEqual(["loading", "ready", "warming"]);
    const occupying = new Set(["loading", "ready", "warming"]);
    for (const state of lc.RESIDENCY_STATES) {
      expect(lc.isOccupyingResidencyState(state)).toBe(occupying.has(state));
    }
  });
});

describe("evaluateResidencyTransition", () => {
  test("L5 an occupying exclusive-group peer refuses entry to loading", async () => {
    const lc = await load();
    const result = lc.evaluateResidencyTransition({
      groups: EXCLUSIVE_GROUPS,
      members: Z13_MEMBERS,
      id: "ds",
      to: "loading",
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "ExclusiveGroupOccupied",
      group: "z13-large-gpu",
      peer: { id: "glm", state: "ready" },
    });
    if (!result.ok) {
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  test("L6 non-occupying peer states allow entry; occupying ones refuse", async () => {
    const lc = await load();
    for (const peerState of [
      "downloaded",
      "draining",
      "unloading",
      "failed",
      "unavailable",
    ] as const) {
      const members: LifecycleModule.ResidencyMember[] = [
        { id: "glm", state: peerState, group: "z13-large-gpu" },
        { id: "ds", state: "downloaded", group: "z13-large-gpu" },
      ];
      expect(
        lc.evaluateResidencyTransition({
          groups: EXCLUSIVE_GROUPS,
          members,
          id: "ds",
          to: "loading",
        }),
      ).toEqual({ ok: true });
    }
    for (const peerState of ["loading", "warming"] as const) {
      const members: LifecycleModule.ResidencyMember[] = [
        { id: "glm", state: peerState, group: "z13-large-gpu" },
        { id: "ds", state: "downloaded", group: "z13-large-gpu" },
      ];
      expect(
        lc.evaluateResidencyTransition({
          groups: EXCLUSIVE_GROUPS,
          members,
          id: "ds",
          to: "loading",
        }),
      ).toMatchObject({ ok: false, reason: "ExclusiveGroupOccupied" });
    }
  });

  test("L7 a non-exclusive group does not block a ready peer", async () => {
    const lc = await load();
    const groups: LifecycleModule.ResidencyGroupDeclaration[] = [
      { name: "z13-large-gpu", exclusive: false },
    ];
    expect(
      lc.evaluateResidencyTransition({
        groups,
        members: Z13_MEMBERS,
        id: "ds",
        to: "loading",
      }),
    ).toEqual({ ok: true });
  });

  test("L8 undeclared groups fail closed on entry but not on drain", async () => {
    const lc = await load();
    const downloadedNope: LifecycleModule.ResidencyMember[] = [
      { id: "ds", state: "downloaded", group: "nope" },
    ];
    expect(
      lc.evaluateResidencyTransition({
        groups: EXCLUSIVE_GROUPS,
        members: downloadedNope,
        id: "ds",
        to: "loading",
      }),
    ).toMatchObject({ ok: false, reason: "UnknownGroup" });

    const readyNope: LifecycleModule.ResidencyMember[] = [
      { id: "ds", state: "ready", group: "nope" },
    ];
    expect(
      lc.evaluateResidencyTransition({
        groups: EXCLUSIVE_GROUPS,
        members: readyNope,
        id: "ds",
        to: "draining",
      }),
    ).toEqual({ ok: true });

    const noGroup: LifecycleModule.ResidencyMember[] = [{ id: "ds", state: "downloaded" }];
    expect(
      lc.evaluateResidencyTransition({
        groups: EXCLUSIVE_GROUPS,
        members: noGroup,
        id: "ds",
        to: "loading",
      }),
    ).toEqual({ ok: true });
  });

  test("L9 illegal edges are reported before the group check", async () => {
    const lc = await load();
    expect(
      lc.evaluateResidencyTransition({
        groups: EXCLUSIVE_GROUPS,
        members: Z13_MEMBERS,
        id: "ds",
        to: "ready",
      }),
    ).toMatchObject({ ok: false, reason: "IllegalTransition", from: "downloaded", to: "ready" });
  });

  test("L10 an unknown member id is refused", async () => {
    const lc = await load();
    expect(
      lc.evaluateResidencyTransition({
        groups: EXCLUSIVE_GROUPS,
        members: Z13_MEMBERS,
        id: "ghost",
        to: "loading",
      }),
    ).toMatchObject({ ok: false, reason: "UnknownMember" });
  });

  test("L11 the reported occupying peer is chosen deterministically", async () => {
    const lc = await load();
    const members: LifecycleModule.ResidencyMember[] = [
      { id: "b", state: "ready", group: "z13-large-gpu" },
      { id: "a", state: "ready", group: "z13-large-gpu" },
      { id: "c", state: "downloaded", group: "z13-large-gpu" },
    ];
    expect(
      lc.evaluateResidencyTransition({
        groups: EXCLUSIVE_GROUPS,
        members,
        id: "c",
        to: "loading",
      }),
    ).toMatchObject({
      ok: false,
      reason: "ExclusiveGroupOccupied",
      peer: { id: "a" },
    });
  });

  test("L15 a lone exclusive-group member is not blocked by itself", async () => {
    const lc = await load();
    const chain: [LifecycleModule.ResidencyState, LifecycleModule.ResidencyState][] = [
      ["downloaded", "loading"],
      ["loading", "warming"],
      ["warming", "ready"],
    ];
    for (const [from, to] of chain) {
      const members: LifecycleModule.ResidencyMember[] = [
        { id: "solo", state: from, group: "z13-large-gpu" },
      ];
      expect(
        lc.evaluateResidencyTransition({
          groups: EXCLUSIVE_GROUPS,
          members,
          id: "solo",
          to,
        }),
      ).toEqual({ ok: true });
    }
  });

  test("L16 occupying members outside the group do not block entry into it", async () => {
    const lc = await load();
    const members: LifecycleModule.ResidencyMember[] = [
      { id: "pooled", state: "ready", group: "pool" },
      { id: "ungrouped", state: "ready" },
      { id: "ds", state: "downloaded", group: "z13-large-gpu" },
    ];
    expect(
      lc.evaluateResidencyTransition({
        groups: EXCLUSIVE_GROUPS,
        members,
        id: "ds",
        to: "loading",
      }),
    ).toEqual({ ok: true });
  });
});

describe("findExclusiveGroupViolations", () => {
  test("L12 reports exclusive groups holding more than one occupying member", async () => {
    const lc = await load();
    expect(
      lc.findExclusiveGroupViolations(EXCLUSIVE_GROUPS, [
        { id: "y", state: "ready", group: "z13-large-gpu" },
        { id: "x", state: "warming", group: "z13-large-gpu" },
      ]),
    ).toEqual([{ group: "z13-large-gpu", members: ["x", "y"] }]);

    expect(
      lc.findExclusiveGroupViolations(EXCLUSIVE_GROUPS, [
        { id: "x", state: "ready", group: "z13-large-gpu" },
      ]),
    ).toEqual([]);

    const shared: LifecycleModule.ResidencyGroupDeclaration[] = [
      { name: "pool", exclusive: false },
    ];
    expect(
      lc.findExclusiveGroupViolations(shared, [
        { id: "a", state: "ready", group: "pool" },
        { id: "b", state: "ready", group: "pool" },
      ]),
    ).toEqual([]);
  });

  test("L17 occupying members outside the evaluated group are not attributed to it", async () => {
    const lc = await load();
    expect(
      lc.findExclusiveGroupViolations(EXCLUSIVE_GROUPS, [
        { id: "in", state: "ready", group: "z13-large-gpu" },
        { id: "out-pooled", state: "ready", group: "pool" },
        { id: "out-ungrouped", state: "warming" },
      ]),
    ).toEqual([]);
  });
});

describe("residency group declarations", () => {
  test("L13 ResidencyGroupDeclarations validates names, exclusivity and strictness", async () => {
    const lc = await load();
    const schema = lc.ResidencyGroupDeclarations;
    expect(schema.safeParse([{ name: "g", exclusive: true }]).success).toBe(true);
    expect(
      schema.safeParse([
        { name: "g", exclusive: true },
        { name: "g", exclusive: false },
      ]).success,
    ).toBe(false);
    expect(schema.safeParse([{ name: "g" }]).success).toBe(false);
    expect(schema.safeParse([{ name: "", exclusive: true }]).success).toBe(false);
    expect(schema.safeParse([{ name: "g", exclusive: true, note: "x" }]).success).toBe(false);
  });

  test("L14 RESIDENCY_GROUPS declares z13-large-gpu and covers the catalog", async () => {
    const lc = await load();
    expect(lc.RESIDENCY_GROUPS).toContainEqual({ name: "z13-large-gpu", exclusive: true });
    expect(lc.ResidencyGroupDeclarations.safeParse(lc.RESIDENCY_GROUPS).success).toBe(true);

    const declared = new Set(lc.RESIDENCY_GROUPS.map((group) => group.name));
    const referenced = new Set(
      BUILTIN_CATALOG.map((model) => model.residencyGroup).filter(
        (group): group is string => group !== undefined && group.length > 0,
      ),
    );
    expect(referenced.size).toBeGreaterThan(0);
    for (const group of referenced) {
      expect(declared.has(group)).toBe(true);
    }
  });
});
