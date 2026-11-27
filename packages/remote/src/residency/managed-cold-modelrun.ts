import type { ColdEngineDispatch } from "@llamactl/core/residency/engine-forwarder";

import { server } from "@llamactl/core";
import { createHash } from "node:crypto";

import type { ColdExecutionGroup, ManagedColdOwnerFactory } from "../server/cold-owner-mount.js";
import type { ModelRun } from "../workload/schema.js";
import type { ColdModelArtifactReceipt } from "./cold-artifact-receipt.js";

import { runModelRunStart, ServerStartInputSchema, serverStartOptions } from "../router.js";
import { modelRunStartInvocation } from "../workload/apply.js";
import { residencyGroupLabelOf } from "./coordinator.js";
import {
  createLocalModelRunColdOwner,
  type LocalModelRunColdPlan,
  type LocalModelRunReadyRoute,
  type LocalModelRunResidentProof,
} from "./local-modelrun-cold-owner.js";
import { managedProfileMemberProfiles } from "./managed-profile-selection.js";

export interface ManagedColdModelRunProofs {
  workloadNodeId?: string;
  workloadsDir?: string;
  readDeclarations: () => readonly Readonly<ColdEngineDispatch["declaration"]>[];
  /** Content receipt published before serving, for an explicitly cold-eligible artifact. */
  readArtifactReceipt(rel: string, workload: string): ColdModelArtifactReceipt | undefined;
  /** Fresh revision of the target operator's launch policy, bound to its durable state. */
  readTargetPolicyRevision(): string | undefined;
  readResident: (workload: string) => Readonly<LocalModelRunResidentProof> | undefined;
  readReadyRoutes: (model: string) => readonly Readonly<LocalModelRunReadyRoute>[];
  recordLaunchReady?: (
    workload: string,
    proof: Readonly<Omit<LocalModelRunResidentProof, "runtimeGeneration">>,
  ) => void | Promise<void>;
}

type Invocation = ReturnType<typeof ServerStartInputSchema.parse>;
type ColdPlan = LocalModelRunColdPlan<Invocation>;
const SHA256 = /^[0-9a-f]{64}$/;
const SPLIT_GGUF = /-[0-9]{5}-of-[0-9]{5}\.gguf$/iu;

function oneOption(args: readonly string[], names: readonly string[]): string | undefined {
  let value: string | undefined;
  for (const [index, arg] of args.entries()) {
    const equal = arg.indexOf("=");
    const name = equal === -1 ? arg : arg.slice(0, equal);
    if (!names.includes(name)) continue;
    if (value !== undefined) return undefined;
    value = equal === -1 ? args[index + 1] : arg.slice(equal + 1);
    if (value === undefined || value === "" || value.startsWith("-")) return undefined;
  }
  return value;
}

