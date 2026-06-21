import type { ModelHostManifest } from "@llamactl/remote/workload/modelhost-schema";

import {
  config as kubecfg,
  workloadApply,
  type workloadSchema,
  workloadStore,
} from "@llamactl/remote";
import { applyOneModelHost } from "@llamactl/remote/workload/apply";
import { loadModelHostByName, saveModelHost } from "@llamactl/remote/workload/modelhost-store";

import { getNodeClientByName } from "../dispatcher.js";

export interface SetEnabledResult {
  code: number;
  message?: string;
}

export interface SetEnabledDeps {
  loadWorkloadByName?: typeof workloadStore.loadWorkloadByName;
  saveWorkload?: typeof workloadStore.saveWorkload;
  applyOne?: typeof workloadApply.applyOne;
  loadModelHostByName?: typeof loadModelHostByName;
  saveModelHost?: typeof saveModelHost;
  applyOneModelHost?: typeof applyOneModelHost;
  loadConfig?: typeof kubecfg.loadConfig;
  resolveNode?: typeof kubecfg.resolveNode;
  getNodeClientByName?: typeof getNodeClientByName;
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
): Promise<string | null> {
  const applyOne = deps.applyOne ?? workloadApply.applyOne;
  const loadConfig = deps.loadConfig ?? kubecfg.loadConfig;
  const resolveNode = deps.resolveNode ?? kubecfg.resolveNode;
  const getClient = deps.getNodeClientByName ?? getNodeClientByName;
  (deps.saveWorkload ?? workloadStore.saveWorkload)(manifest);
  const cfg = loadConfig();
  const result = await applyOne(manifest, (n) => getClient(n), undefined, undefined, {
    resolveNodeIdentity: (n) => {
      try {
        return resolveNode(cfg, n).node.endpoint || null;
      } catch {
        return null;
      }
    },
  });
  return result.error ?? null;
}

async function applyModelHostManifest(
  manifest: ModelHostManifest,
  deps: SetEnabledDeps,
): Promise<string | null> {
  const getClient = deps.getNodeClientByName ?? getNodeClientByName;
  (deps.saveModelHost ?? saveModelHost)(manifest);
  const outcome = await (deps.applyOneModelHost ?? applyOneModelHost)(manifest, (n) =>
    getClient(n),
  );
  return outcome.ok ? null : outcome.error;
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

  const errMsg =
    manifest.kind === "ModelRun"
      ? await applyModelRunManifest(manifest, deps)
      : await applyModelHostManifest(manifest, deps);

  if (errMsg) {
    return { code: 1, message: `${enabled ? "enable" : "disable"}: ${errMsg}\n` };
  }

  return {
    code: 0,
    message: `${enabled ? "enabled" : "disabled"} ${manifest.kind.toLowerCase()}/${name}\n`,
  };
}

export async function setWorkloadEnabled(
  name: string,
  enabled: boolean,
): Promise<SetEnabledResult> {
  return await setWorkloadEnabledWithDeps(name, enabled);
}
