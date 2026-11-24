import type { LocalRoute } from "@llamactl/core/workloadRuntime";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildLocalRoutesSnapshot,
  type FleetSnapshotRouteOptions,
  handleFleetSnapshotRoute,
} from "../src/routes/fleet.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

const NOW = new Date("2026-11-23T12:00:00.000Z");
const WITH_PARAM = "http://agent/v1/fleet/snapshot?include=local-routes";
const QUALIFICATION = "llamactl.io/qualification";

// The snapshot crosses the wire as JSON; comparing the parsed form keeps
// the expected literal free of the not-yet-typed `labels` field.
function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function route(over: Partial<LocalRoute> & Pick<LocalRoute, "model" | "workload">): LocalRoute {
  return {
    host: "127.0.0.1",
    port: 8080,
    engine: "omlx",
    kind: "ModelHost",
    pid: 4242,
    ...over,
  };
}

describe("local-routes snapshot qualification label (#518)", () => {
  let dir = "";
  let missingJournal = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet-snapshot-qualification-"));
    missingJournal = join(dir, "absent", "journal.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function opts(routes: LocalRoute[]): FleetSnapshotRouteOptions {
    return {
      journalPath: missingJournal,
      localRoutes: (): LocalRoute[] => routes,
      revisionOf: (name: string): string | null => (name === "glm-host" ? "rev-1" : null),
      now: (): Date => NOW,
    };
  }

  test("F1: an experimental workload advertises the qualification label on its one entry", () => {
    // Kills: dropping the label emission in buildLocalRoutesSnapshot.
    const snap = buildLocalRoutesSnapshot(
      [
        route({
          workload: "glm-host",
          model: "glm-alias",
          qualificationStage: "experimental",
        }),
        route({
          workload: "glm-host",
          model: "org/glm.gguf",
          qualificationStage: "experimental",
        }),
      ],
      (): string => "rev-1",
      NOW,
    );
    expect(asJson(snap)).toEqual({
      kind: "local-routes",
      ts: "2026-11-23T12:00:00.000Z",
      workloads: [
        {
          name: "glm-host",
          models: ["glm-alias", "org/glm.gguf"],
          endpoint: "http://127.0.0.1:8080",
          reachable: true,
          revision: "rev-1",
          labels: { [QUALIFICATION]: "experimental" },
        },
      ],
    });
  });

  test("F2: a route labelled experimental without a stage still advertises the label", () => {
    // Kills: deriving the advertised label from qualificationStage only
    // instead of isExperimentalRoute.
    const snap = buildLocalRoutesSnapshot(
      [
        route({
          workload: "glm-host",
          model: "glm-alias",
          labels: { [QUALIFICATION]: "experimental" },
        }),
      ],
      (): string => "rev-1",
      NOW,
    );
    expect(asJson(snap?.workloads)).toEqual([
      {
        name: "glm-host",
        models: ["glm-alias"],
        endpoint: "http://127.0.0.1:8080",
        reachable: true,
        revision: "rev-1",
        labels: { [QUALIFICATION]: "experimental" },
      },
    ]);
  });

  test("F3: one experimental route marks the whole workload experimental", () => {
    // Kills: a first-route-only experimental check — the stable route is
    // listed first so an impl reading only routes[0] drops the label.
    const snap = buildLocalRoutesSnapshot(
      [
        route({ workload: "glm-host", model: "glm-stable" }),
        route({
          workload: "glm-host",
          model: "glm-exp",
          qualificationStage: "experimental",
        }),
      ],
      (): string => "rev-1",
      NOW,
    );
    expect(asJson(snap?.workloads)).toEqual([
      {
        name: "glm-host",
        models: ["glm-stable", "glm-exp"],
        endpoint: "http://127.0.0.1:8080",
        reachable: true,
        revision: "rev-1",
        labels: { [QUALIFICATION]: "experimental" },
      },
    ]);
  });

  test("F4: non-experimental stages and unlabelled routes emit no labels key", () => {
    // Guard: pins that only the experimental signal is advertised — any
    // other stage (or none) must leave the workload entry shape unchanged.
    const cases: (Partial<LocalRoute> & Pick<LocalRoute, "model">)[] = [
      { model: "m-validated", qualificationStage: "validated" },
      { model: "m-production", qualificationStage: "production" },
      { model: "m-degraded", qualificationStage: "degraded" },
      { model: "m-bogus", qualificationStage: "bogus" },
      { model: "m-none" },
      { model: "m-labelled-validated", labels: { [QUALIFICATION]: "validated" } },
    ];
    for (const over of cases) {
      const snap = buildLocalRoutesSnapshot(
        [route({ workload: "w1", ...over })],
        (): string => "rev-1",
        NOW,
      );
      expect(snap?.workloads).toHaveLength(1);
      const entry = snap?.workloads[0];
      if (entry === undefined) throw new Error("expected one workload entry");
      expect(entry).toEqual({
        name: "w1",
        models: [over.model],
        endpoint: "http://127.0.0.1:8080",
        reachable: true,
        revision: "rev-1",
      });
      expect("labels" in entry).toBe(false);
    }
  });

  test("F5: the route handler serves the experimental label in local-routes JSON", async () => {
    // Kills: the label not surviving handleFleetSnapshotRoute — e.g. the
    // local-routes fallback rebuilding workloads without labels.
    const res = handleFleetSnapshotRoute(
      new Request(WITH_PARAM),
      opts([
        route({
          workload: "glm-host",
          model: "glm-alias",
          qualificationStage: "experimental",
        }),
      ]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workloads?: { labels?: Record<string, string> }[];
    };
    expect(body.workloads?.[0]?.labels).toEqual({ [QUALIFICATION]: "experimental" });
  });
});
