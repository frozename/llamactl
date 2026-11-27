import type { ManagedCapacitySample } from "@llamactl/core/resources/managed-capacity";

import { rpcServer } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { resolve } from "node:path";

import { createDurableInferenceHolds } from "../residency/inference-holds.js";
import { readLocalManagedCapacity } from "../residency/local-managed-capacity.js";
import { manageJournalPair } from "../residency/managed-journals.js";
import { defaultResidencyStorePath, openResidencyOperationStore } from "../residency/store.js";
import {
  type ManagedCapacityAudit,
  openNodeManagedAdmission,
} from "../residency/target-admission-policy.js";
import { existsSync } from "../safe-fs.js";
import { liveLockHolder } from "../workload/lock.js";
import { defaultWorkloadsDir } from "../workload/store.js";
import { type RunningAgent, type StartAgentOptions, startAgentServer } from "./serve.js";

const activeRuntimeRoots = new Set<string>();

export interface ManagedAgentDependencies {
  readCapacity?: () => ManagedCapacitySample | undefined;
  nowMs?: () => number;
  onCapacityAudit?: (entry: ManagedCapacityAudit) => void;
}

function logCapacity(entry: ManagedCapacityAudit): void {
  process.stderr.write(JSON.stringify({ event: "managed_capacity", ...entry }) + "\n");
}

export async function startManagedAgentServer(
  opts: StartAgentOptions,
  nodeName: string | undefined,
  deps: ManagedAgentDependencies = {},
): Promise<RunningAgent> {
  if (nodeName === undefined || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(nodeName)) {
    throw new Error("ManagedNodeIdentityRequired");
  }
  if (opts.noAuth === true) throw new Error("ManagedAgentAuthenticationRequired");

  const resolved = resolveEnv();
  const runtimeDir = resolve(resolved.LOCAL_AI_RUNTIME_DIR);
  if (activeRuntimeRoots.has(runtimeDir)) throw new Error("ManagedAgentAlreadyActive");
  activeRuntimeRoots.add(runtimeDir);
  let authority: Awaited<ReturnType<typeof openNodeManagedAdmission>>["authority"] | undefined;
  try {
    const operationsPath = defaultResidencyStorePath();
    const journals = manageJournalPair(runtimeDir, operationsPath, nodeName);
    const inferenceHolds = createDurableInferenceHolds({
      path: operationsPath,
      verifyJournal: journals.verify,
    });
    const missing = journals.verify();
    if (missing !== undefined) throw new Error(missing);
    const checkOtherWorkloads = (): void => {
      if (liveLockHolder(defaultWorkloadsDir()) !== null)
        throw new Error("ManagedControllerActive");
      if (existsSync(rpcServer.rpcServerPidFile(resolved)))
        throw new Error("ManagedRpcServerPresent");
    };
    checkOtherWorkloads();
    const runtime = await openNodeManagedAdmission({
      nodeName,
      aliases: ["local"],
      readCapacity: deps.readCapacity ?? readLocalManagedCapacity,
      onCapacityAudit: deps.onCapacityAudit ?? logCapacity,
      ...(deps.nowMs === undefined ? {} : { nowMs: deps.nowMs }),
      requireExistingStore: journals.prior,
      verifyJournalPair: journals.verify,
      inferenceHolds,
    });
    authority = runtime.authority;
    const refusal = runtime.verifyActivation();
    if (refusal !== undefined) throw new Error(refusal);
    openResidencyOperationStore({
      path: operationsPath,
      requireExisting: journals.prior,
    }).close();
    journals.install();
    if (!inferenceHolds.initialize()) throw new Error("ManagedInferenceJournalUnavailable");
    checkOtherWorkloads();
    const recheck = runtime.verifyActivation();
    if (recheck !== undefined) throw new Error(recheck);

    const running = startAgentServer({
      ...opts,
      nodeName,
      residencyLeases: true,
      managedLaunchAdmission: runtime.admission,
      managedInferenceHolds: inferenceHolds,
    });
    return {
      ...running,
      async stop(): Promise<void> {
        await running.stop();
        runtime.authority.close();
        activeRuntimeRoots.delete(runtimeDir);
      },
    };
  } catch (error) {
    authority?.close();
    activeRuntimeRoots.delete(runtimeDir);
    throw error;
  }
}
