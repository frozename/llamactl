import type { ManagedCapacitySample } from "@llamactl/core/resources/managed-capacity";

import { type routingCatalog, rpcServer } from "@llamactl/core";
import { readModelHostState } from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";
import { resolve } from "node:path";

import type { ValidateParkedCredit } from "../residency/admission-authority.js";
import type { ManagedLaunchAdmission } from "../residency/managed-launch-admission.js";

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
import { listModelHosts } from "../workload/modelhost-store.js";
import { defaultWorkloadsDir } from "../workload/store.js";
import { createNativeOmlxOwner } from "./omlx-native-owner.js";
import { registerManagedColdModelRuns } from "./register-managed-cold-modelruns.js";
import { type RunningAgent, type StartAgentOptions, startAgentServer } from "./serve.js";

const activeRuntimeRoots = new Set<string>();

export interface ManagedAgentDependencies {
  readCapacity?: () => ManagedCapacitySample | undefined;
  nowMs?: () => number;
  onCapacityAudit?: (entry: ManagedCapacityAudit) => void;
  ownerActivity?: StartAgentOptions["managedOwnerActivity"];
  selectEngineTransport?: StartAgentOptions["selectManagedEngineTransport"];
  validateParkedCredit?: ValidateParkedCredit;
}

function logCapacity(entry: ManagedCapacityAudit): void {
  process.stderr.write(JSON.stringify({ event: "managed_capacity", ...entry }) + "\n");
}

function emptyColdInventory(
  opts: StartAgentOptions,
  nodeName: string,
  journalReadable: () => boolean,
): Partial<StartAgentOptions> {
  if (
    opts.tls === undefined ||
    opts.declaredModels !== true ||
    opts.managedColdOwnerFactory !== undefined ||
    opts.peerDeclarationProvenance !== undefined
  )
    return {};
  return {
    peerDeclarationProvenance: (): routingCatalog.PeerEmptyDeclarationInventory | undefined =>
      journalReadable()
        ? { schemaVersion: 2, ownerNodeId: nodeName, complete: true, entries: [] }
        : undefined,
  };
}

async function stageColdModelRuns(
  opts: StartAgentOptions,
  nodeName: string,
  runtime: Awaited<ReturnType<typeof openNodeManagedAdmission>>,
  verifyExclusive: () => void,
  verifyJournals: () => string | undefined,
): Promise<Partial<StartAgentOptions>> {
  if (opts.managedColdModelRuns === undefined) return {};
  if (opts.managedColdModelRuns.length === 0) {
    return emptyColdInventory(
      opts,
      nodeName,
      () => verifyJournals() === undefined && runtime.authority.isOperational(),
    );
  }
  const cold = await registerManagedColdModelRuns(
    opts,
    nodeName,
    runtime.readColdResidentGeneration,
  );
  verifyExclusive();
  const refusal = runtime.verifyActivation();
  if (refusal !== undefined) throw new Error(refusal);
  return cold === undefined
    ? {}
    : {
        managedColdOwnerFactory: cold.factory,
        peerDeclarationProvenance:
          opts.peerDeclarationProvenance ?? cold.readPeerDeclarationProvenance,
      };
}

function stageNativeOmlxOwner(
  opts: StartAgentOptions,
  deps: ManagedAgentDependencies,
  resolved: ReturnType<typeof resolveEnv>,
): ReturnType<typeof createNativeOmlxOwner> | undefined {
  if (!opts.executionAdmission?.length || deps.selectEngineTransport !== undefined)
    return undefined;
  const known = listModelHosts(defaultWorkloadsDir(), () => undefined)
    .filter(({ spec }) => spec.omlxNativeResidency !== undefined)
    .map(({ metadata }) => metadata.name);
  const ports = new Set(
    opts.executionAdmission.flatMap(({ foregroundPorts, backgroundPorts }) => [
      ...foregroundPorts,
      ...backgroundPorts,
    ]),
  );
  return createNativeOmlxOwner(
    known,
    ports,
    (name) => readModelHostState({ name }, resolved)?.requiresOwnerTransport === true,
  );
}

function withNativeOmlxOperators(
  admission: ManagedLaunchAdmission,
  owner: ReturnType<typeof stageNativeOmlxOwner>,
  resolved: ReturnType<typeof resolveEnv>,
): ManagedLaunchAdmission {
  if (owner === undefined) {
    return {
      ...admission,
      readOwnedOmlxStatus: (name): Promise<null | undefined> =>
        Promise.resolve(
          readModelHostState({ name }, resolved)?.requiresOwnerTransport === true
            ? null
            : undefined,
        ),
    };
  }
  return {
    ...admission,
    setNativeOmlxResidency: owner.setNativeResidency.bind(owner),
    verifyParkedOmlxProbe: owner.verifyParked,
    readOwnedOmlxStatus: owner.readOwnedStatus,
  };
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
  if (deps.ownerActivity !== undefined && opts.workerRpc !== undefined)
    throw new Error("ManagedOwnerActivityIngressUnsupported");

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
    const nativeOwner = stageNativeOmlxOwner(opts, deps, resolved);
    const runtime = await openNodeManagedAdmission({
      nodeName,
      aliases: ["local"],
      readCapacity: deps.readCapacity ?? readLocalManagedCapacity,
      onCapacityAudit: deps.onCapacityAudit ?? logCapacity,
      ...(deps.nowMs === undefined ? {} : { nowMs: deps.nowMs }),
      requireExistingStore: journals.prior,
      verifyJournalPair: journals.verify,
      inferenceHolds,
      validateParkedCredit: deps.validateParkedCredit,
      aroundOwnedLifecycle: nativeOwner?.run,
    });
    authority = runtime.authority;
    nativeOwner?.configureParking({
      authority: runtime.authority,
      readLimits: () => runtime.readNativeWakeLimits(),
      readInferenceHold: (name) => inferenceHolds.state(name),
      verifyOwner: (workload) =>
        journals.verify() === undefined &&
        runtime.authority.isOperational() &&
        runtime.admission.allowsProfileServing?.(workload) === true,
    });
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
    const cold = await stageColdModelRuns(
      opts,
      nodeName,
      runtime,
      checkOtherWorkloads,
      journals.verify,
    );
    const running = startAgentServer({
      ...opts,
      ...cold,
      nodeName,
      residencyLeases: true,
      managedLaunchAdmission: withNativeOmlxOperators(runtime.admission, nativeOwner, resolved),
      managedInferenceHolds: inferenceHolds,
      selectManagedEngineTransport: deps.selectEngineTransport ?? nativeOwner?.select,
      selectManagedEngineReadiness: nativeOwner?.readiness,
      ...(deps.ownerActivity === undefined ? {} : { managedOwnerActivity: deps.ownerActivity }),
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
