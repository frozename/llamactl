/**
 * #280 DF-07 — declared entries bound to owner epoch and artifact
 * revision. The `liveRoutes` input and the `isDeclaredStaleReason`
 * predicate land with the fix, so both are reached through typed
 * intersections and a structural cast: at base the builder ignores
 * `liveRoutes` (every live id projects 'ready') and the predicate is
 * absent, so each RED case fails by assertion — never by import or
 * type error.
 */
import { routingCatalog } from "@llamactl/core";
import { describe, expect, test } from "bun:test";

import type { ModelHostManifest } from "../../src/workload/modelhost-schema.js";
import type { ModelRun } from "../../src/workload/schema.js";

import {
  buildDeclaredModelEntries,
  type DeclaredWorkloadPhase,
} from "../../src/residency/catalog.js";
import { ModelHostManifestSchema } from "../../src/workload/modelhost-schema.js";
import { ModelRunSchema } from "../../src/workload/schema.js";

type Input = Parameters<typeof buildDeclaredModelEntries>[0] & {
  liveRoutes?: readonly { workload: string; model: string }[];
};

const stale = routingCatalog as unknown as {
  isDeclaredStaleReason?: (reason: string | undefined) => boolean;
};

function hostManifest(name: string, spec: Record<string, unknown> = {}): ModelHostManifest {
  return ModelHostManifestSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name },
    spec: {
      engine: "omlx",
      node: "local",
      binary: "/x/engine",
      endpoint: { host: "127.0.0.1", port: 8100 },
      hostedModels: [{ rel: "org/repo/m.gguf" }],
      ...spec,
    },
  });
}

function runManifest(name: string, spec: Record<string, unknown> = {}): ModelRun {
  return ModelRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name },
    spec: {
      node: "local",
      target: { kind: "rel", value: "org/repo/run.gguf" },
      ...spec,
    },
  });
}

function leasePhaseOf(
  phases: Record<string, DeclaredWorkloadPhase>,
): (workload: string) => DeclaredWorkloadPhase | undefined {
  return (workload) => phases[workload];
}

// liveRoutes follow listLocalRoutes order: within one workload the first
// route's model is the served artifact.
function ownerEpochInput(): Input {
  return {
    nodeName: "local",
    modelHosts: [hostManifest("host-v2", { hostedModels: [{ rel: "fam/m.gguf" }] })],
    modelRuns: [],
    liveModelIds: new Set(["fam/m.gguf", "m.gguf"]),
    liveRoutes: [
      { workload: "host-v1", model: "fam/m.gguf" },
      { workload: "host-v1", model: "m.gguf" },
    ],
  };
}

function artifactHostInput(): Input {
  return {
    nodeName: "local",
    modelHosts: [hostManifest("host-a", { hostedModels: [{ rel: "new/m.gguf" }] })],
    modelRuns: [],
    liveModelIds: new Set(["old/m.gguf", "m.gguf"]),
    liveRoutes: [
      { workload: "host-a", model: "old/m.gguf" },
      { workload: "host-a", model: "m.gguf" },
    ],
  };
}

function artifactRunInput(): Input {
  return {
    nodeName: "local",
    modelHosts: [],
    modelRuns: [
      runManifest("run-a", {
        target: { kind: "rel", value: "new.gguf" },
        extraArgs: ["--alias", "chat"],
      }),
    ],
    liveModelIds: new Set(["old.gguf", "chat"]),
    liveRoutes: [
      { workload: "run-a", model: "old.gguf" },
      { workload: "run-a", model: "chat" },
    ],
  };
}

