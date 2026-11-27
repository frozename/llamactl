import type { ModelHostManifest } from "@llamactl/remote/workload/modelhost-schema";

import { resolveEnv } from "@llamactl/core/env";
import { hasManagedRuntimeMarker } from "@llamactl/core/residency/managed-runtime";
import {
  config as kubecfg,
  type noderunStore,
  workloadApply,
  type workloadSchema,
  workloadStore,
} from "@llamactl/remote";
import {
  type AdmissionRefusalReason,
  admissionRefusalReason,
  applyOneModelHost,
} from "@llamactl/remote/workload/apply";
import { loadModelHostByName, saveModelHost } from "@llamactl/remote/workload/modelhost-store";

import {
  getAuthenticatedAgentClientByName,
  getGlobals,
  getNodeClientByName,
} from "../dispatcher.js";
import { nodeRunBudgetLookup, nodeRunResidencyLookup } from "./noderun-helpers.js";

export interface SetEnabledResult {
  code: number;
  message?: string;
  /** #274: set when the apply failed on an admission refusal. */
  reason?: AdmissionRefusalReason;
}

interface ApplyFailure {
  error: string;
  reason?: AdmissionRefusalReason;
}

export interface SetEnabledDeps {
  loadWorkloadByName?: typeof workloadStore.loadWorkloadByName | undefined;
  saveWorkload?: typeof workloadStore.saveWorkload | undefined;
  applyOne?: typeof workloadApply.applyOne | undefined;
  loadModelHostByName?: typeof loadModelHostByName | undefined;
  saveModelHost?: typeof saveModelHost | undefined;
  applyOneModelHost?: typeof applyOneModelHost | undefined;
  loadConfig?: typeof kubecfg.loadConfig | undefined;
  resolveNode?: typeof kubecfg.resolveNode | undefined;
  getNodeClientByName?: typeof getNodeClientByName | undefined;
  listNodeRuns?: typeof noderunStore.listNodeRuns | undefined;
}

function loadManifest(
  name: string,
  deps: SetEnabledDeps,
): workloadSchema.ModelRun | ModelHostManifest | null {
  const loadWorkload = deps.loadWorkloadByName ?? workloadStore.loadWorkloadByName;
  try {
    return loadWorkload(name);
  } catch {
    try {
      return (deps.loadModelHostByName ?? loadModelHostByName)(name);
    } catch {
      return null;
    }
  }
}

async function applyModelRunManifest(
  manifest: workloadSchema.ModelRun,
  deps: SetEnabledDeps,
): Promise<ApplyFailure | null> {
  const applyOne = deps.applyOne ?? workloadApply.applyOne;
  const loadConfig = deps.loadConfig ?? kubecfg.loadConfig;
  const resolveNode = deps.resolveNode ?? kubecfg.resolveNode;
  const getClient = deps.getNodeClientByName ?? getNodeClientByName;
  const save = deps.saveWorkload ?? workloadStore.saveWorkload;
  if (!manifest.spec.enabled) save(manifest);
  const cfg = loadConfig();
  const result = await applyOne(manifest, (n) => getClient(n), undefined, undefined, {
    resolveNodeIdentity: (n) => {
      try {
        return resolveNode(cfg, n).node.endpoint || null;
      } catch {
        return null;
      }
    },
    getNodeBudgetGiB: nodeRunBudgetLookup(deps.listNodeRuns),
    getNodeResidency: nodeRunResidencyLookup(deps.listNodeRuns),
  });
  if (manifest.spec.enabled && !result.error) save(manifest);
  if (!result.error) return null;
  const reason = admissionRefusalReason(result);
  return { error: result.error, ...(reason !== undefined ? { reason } : {}) };
}

async function applyModelHostManifest(
  manifest: ModelHostManifest,
  deps: SetEnabledDeps,
): Promise<ApplyFailure | null> {
  const getClient = deps.getNodeClientByName ?? getNodeClientByName;
  const save = deps.saveModelHost ?? saveModelHost;
  if (!manifest.spec.enabled) save(manifest);
  const outcome = await (deps.applyOneModelHost ?? applyOneModelHost)(
    manifest,
    (n) => getClient(n),
    undefined,
    {
      getNodeBudgetGiB: nodeRunBudgetLookup(deps.listNodeRuns),
      getNodeResidency: nodeRunResidencyLookup(deps.listNodeRuns),
    },
  );
  if (manifest.spec.enabled && outcome.ok) save(manifest);
  if (outcome.ok) return null;
  return {
    error: outcome.error,
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
  };
}

export async function setWorkloadEnabledWithDeps(
  name: string,
  enabled: boolean,
  deps: SetEnabledDeps = {},
): Promise<SetEnabledResult> {
  const manifest = loadManifest(name, deps);
  if (!manifest) {
    return {
      code: 1,
      message: `${enabled ? "enable" : "disable"}: workload not found: ${name}\n`,
    };
  }

  manifest.spec.enabled = enabled;

  const failure =
    manifest.kind === "ModelRun"
      ? await applyModelRunManifest(manifest, deps)
      : await applyModelHostManifest(manifest, deps);

  if (failure) {
    const verb = enabled ? "enable" : "disable";
    const reasonLine =
      failure.reason !== undefined ? `${verb}: admission refused: ${failure.reason}\n` : "";
    return {
      code: 1,
      message: `${verb}: ${failure.error}\n${reasonLine}`,
      ...(failure.reason !== undefined ? { reason: failure.reason } : {}),
    };
  }

  return {
    code: 0,
    message: `${enabled ? "enabled" : "disabled"} ${manifest.kind.toLowerCase()}/${name}\n`,
  };
}

export async function setManagedWorkloadEnabled(
  name: string,
  enabled: boolean,
  ownerClient: typeof getAuthenticatedAgentClientByName = getAuthenticatedAgentClientByName,
): Promise<SetEnabledResult> {
  const verb = enabled ? "enable" : "disable";
  const globals = getGlobals();
  const node = globals.nodeName;
  if (!node || node === "local" || node === "all") {
    return { code: 1, message: `${verb}: --managed requires --node <owner>\n` };
  }
  try {
    const result = await ownerClient(node, globals).managedWorkloadSetEnabled.mutate({
      workload: name,
      enabled,
    });
    return { code: 0, message: `${result.action} ${result.name} on ${node}\n` };
  } catch (error) {
    return {
      code: 1,
      message: `${verb}: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

export async function setWorkloadEnabled(
  name: string,
  enabled: boolean,
): Promise<SetEnabledResult> {
  if (hasManagedRuntimeMarker(resolveEnv().LOCAL_AI_RUNTIME_DIR)) {
    return { code: 1, message: "use --managed --node <owner> to change this managed workload\n" };
  }
  return await setWorkloadEnabledWithDeps(name, enabled);
}
