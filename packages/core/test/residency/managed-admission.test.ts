import { expect, test } from "bun:test";

import {
  evaluateManagedAdmission,
  type ManagedAdmissionClaim,
  type ManagedAdmissionInput,
  type ManagedAdmissionRefuseReason,
} from "../../src/residency/managed-admission.js";

const claim = (
  claimId: string,
  runtimeKey: string,
  specDigest: string,
  state: ManagedAdmissionClaim["state"],
  allocationGiB: number | undefined,
  kind?: ManagedAdmissionClaim["kind"],
): ManagedAdmissionClaim => ({
  claimId,
  runtimeKey,
  specDigest,
  state,
  allocationGiB,
  ...(kind === undefined ? {} : { kind }),
});

const input = (
  overrides: Partial<Omit<ManagedAdmissionInput, "incoming">> & {
    incoming?: Partial<ManagedAdmissionInput["incoming"]>;
  } = {},
): ManagedAdmissionInput => ({
  budgetGiB: 32,
  claims: [],
  ...overrides,
  incoming: {
    runtimeKey: "llama.cpp@abc123",
    specDigest: "sha256:spec-a",
    allocationGiB: 8,
    ...overrides.incoming,
  },
});

test("admits a fresh workload and reports the post-admission committed total", () => {
  const out = evaluateManagedAdmission(
    input({ claims: [claim("c1", "omlx@def456", "sha256:other", "resident", 10)] }),
  );
  expect(out).toEqual({ kind: "admit", chargedGiB: 8, budgetGiB: 32, committedGiB: 18 });
});

function expectRefuse(
  out: ReturnType<typeof evaluateManagedAdmission>,
  reason: ManagedAdmissionRefuseReason,
  detailContains?: string,
): void {
  expect(out.kind).toBe("refuse");
  if (out.kind !== "refuse") return;
  expect(out.reason).toBe(reason);
  expect(out.detail.length).toBeGreaterThan(0);
  if (detailContains !== undefined) {
    expect(out.detail).toContain(detailContains);
  }
}

test("refuses BudgetUnknown when the target budget is undefined, NaN, non-finite or non-positive", () => {
  for (const budgetGiB of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -4]) {
    expectRefuse(evaluateManagedAdmission(input({ budgetGiB })), "BudgetUnknown");
  }
});

test("refuses AllocationUnknown when the incoming allocation is unknown", () => {
  for (const allocationGiB of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -2]) {
    expectRefuse(
      evaluateManagedAdmission(input({ incoming: { allocationGiB } })),
      "AllocationUnknown",
    );
  }
});

test("refuses AllocationUnknown when any existing claim cannot be counted", () => {
  for (const state of ["pending", "resident", "uncertain"] as const) {
    const out = evaluateManagedAdmission(
      input({
        claims: [
          claim("c-ok", "omlx@def456", "sha256:other", "resident", 10),
          claim("c-unknown", "strata@789", "sha256:third", state, undefined),
        ],
      }),
    );
    expectRefuse(out, "AllocationUnknown", "c-unknown");
  }
});

test("BudgetUnknown wins over every other condition", () => {
  const out = evaluateManagedAdmission(
    input({
      budgetGiB: undefined,
      claims: [claim("c1", "llama.cpp@abc123", "sha256:spec-a", "pending", undefined)],
      incoming: { allocationGiB: undefined },
    }),
  );
  expectRefuse(out, "BudgetUnknown");
});

test("pending, resident and uncertain claims all count toward committedGiB", () => {
  const out = evaluateManagedAdmission(
    input({
      claims: [
        claim("c-pending", "a@1", "sha256:a", "pending", 8),
        claim("c-resident", "b@2", "sha256:b", "resident", 10),
        claim("c-uncertain", "c@3", "sha256:c", "uncertain", 8),
      ],
      incoming: { runtimeKey: "d@4", allocationGiB: 8 },
    }),
  );
  // 8 + 10 + 8 committed + 8 incoming = 34 > 32.
  expectRefuse(out, "BudgetExceeded");
});

test("admits when committed plus incoming equals the budget exactly", () => {
  const out = evaluateManagedAdmission(
    input({
      claims: [claim("c1", "a@1", "sha256:a", "resident", 24)],
    }),
  );
  expect(out).toEqual({ kind: "admit", chargedGiB: 8, budgetGiB: 32, committedGiB: 32 });
});