describe("declared binding to owner epoch and artifact revision (#280 DF-07)", () => {
  test("a live id routed under a different workload is stale-owner-epoch", () => {
    // Kills: ignoring route.workload !== claim.workload.
    const entries = buildDeclaredModelEntries(ownerEpochInput());

    expect(entries).toEqual([
      {
        id: "fam/m.gguf",
        workload: "host-v2",
        kind: "ModelHost",
        ownerNodeId: "local",
        state: "cold",
        autoLoadEligible: false,
        reason: "stale-owner-epoch",
      },
      {
        id: "m.gguf",
        workload: "host-v2",
        kind: "ModelHost",
        ownerNodeId: "local",
        state: "cold",
        autoLoadEligible: false,
        reason: "stale-owner-epoch",
      },
    ]);
  });

  test("an alias owned only by another workload is stale even when its claimant's rel is live", () => {
    const entries = buildDeclaredModelEntries({
      nodeName: "local",
      modelHosts: [],
      modelRuns: [
        runManifest("run-a", {
          target: { kind: "rel", value: "fam/m.gguf" },
          extraArgs: ["--alias", "chat"],
        }),
      ],
      liveModelIds: new Set(["fam/m.gguf", "chat"]),
      liveRoutes: [
        { workload: "run-a", model: "fam/m.gguf" },
        { workload: "run-b", model: "chat" },
      ],
    });

    expect(entries.find((entry) => entry.id === "chat")).toMatchObject({
      workload: "run-a",
      state: "cold",
      autoLoadEligible: false,
      reason: "stale-owner-epoch",
    });
    expect(entries.find((entry) => entry.id === "fam/m.gguf")?.state).toBe("ready");
  });

  test("a live id under a workload serving a different artifact is stale-artifact-revision", () => {
    // Kills: dropping the artifact comparison.
    const entries = buildDeclaredModelEntries(artifactHostInput());

    expect(entries.find((entry) => entry.id === "m.gguf")).toEqual({
      id: "m.gguf",
      workload: "host-a",
      kind: "ModelHost",
      ownerNodeId: "local",
      state: "cold",
      autoLoadEligible: false,
      reason: "stale-artifact-revision",
    });
    const fresh = entries.find((entry) => entry.id === "new/m.gguf");
    expect(fresh).toEqual({
      id: "new/m.gguf",
      workload: "host-a",
      kind: "ModelHost",
      ownerNodeId: "local",
      state: "cold",
      autoLoadEligible: true,
    });
    expect(fresh !== undefined && "reason" in fresh).toBe(false);
  });

  test("a ModelRun alias live under a stale artifact revision is stale-artifact-revision", () => {
    // Kills: an artifact derivation that uses the claim id instead of the
    // first route model per workload.
    const entries = buildDeclaredModelEntries(artifactRunInput());

    expect(entries.find((entry) => entry.id === "chat")).toEqual({
      id: "chat",
      workload: "run-a",
      kind: "ModelRun",
      ownerNodeId: "local",
      state: "cold",
      autoLoadEligible: false,
      reason: "stale-artifact-revision",
    });
    const target = entries.find((entry) => entry.id === "new.gguf");
    expect(target).toEqual({
      id: "new.gguf",
      workload: "run-a",
      kind: "ModelRun",
      ownerNodeId: "local",
      state: "cold",
      autoLoadEligible: true,
    });
    expect(target !== undefined && "reason" in target).toBe(false);
  });

  test("guard: a current binding projects identical entries with and without liveRoutes", () => {
    // Kills: over-eager staleness.
    const host = hostManifest("host-a", { hostedModels: [{ rel: "fam/m.gguf" }] });
    const liveModelIds = new Set(["fam/m.gguf", "m.gguf"]);
    const input: Input = {
      nodeName: "local",
      modelHosts: [host],
      modelRuns: [],
      liveModelIds,
      liveRoutes: [
        { workload: "host-a", model: "fam/m.gguf" },
        { workload: "host-a", model: "m.gguf" },
      ],
    };
    const withoutRoutes: Input = {
      nodeName: "local",
      modelHosts: [host],
      modelRuns: [],
      liveModelIds,
    };

    const withRoutes = buildDeclaredModelEntries(input);
    const without = buildDeclaredModelEntries(withoutRoutes);

    expect(withRoutes).toEqual(without);
    expect(withRoutes).toMatchObject([
      { id: "fam/m.gguf", state: "ready", autoLoadEligible: false },
      { id: "m.gguf", state: "ready", autoLoadEligible: false },
    ]);
  });

  test("guard: without liveRoutes the owner and artifact inputs keep live ids ready", () => {
    // Kills: deriving staleness from liveModelIds alone.
    const { liveRoutes: _ownerRoutes, ...ownerOff } = ownerEpochInput();
    const { liveRoutes: _hostRoutes, ...hostOff } = artifactHostInput();

    const ownerEntries = buildDeclaredModelEntries(ownerOff);
    const hostEntries = buildDeclaredModelEntries(hostOff);

    expect(ownerEntries).toMatchObject([
      { id: "fam/m.gguf", state: "ready", autoLoadEligible: false },
      { id: "m.gguf", state: "ready", autoLoadEligible: false },
    ]);
    for (const entry of ownerEntries) {
      expect("reason" in entry).toBe(false);
    }
    expect(hostEntries).toMatchObject([
      { id: "m.gguf", state: "ready", autoLoadEligible: false },
      { id: "new/m.gguf", state: "cold", autoLoadEligible: true },
    ]);
    for (const entry of hostEntries) {
      expect("reason" in entry).toBe(false);
    }
  });

  test("stale reasons yield to collision, disabled and draining but precede loading", () => {
    // Kills: ordering the stale check after the loading branches — and
    // ahead of the collided/disabled/draining checks.
    const collided: Input = {
      nodeName: "local",
      modelHosts: [hostManifest("host-a", { hostedModels: [{ rel: "new/m.gguf" }] })],
      modelRuns: [runManifest("run-b", { target: { kind: "rel", value: "m.gguf" } })],
      liveModelIds: new Set(["old/m.gguf", "m.gguf"]),
      liveRoutes: [
        { workload: "host-a", model: "old/m.gguf" },
        { workload: "host-a", model: "m.gguf" },
      ],
    };
    const collidedClaims = buildDeclaredModelEntries(collided).filter(
      (entry) => entry.id === "m.gguf",
    );
    expect(collidedClaims).toHaveLength(2);
    for (const entry of collidedClaims) {
      expect(entry).toMatchObject({
        state: "unavailable",
        autoLoadEligible: false,
        reason: "alias-collision",
      });
    }

    const disabled: Input = {
      nodeName: "local",
      modelHosts: [
        hostManifest("host-off", {
          enabled: false,
          hostedModels: [{ rel: "gone/g.gguf" }],
        }),
      ],
      modelRuns: [],
      liveModelIds: new Set(["gone/g.gguf", "g.gguf"]),
      liveRoutes: [
        { workload: "host-v1", model: "gone/g.gguf" },
        { workload: "host-v1", model: "g.gguf" },
      ],
    };
    expect(buildDeclaredModelEntries(disabled)).toMatchObject([
      { id: "g.gguf", state: "disabled", autoLoadEligible: false },
      { id: "gone/g.gguf", state: "disabled", autoLoadEligible: false },
    ]);

    const draining: Input = {
      ...artifactHostInput(),
      workloadPhase: leasePhaseOf({ "host-a": "draining" }),
    };
    expect(
      buildDeclaredModelEntries(draining).find((entry) => entry.id === "m.gguf"),
    ).toMatchObject({ state: "draining", autoLoadEligible: false });

    const unloaded: Input = {
      ...artifactHostInput(),
      workloadPhase: leasePhaseOf({ "host-a": "unloaded" }),
    };
    const unloadedEntries = buildDeclaredModelEntries(unloaded);
    expect(unloadedEntries.find((entry) => entry.id === "m.gguf")).toEqual({
      id: "m.gguf",
      workload: "host-a",
      kind: "ModelHost",
      ownerNodeId: "local",
      state: "cold",
      autoLoadEligible: false,
      reason: "stale-artifact-revision",
    });
    expect(unloadedEntries.find((entry) => entry.id === "new/m.gguf")).toMatchObject({
      state: "cold",
      autoLoadEligible: true,
    });

    const warming: Input = {
      ...artifactHostInput(),
      warmingModelIds: new Set(["m.gguf"]),
    };
    expect(buildDeclaredModelEntries(warming).find((entry) => entry.id === "m.gguf")).toEqual({
      id: "m.gguf",
      workload: "host-a",
      kind: "ModelHost",
      ownerNodeId: "local",
      state: "cold",
      autoLoadEligible: false,
      reason: "stale-artifact-revision",
    });
  });

  test("isDeclaredStaleReason names the stale reasons and stale entries stay schema-valid", () => {
    // Kills: a missing or always-false predicate.
    expect(typeof stale.isDeclaredStaleReason).toBe("function");
    expect(stale.isDeclaredStaleReason?.("stale-owner-epoch")).toBe(true);
    expect(stale.isDeclaredStaleReason?.("stale-artifact-revision")).toBe(true);
    expect(stale.isDeclaredStaleReason?.("alias-collision")).toBe(false);
    expect(stale.isDeclaredStaleReason?.(undefined)).toBe(false);

    const schema = routingCatalog.DeclaredModelEntryV1Schema;
    for (const input of [ownerEpochInput(), artifactHostInput(), artifactRunInput()]) {
      for (const entry of buildDeclaredModelEntries(input)) {
        expect(schema.safeParse(entry).success).toBe(true);
      }
    }
  });
});
