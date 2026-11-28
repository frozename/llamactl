import { isDeepStrictEqual } from "node:util";

import type { ModelHostManifest } from "../workload/modelhost-schema.js";
import type { NodeRun } from "../workload/noderun-schema.js";
import type { ModelRun } from "../workload/schema.js";

import { listModelHosts } from "../workload/modelhost-store.js";
import { listNodeRuns } from "../workload/noderun-store.js";
import { listWorkloads } from "../workload/store.js";

export type ProfileDesiredSnapshot = {
  node: string;
  budget: NodeRun["spec"]["budget"] | undefined;
  residency: NodeRun["spec"]["residency"] | undefined;
  modelRuns: Omit<ModelRun, "status">[];
  modelHosts: ModelHostManifest[];
};

export function captureProfileDesired(
  node: string,
  nodeRun: NodeRun | undefined,
  modelRuns: readonly ModelRun[],
  modelHosts: readonly ModelHostManifest[],
  matchesNode: (candidate: string) => boolean = (candidate) => candidate === node,
): ProfileDesiredSnapshot {
  return {
    node,
    budget: nodeRun?.spec.budget,
    residency: nodeRun?.spec.residency,
    // A stop publishes a new runtime status without changing desired inputs.
    modelRuns: modelRuns
      .filter((run) => matchesNode(run.spec.node) && !run.spec.gateway)
      .map(({ status: _observed, ...desired }) => desired),
    modelHosts: modelHosts.filter((host) => matchesNode(host.spec.node)),
  };
}

export function isProfileDesiredCurrent(
  expected: ProfileDesiredSnapshot,
  workloadsDir: string,
  matchesNode?: (candidate: string) => boolean,
): boolean {
  try {
    const { node } = expected;
    const nodeRun = listNodeRuns(workloadsDir).find(
      (candidate) => candidate.metadata.name === node,
    );
    return isDeepStrictEqual(
      expected,
      captureProfileDesired(
        node,
        nodeRun,
        listWorkloads(workloadsDir),
        listModelHosts(workloadsDir),
        matchesNode,
      ),
    );
  } catch {
    return false;
  }
}