function positiveInteger(text: string | undefined): number | undefined {
  if (text === undefined || !/^[1-9][0-9]*$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

function servingSpec(
  args: readonly string[],
): { host: string; port: number; contextTokens: number; parallel: number } | undefined {
  const host = oneOption(args, ["--host"]);
  const port = positiveInteger(oneOption(args, ["--port"]));
  const context = positiveInteger(oneOption(args, ["-c", "--ctx-size"]));
  const parallel = positiveInteger(oneOption(args, ["-np", "--parallel"]));
  if (host === undefined || port === undefined || context === undefined || parallel === undefined) {
    return undefined;
  }
  const contextTokens = Math.floor(context / parallel);
  return contextTokens > 0 ? { host, port, contextTokens, parallel } : undefined;
}

function policyRevision(
  targetRevision: string,
  manifest: Readonly<ModelRun>,
  group: Readonly<ColdExecutionGroup>,
): string {
  const policy = [
    targetRevision,
    manifest.spec.resources?.expectedMemoryGiB,
    managedProfileMemberProfiles(manifest.metadata.annotations).sort(),
    residencyGroupLabelOf(manifest.metadata.labels),
    group.name,
    [...group.foregroundPorts].sort((a, b) => a - b),
    [...group.backgroundPorts].sort((a, b) => a - b),
    group.foregroundConcurrency,
    group.maxQueued,
    group.maxQueuedBytes,
    group.maxPerPrincipal,
    group.maxQueueWaitMs,
    group.starvationBoundMs,
    group.maxContextTokens,
    group.maxCompletionTokens,
  ];
  return `sha256:${createHash("sha256").update(JSON.stringify(policy)).digest("hex")}`;
}

export function prepareManagedColdModelRun(
  manifest: Readonly<ModelRun>,
  groups: readonly Readonly<ColdExecutionGroup>[],
):
  | {
      invocation: Invocation;
      prepared: server.PreparedManagedServerStart;
      serving: NonNullable<ReturnType<typeof servingSpec>>;
      group: Readonly<ColdExecutionGroup>;
    }
  | undefined {
  const parsed = ServerStartInputSchema.safeParse(modelRunStartInvocation(manifest));
  if (!parsed.success) return undefined;
  const invocation = parsed.data;
  const prepared = server.prepareManagedServerStart(serverStartOptions(invocation));
  if ("result" in prepared) return undefined;
  // The receipt covers one GGUF, and the serving bounds come from argv before any projector retry.
  if (prepared.additionalModelInputs || SPLIT_GGUF.test(prepared.launch.rel)) return undefined;
  const serving = servingSpec(prepared.launch.args);
  if (serving === undefined) return undefined;
  const group = groups.find(
    (candidate) =>
      candidate.foregroundPorts.includes(serving.port) ||
      candidate.backgroundPorts.includes(serving.port),
  );
  if (
    group === undefined ||
    group.maxContextTokens > serving.contextTokens ||
    group.foregroundConcurrency > serving.parallel
  ) {
    return undefined;
  }
  return { invocation, prepared, serving, group };
}

function compileColdPlan(
  manifest: Readonly<ModelRun>,
  proofs: ManagedColdModelRunProofs,
  groups: readonly Readonly<ColdExecutionGroup>[],
): ColdPlan | undefined {
  const receipt = proofs.readArtifactReceipt(manifest.spec.target.value, manifest.metadata.name);
  const targetPolicy = proofs.readTargetPolicyRevision();
  if (receipt === undefined || targetPolicy === undefined || !SHA256.test(targetPolicy))
    return undefined;
  const plan = prepareManagedColdModelRun(manifest, groups);
  if (plan === undefined) return undefined;
  const {
    invocation,
    prepared: { launch, effectiveSpecDigest },
    serving,
    group,
  } = plan;
  if (
    receipt.rel !== launch.rel ||
    receipt.generationDigest !== launch.artifacts.model.generationDigest ||
    !SHA256.test(receipt.sha256)
  )
    return undefined;
  return {
    launch: invocation,
    effectiveSpecDigest,
    artifactRel: launch.rel,
    artifactRevision: `sha256:${receipt.sha256}`,
    policyRevision: policyRevision(targetPolicy, manifest, group),
    endpoint: { host: serving.host, port: serving.port },
    contextTokens: serving.contextTokens,
  };
}

/** The owner supplies durable, generation-bound proofs before mounting cold inference. */
export function createManagedColdModelRunFactory(
  proofs: ManagedColdModelRunProofs,
): ManagedColdOwnerFactory {
  return ({ ownerNodeId, managed, executionGroups }) =>
    createLocalModelRunColdOwner({
      ownerNodeId,
      ...(proofs.workloadNodeId === undefined ? {} : { workloadNodeId: proofs.workloadNodeId }),
      ...(proofs.workloadsDir === undefined ? {} : { workloadsDir: proofs.workloadsDir }),
      readDeclarations: proofs.readDeclarations,
      readResident: proofs.readResident,
      readReadyRoutes: proofs.readReadyRoutes,
      compile: (manifest) => compileColdPlan(manifest, proofs, executionGroups),
      async launchManaged(plan, { pin, signal, stillCurrent }) {
        const outcome = await runModelRunStart(plan.launch, signal, () => undefined, managed, {
          effectiveSpecDigest: plan.effectiveSpecDigest,
          stillCurrent,
        });
        if (!outcome.ran)
          return { kind: outcome.detail === "ManagedReadyUnverified" ? "uncertain" : "refused" };
        if (!outcome.result.ok || outcome.result.pid === null) return { kind: "uncertain" };
        await proofs.recordLaunchReady?.(pin.workload, {
          pid: outcome.result.pid,
          effectiveSpecDigest: plan.effectiveSpecDigest,
          artifactRevision: plan.artifactRevision,
          policyRevision: plan.policyRevision,
          contextTokens: plan.contextTokens,
          endpoint: plan.endpoint,
        });
        const committed = proofs.readResident(pin.workload);
        return committed?.pid === outcome.result.pid
          ? { kind: "ready", runtimeGeneration: committed.runtimeGeneration }
          : { kind: "uncertain" };
      },
    });
}
