import { config as kubecfg, workloadApply, workloadSchema, workloadStore } from "@llamactl/remote";
import { applyOneModelHost } from "../../../remote/src/workload/apply.js";
import type { ModelHostManifest } from "../../../remote/src/workload/modelhost-schema.js";
import {
  loadModelHostByName,
  saveModelHost,
} from "../../../remote/src/workload/modelhost-store.js";
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

export async function setWorkloadEnabledWithDeps(
  name: string,
  enabled: boolean,
  deps: SetEnabledDeps = {},
): Promise<SetEnabledResult> {
  const loadWorkloadByName = deps.loadWorkloadByName ?? workloadStore.loadWorkloadByName;
  const saveWorkload = deps.saveWorkload ?? workloadStore.saveWorkload;
  const applyOne = deps.applyOne ?? workloadApply.applyOne;
  const loadConfig = deps.loadConfig ?? kubecfg.loadConfig;
  const resolveNode = deps.resolveNode ?? kubecfg.resolveNode;
  const getClient = deps.getNodeClientByName ?? getNodeClientByName;

  let manifest: workloadSchema.ModelRun | ModelHostManifest;
  try {
    manifest = loadWorkloadByName(name);
  } catch {
    try {
      manifest = (deps.loadModelHostByName ?? loadModelHostByName)(name);
    } catch {
      return {
        code: 1,
        message: `${enabled ? "enable" : "disable"}: workload not found: ${name}\n`,
      };
    }
  }

  manifest.spec.enabled = enabled;

  let errMsg: string | null = null;
  if (manifest.kind === "ModelRun") {
    (deps.saveWorkload ?? saveWorkload)(manifest);
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
    errMsg = result.error ?? null;
  } else {
    (deps.saveModelHost ?? saveModelHost)(manifest);
    const outcome = await (deps.applyOneModelHost ?? applyOneModelHost)(manifest, (n) =>
      getClient(n),
    );
    errMsg = outcome.ok ? null : outcome.error;
  }

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
  return setWorkloadEnabledWithDeps(name, enabled);
}
