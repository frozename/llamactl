import { rpcServer } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import {
  hasManagedRuntimeMarker,
  managedRuntimeMarker,
} from "@llamactl/core/residency/managed-runtime";
import { resolve } from "node:path";

import { defaultResidencyStorePath, openResidencyOperationStore } from "../residency/store.js";
import { openNodeManagedAdmission } from "../residency/target-admission-policy.js";
import { existsSync, readFileSync, writeFileSync } from "../safe-fs.js";
import { liveLockHolder } from "../workload/lock.js";
import { defaultWorkloadsDir } from "../workload/store.js";
import { type RunningAgent, type StartAgentOptions, startAgentServer } from "./serve.js";

const activeRuntimeRoots = new Set<string>();

function checkPriorOwner(runtimeDir: string, node: string): void {
  if (
    hasManagedRuntimeMarker(runtimeDir) &&
    readFileSync(managedRuntimeMarker(runtimeDir), "utf8") !== `${node}\n`
  ) {
    throw new Error("ManagedNodeIdentityMismatch");
  }
}

function installMarker(runtimeDir: string, node: string): void {
  try {
    writeFileSync(managedRuntimeMarker(runtimeDir), `${node}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    checkPriorOwner(runtimeDir, node);
  }
}

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
    checkPriorOwner(runtimeDir, nodeName);
    const operationsPath = defaultResidencyStorePath();
    if (hasManagedRuntimeMarker(runtimeDir) && !existsSync(operationsPath)) {
      throw new Error("ManagedTransitionStoreMissing");
    }
    const checkOtherWorkloads = (): void => {
      if (liveLockHolder(defaultWorkloadsDir()) !== null)
        throw new Error("ManagedControllerActive");
      if (existsSync(rpcServer.rpcServerPidFile(resolved)))
        throw new Error("ManagedRpcServerPresent");
    };
    checkOtherWorkloads();
    const runtime = await openNodeManagedAdmission({ nodeName, aliases: ["local"] });
    authority = runtime.authority;
    const refusal = runtime.verifyActivation();
    if (refusal !== undefined) throw new Error(refusal);
    openResidencyOperationStore({ path: operationsPath }).close();
    installMarker(runtimeDir, nodeName);
    checkOtherWorkloads();
    const recheck = runtime.verifyActivation();
    if (recheck !== undefined) throw new Error(recheck);

    const running = startAgentServer({
      ...opts,
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
