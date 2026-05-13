import {
  config as kubecfg,
  workloadApply,
  workloadSchema,
  workloadStore,
} from '@llamactl/remote';
import { getNodeClientByName } from '../dispatcher.js';

export interface SetEnabledResult {
  code: number;
  message?: string;
}

export interface SetEnabledDeps {
  loadWorkloadByName?: typeof workloadStore.loadWorkloadByName;
  saveWorkload?: typeof workloadStore.saveWorkload;
  applyOne?: typeof workloadApply.applyOne;
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

  let manifest: workloadSchema.ModelRun;
  try {
    manifest = loadWorkloadByName(name);
  } catch {
    return { code: 1, message: `${enabled ? 'enable' : 'disable'}: workload not found: ${name}\n` };
  }

  manifest.spec.enabled = enabled;
  saveWorkload(manifest);

  const cfg = loadConfig();
  const result = await applyOne(
    manifest,
    (n) => getClient(n),
    undefined,
    undefined,
    {
      resolveNodeIdentity: (n) => {
        try {
          return resolveNode(cfg, n).node.endpoint || null;
        } catch {
          return null;
        }
      },
    },
  );

  if (result.error) {
    return { code: 1, message: `${enabled ? 'enable' : 'disable'}: ${result.error}\n` };
  }

  return {
    code: 0,
    message: `${enabled ? 'enabled' : 'disabled'} modelrun/${name}\n`,
  };
}

export async function setWorkloadEnabled(
  name: string,
  enabled: boolean,
): Promise<SetEnabledResult> {
  return setWorkloadEnabledWithDeps(name, enabled);
}
