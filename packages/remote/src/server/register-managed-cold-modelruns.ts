import { openaiProxy, type routingCatalog } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { findTcpListenerPid } from "@llamactl/core/probe";
import { getResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { listLocalRoutes } from "@llamactl/core/workloadRuntime";
import { createHash } from "node:crypto";

import type { TrustedColdOwner } from "../residency/cold-owner-admission.js";
import type {
  LocalModelRunReadyRoute,
  LocalModelRunResidentProof,
} from "../residency/local-modelrun-cold-owner.js";
import type { openNodeManagedAdmission } from "../residency/target-admission-policy.js";
import type { StartAgentOptions } from "./serve.js";

import {
  type ColdModelArtifactReceipt,
  verifyColdModelArtifactReceipt,
} from "../residency/cold-artifact-receipt.js";
import {
  createManagedColdModelRunFactory,
  prepareManagedColdModelRun,
} from "../residency/managed-cold-modelrun.js";
import { LOCAL_NODE_ID } from "../workload/modelhost-schema.js";
import { loadNodeRunByName } from "../workload/noderun-store.js";
import { defaultWorkloadsDir, loadWorkloadByName } from "../workload/store.js";
import { boundedColdExecutionGroups, type ManagedColdOwnerFactory } from "./cold-owner-mount.js";

type GenerationReader = Awaited<
  ReturnType<typeof openNodeManagedAdmission>
>["readColdResidentGeneration"];
type Provenance = routingCatalog.PeerDeclarationProvenanceV1;

interface ColdRegistration {
  factory: ManagedColdOwnerFactory;
  readPeerDeclarationProvenance: () => Provenance | undefined;
}

function readPolicyRevision(nodeName: string, workloadsDir: string): string | undefined {
  try {
    const node = loadNodeRunByName(nodeName, workloadsDir);
    if (
      node.metadata.name !== nodeName ||
      (node.spec.node !== nodeName && node.spec.node !== LOCAL_NODE_ID)
    )
      return undefined;
    return createHash("sha256").update(JSON.stringify(node.spec)).digest("hex");
  } catch {
    return undefined;
  }
}

async function stageReceipts(
  config: NonNullable<StartAgentOptions["managedColdModelRuns"]>,
  workloadsDir: string,
  execution: ReturnType<typeof boundedColdExecutionGroups>,
): Promise<Map<string, ColdModelArtifactReceipt>> {
  const staged = new Map<string, ColdModelArtifactReceipt>();
  for (const { workload, sha256, maxArtifactBytes } of config) {
    try {
      const manifest = loadWorkloadByName(workload, workloadsDir);
      if (
        manifest.metadata.name !== workload ||
        manifest.spec.node !== LOCAL_NODE_ID ||
        !manifest.spec.enabled ||
        manifest.spec.gateway ||
        manifest.spec.workers.length > 0 ||
        manifest.spec.target.kind !== "rel" ||
        manifest.spec.resources?.expectedMemoryGiB === undefined
      )
        continue;
      const model = prepareManagedColdModelRun(manifest, execution);
      if (model === undefined || !["127.0.0.1", "::1"].includes(model.serving.host)) continue;
      const { rel, modelPath, artifacts } = model.prepared.launch;
      if (rel !== manifest.spec.target.value) continue;
      const receipt = await verifyColdModelArtifactReceipt({
        rel,
        modelPath,
        sha256,
        maxBytes: maxArtifactBytes,
        generationDigest: artifacts.model.generationDigest,
        eligible: true,
      });
      if (receipt !== undefined) staged.set(workload, receipt);
    } catch {
      // Other opted-in workloads can still qualify if this receipt cannot be staged.
    }
  }
  return staged;
}

function liveReceipts(readGeneration: GenerationReader): {
  readResident: (workload: string) => Readonly<LocalModelRunResidentProof> | undefined;
  recordReady: (
    workload: string,
    proof: Readonly<Omit<LocalModelRunResidentProof, "runtimeGeneration">>,
  ) => Promise<void>;
} {
  const committed = new Map<string, Readonly<LocalModelRunResidentProof>>();
  return {
    readResident(workload): Readonly<LocalModelRunResidentProof> | undefined {
      const receipt = committed.get(workload);
      if (receipt === undefined) return undefined;
      const generation = readGeneration(workload, receipt.effectiveSpecDigest);
      return generation?.pid === receipt.pid &&
        generation.runtimeGeneration === receipt.runtimeGeneration
        ? receipt
        : undefined;
    },
    async recordReady(workload, proof): Promise<void> {
      const listenerPid = await findTcpListenerPid(proof.endpoint.host, proof.endpoint.port);
      if (listenerPid !== proof.pid) return;
      const generation = readGeneration(workload, proof.effectiveSpecDigest);
      if (generation?.pid !== proof.pid) return;
      committed.set(
        workload,
        Object.freeze({ ...proof, runtimeGeneration: generation.runtimeGeneration }),
      );
    },
  };
}

function peerEntry(
  nodeName: string,
  entry: routingCatalog.DeclaredModelEntryV1,
  owner: TrustedColdOwner,
  readResident: ReturnType<typeof liveReceipts>["readResident"],
): Provenance["entries"][number] | undefined {
  if (entry.state !== "cold" && entry.state !== "ready") return undefined;
  const pin = owner.pin(entry);
  if (pin === undefined) return undefined;
  const common = {
    id: pin.model,
    workload: pin.workload,
    kind: "ModelRun" as const,
    ownerNodeId: nodeName,
    artifactRevision: pin.artifactRevision,
    policyRevision: pin.policyRevision,
  };
  if (entry.state === "cold") return { ...common, state: "cold" };
  const resident = readResident(pin.workload);
  return resident !== undefined &&
    owner.stillOwns({ pin, runtimeGeneration: resident.runtimeGeneration })
    ? { ...common, state: "ready", deploymentEpoch: resident.runtimeGeneration }
    : undefined;
}

function readPeerProof(
  nodeName: string,
  owner: TrustedColdOwner | undefined,
  readResident: ReturnType<typeof liveReceipts>["readResident"],
): Provenance | undefined {
  if (owner === undefined) return undefined;
  const entries = openaiProxy
    .declaredModelEntries()
    .map((entry) => peerEntry(nodeName, entry, owner, readResident))
    .filter((entry) => entry !== undefined);
  return entries.length === 0 ? undefined : { schemaVersion: 1, entries };
}

export async function registerManagedColdModelRuns(
  opts: StartAgentOptions,
  nodeName: string,
  readGeneration: GenerationReader,
): Promise<ColdRegistration | undefined> {
  if (
    !opts.managedColdModelRuns?.length ||
    opts.noAuth === true ||
    opts.tls === undefined ||
    opts.declaredModels !== true ||
    opts.managedColdOwnerFactory !== undefined
  )
    return undefined;
  const execution = boundedColdExecutionGroups(opts.executionAdmission);
  if (execution.length === 0) return undefined;
  const workloadsDir = defaultWorkloadsDir();
  if (readPolicyRevision(nodeName, workloadsDir) === undefined) return undefined;
  const staged = await stageReceipts(opts.managedColdModelRuns, workloadsDir, execution);
  if (staged.size === 0) return undefined;
  const { readResident, recordReady } = liveReceipts(readGeneration);
  const readReadyRoutes = (model: string): LocalModelRunReadyRoute[] =>
    listLocalRoutes(resolveEnv())
      .filter((route) => route.model === model)
      .map((route) => {
        const proof = readResident(route.workload);
        const leases = getResidencyLeaseRegistry();
        const ready =
          proof?.pid === route.pid &&
          leases?.snapshot(route.workload).phase === "open" &&
          !openaiProxy.servingWithdrawnWorkloads().has(route.workload) &&
          !openaiProxy.servingWarmingModelIds().has(model);
        return { ...route, runtimeGeneration: ready ? proof.runtimeGeneration : "" };
      });
  const factory = createManagedColdModelRunFactory({
    workloadsDir,
    readDeclarations: openaiProxy.declaredModelEntries,
    readArtifactReceipt(rel, workload) {
      const receipt = staged.get(workload);
      return receipt?.rel === rel ? receipt : undefined;
    },
    readTargetPolicyRevision: () => readPolicyRevision(nodeName, workloadsDir),
    readResident,
    readReadyRoutes,
    recordLaunchReady: recordReady,
  });
  let owner: TrustedColdOwner | undefined;
  return {
    factory(context): TrustedColdOwner | undefined {
      owner = factory(context);
      return owner;
    },
    readPeerDeclarationProvenance: () => readPeerProof(nodeName, owner, readResident),
  };
}
