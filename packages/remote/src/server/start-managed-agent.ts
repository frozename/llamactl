import { rpcServer } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { resolve } from "node:path";

import { manageJournalPair } from "../residency/managed-journals.js";
import { defaultResidencyStorePath, openResidencyOperationStore } from "../residency/store.js";
import { openNodeManagedAdmission } from "../residency/target-admission-policy.js";
import { existsSync } from "../safe-fs.js";
import { liveLockHolder } from "../workload/lock.js";
import { defaultWorkloadsDir } from "../workload/store.js";
import { registerManagedColdModelRuns } from "./register-managed-cold-modelruns.js";
import { type RunningAgent, type StartAgentOptions, startAgentServer } from "./serve.js";

const activeRuntimeRoots = new Set<string>();

export async function startManagedAgentServer(
  opts: StartAgentOptions,
  nodeName: string | undefined,
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
      requireExistingStore: journals.prior,
      verifyJournalPair: journals.verify,
    });
    authority = runtime.authority;
    const refusal = runtime.verifyActivation();
    if (refusal !== undefined) throw new Error(refusal);
    openResidencyOperationStore({
      path: operationsPath,
      requireExisting: journals.prior,
    }).close();
    journals.install();
    checkOtherWorkloads();
    const recheck = runtime.verifyActivation();
    if (recheck !== undefined) throw new Error(recheck);
    const cold = opts.managedColdModelRuns?.length
      ? await registerManagedColdModelRuns(opts, nodeName, runtime.readColdResidentGeneration)
      : undefined;
    if (opts.managedColdModelRuns?.length) {
      checkOtherWorkloads();
      const afterStaging = runtime.verifyActivation();
      if (afterStaging !== undefined) throw new Error(afterStaging);
    }

    const running = startAgentServer({
      ...opts,
      ...(cold === undefined
        ? {}
        : {
            managedColdOwnerFactory: cold.factory,
            peerDeclarationProvenance:
              opts.peerDeclarationProvenance ?? cold.readPeerDeclarationProvenance,
          }),
      nodeName,
      residencyLeases: true,
      managedLaunchAdmission: runtime.admission,
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