test("refuses WorkloadBusy when the runtimeKey is claimed by a different specDigest in any state", () => {
  for (const state of ["pending", "resident", "uncertain"] as const) {
    const out = evaluateManagedAdmission(
      input({
        claims: [claim("c1", "llama.cpp@abc123", "sha256:DIFFERENT", state, 8)],
      }),
    );
    expectRefuse(out, "WorkloadBusy");
  }
});

test("refuses WorkloadBusy when the same key+digest is uncertain — never join or re-promote", () => {
  const out = evaluateManagedAdmission(
    input({
      claims: [claim("c1", "llama.cpp@abc123", "sha256:spec-a", "uncertain", 8)],
    }),
  );
  expectRefuse(out, "WorkloadBusy");
});

test("joins a pending claim for the same key+digest instead of charging twice", () => {
  const out = evaluateManagedAdmission(
    input({
      budgetGiB: 10,
      claims: [claim("c-alias-1", "llama.cpp@abc123", "sha256:spec-a", "pending", 8)],
    }),
  );
  // Two manifest aliases share one runtimeKey+specDigest: the second must
  // join, and a 10 GiB budget stays sufficient even though committed (8)
  // + a hypothetical second charge (8) would exceed it.
  expect(out).toEqual({ kind: "join-pending", claimId: "c-alias-1" });
});

test("reports already-resident for the same key+digest", () => {
  const out = evaluateManagedAdmission(
    input({
      claims: [claim("c-live", "llama.cpp@abc123", "sha256:spec-a", "resident", 8)],
    }),
  );
  expect(out).toEqual({ kind: "already-resident", claimId: "c-live" });
});

test("a busy conflict on the same runtimeKey beats a joinable claim", () => {
  const out = evaluateManagedAdmission(
    input({
      claims: [
        claim("c-join", "llama.cpp@abc123", "sha256:spec-a", "pending", 8),
        claim("c-busy", "llama.cpp@abc123", "sha256:other", "resident", 8),
      ],
    }),
  );
  expectRefuse(out, "WorkloadBusy");
});

test("claims on other runtimeKeys do not affect join or resident matching", () => {
  const out = evaluateManagedAdmission(
    input({
      claims: [
        claim("c-other", "omlx@zzz", "sha256:spec-a", "resident", 4),
        claim("c-join", "llama.cpp@abc123", "sha256:spec-a", "pending", 8),
      ],
    }),
  );
  expect(out).toEqual({ kind: "join-pending", claimId: "c-join" });
});

