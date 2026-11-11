// #284 (DF-11): pure assembly of the read-only residencyStatus payload. No IO
// lives here — the router gathers the NodeRun manifest, the budget and the
// store snapshot and hands them in, so this module stays testable in isolation.
//
// Provenance split: the nodeRun, policy and budget sections come from the
// serving process's NodeRun manifest selected by `node`. The store section is
// always the serving process's own node-local residency store, whatever `node`
// was asked. Callers must not read it as `node`'s coordinator state.
import type { NodeRun } from "../workload/noderun-schema.js";
import type { ResidencyStoreSnapshot } from "./store.js";

type ResidencyPolicy = NonNullable<NodeRun["spec"]["residency"]>;

export type ResidencyStatusNonterminalOperation = {
  operationId: string;
  model: string;
  phase: string;
  targetState: string;
  reservationGiB: number;
};

export type ResidencyStatus = {
  node: string;
  nodeRun: { present: boolean };
  policy: { present: false } | { present: true; residency: ResidencyPolicy };
  budget: { memoryGiB: number; source: "noderun" | "computed" };
  store:
    | { path: string; present: false; scope: "serving-process" }
    | { path: string; present: true; error: string; scope: "serving-process" }
    | {
        path: string;
        present: true;
        nonterminalCount: number;
        nonterminal: ResidencyStatusNonterminalOperation[];
        scope: "serving-process";
      };
};

export function buildResidencyStatus(input: {
  node: string;
  nodeRun: NodeRun | undefined;
  budgetGiB: number;
  budgetSource: "noderun" | "computed";
  store: ResidencyStoreSnapshot;
}): ResidencyStatus {
  const residency = input.nodeRun?.spec.residency;
  return {
    node: input.node,
    nodeRun: { present: input.nodeRun !== undefined },
    policy: residency !== undefined ? { present: true, residency } : { present: false },
    budget: { memoryGiB: input.budgetGiB, source: input.budgetSource },
    store: storeWithScope(input.store),
  };
}

function storeWithScope(store: ResidencyStoreSnapshot): ResidencyStatus["store"] {
  const scope = "serving-process" as const;
  if (!store.present) {
    return { path: store.path, present: false, scope };
  }
  if ("error" in store) {
    return { path: store.path, present: true, error: store.error, scope };
  }
  return {
    path: store.path,
    present: true,
    nonterminalCount: store.nonterminal.length,
    nonterminal: store.nonterminal.map((record) => ({
      operationId: record.operationId,
      model: record.model,
      phase: record.phase,
      targetState: record.targetState,
      reservationGiB: record.reservationGiB,
    })),
    scope,
  };
}