function shuffles<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    shuffles([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

test("decisions are deterministic across every claim ordering", () => {
  const claims = [
    claim("c1", "a@1", "sha256:a", "pending", 8),
    claim("c2", "b@2", "sha256:b", "resident", 10),
    claim("c3", "c@3", "sha256:c", "uncertain", 4),
    claim("c4", "d@4", "sha256:d", "resident", 2),
  ];
  const results = shuffles(claims).map((ordered) =>
    evaluateManagedAdmission(input({ claims: ordered })),
  );
  const expected = { kind: "admit", chargedGiB: 8, budgetGiB: 32, committedGiB: 32 } as const;
  for (const out of results) {
    expect(out).toEqual(expected);
  }
});

test("join-pending picks a stable claimId across orderings", () => {
  const claims = [
    claim("c-zeta", "llama.cpp@abc123", "sha256:spec-a", "pending", 8),
    claim("c-alpha", "llama.cpp@abc123", "sha256:spec-a", "pending", 8),
    claim("c-mid", "other@1", "sha256:o", "resident", 4),
  ];
  for (const ordered of shuffles(claims)) {
    expect(evaluateManagedAdmission(input({ claims: ordered }))).toEqual({
      kind: "join-pending",
      claimId: "c-alpha",
    });
  }
});

test("plan-v3 table: resident 16 + pending 8 fully commits a 24 GiB budget against any incoming", () => {
  const claims = [
    claim("c-resident", "a@1", "sha256:a", "resident", 16),
    claim("c-pending", "b@2", "sha256:b", "pending", 8),
  ];
  const eight = evaluateManagedAdmission(
    input({
      budgetGiB: 24,
      claims,
      incoming: { runtimeKey: "c@3", specDigest: "sha256:c", allocationGiB: 8 },
    }),
  );
  expectRefuse(eight, "BudgetExceeded", "committed 24");

  const tiny = evaluateManagedAdmission(
    input({
      budgetGiB: 24,
      claims,
      incoming: { runtimeKey: "c@3", specDigest: "sha256:c", allocationGiB: 0.5 },
    }),
  );
  expectRefuse(tiny, "BudgetExceeded", "committed 24");

  const equal = evaluateManagedAdmission(
    input({
      claims,
      incoming: { runtimeKey: "c@3", specDigest: "sha256:c", allocationGiB: 8 },
    }),
  );
  expect(equal).toEqual({ kind: "admit", chargedGiB: 8, budgetGiB: 32, committedGiB: 32 });
});

test("uncertain claims are charged: uncertain 20 + incoming 8 exceeds a 24 GiB budget", () => {
  const out = evaluateManagedAdmission(
    input({
      budgetGiB: 24,
      claims: [claim("c-uncertain", "a@1", "sha256:a", "uncertain", 20)],
      incoming: { runtimeKey: "b@2", specDigest: "sha256:b", allocationGiB: 8 },
    }),
  );
  expectRefuse(out, "BudgetExceeded", "committed 20");
});

const manyClaims = (count: number, allocationGiB = 0.1): ManagedAdmissionClaim[] =>
  Array.from({ length: count }, (_, i) =>
    claim(`c${String(i)}`, `k@${String(i)}`, `sha256:${String(i)}`, "resident", allocationGiB),
  );

const offKeyIncoming = { runtimeKey: "z@9", specDigest: "sha256:z", allocationGiB: 8 };

test("refuses ClaimLimit when claims exceed 128, before any budget arithmetic", () => {
  const claims = manyClaims(129);
  claims[128] = claim("c-uncounted", "k@128", "sha256:128", "resident", undefined);
  const out = evaluateManagedAdmission(input({ budgetGiB: 24, claims, incoming: offKeyIncoming }));
  expectRefuse(out, "ClaimLimit", "129");
});

test("exactly 128 claims are allowed through to the budget arithmetic", () => {
  const out = evaluateManagedAdmission(
    input({ claims: manyClaims(128), incoming: offKeyIncoming }),
  );
  expect(out.kind).toBe("admit");
});

test("cross-kind collision: ModelRun vs ModelHost on one runtimeKey is WorkloadBusy", () => {
  const sameDigest = evaluateManagedAdmission(
    input({
      claims: [claim("c-host", "llama.cpp@abc123", "sha256:spec-a", "resident", 8, "ModelHost")],
      incoming: { kind: "ModelRun" },
    }),
  );
  expectRefuse(sameDigest, "WorkloadBusy");

  const differentDigest = evaluateManagedAdmission(
    input({
      claims: [claim("c-host", "llama.cpp@abc123", "sha256:other", "pending", 4, "ModelHost")],
      incoming: { kind: "ModelRun" },
    }),
  );
  expectRefuse(differentDigest, "WorkloadBusy");
});

test("matching kind on the same key+digest still joins or reports resident", () => {
  const joined = evaluateManagedAdmission(
    input({
      claims: [claim("c-run", "llama.cpp@abc123", "sha256:spec-a", "pending", 8, "ModelRun")],
      incoming: { kind: "ModelRun" },
    }),
  );
  expect(joined).toEqual({ kind: "join-pending", claimId: "c-run" });

  const resident = evaluateManagedAdmission(
    input({
      claims: [claim("c-run", "llama.cpp@abc123", "sha256:spec-a", "resident", 8, "ModelRun")],
      incoming: { kind: "ModelRun" },
    }),
  );
  expect(resident).toEqual({ kind: "already-resident", claimId: "c-run" });
});

test("the admission surface has no force flag", () => {
  type Incoming = ManagedAdmissionInput["incoming"];
  // @ts-expect-error ManagedAdmissionInput has no force property
  const top: ManagedAdmissionInput = { ...input(), force: true };
  // @ts-expect-error the incoming descriptor has no force property
  const nested: Incoming = { ...input().incoming, force: true };
  expect(top.claims.length).toBe(0);
  expect(nested.runtimeKey).toBe("llama.cpp@abc123");
});

test("does not mutate the input", () => {
  const claims = [
    claim("c1", "a@1", "sha256:a", "resident", 10),
    claim("c2", "b@2", "sha256:b", "pending", 4),
  ];
  const snapshot = JSON.parse(JSON.stringify(claims)) as ManagedAdmissionClaim[];
  const frozen = Object.freeze(claims.map((c) => Object.freeze({ ...c })));
  const before = input({ claims: frozen });
  evaluateManagedAdmission(before);
  expect(claims).toEqual(snapshot);
  expect(before.claims.length).toBe(2);
});
