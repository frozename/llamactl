import { server } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { getResidencyLeaseRegistry } from "@llamactl/core/residency/leases";

import type { InferenceHolds } from "../../src/residency/inference-holds.js";
import type { ManagedLaunchAdmission } from "../../src/residency/managed-launch-admission.js";
import type { StartAgentOptions } from "../../src/server/serve.js";
import type { ManagedAgentDependencies } from "../../src/server/start-managed-agent.js";

import { createDurableInferenceHolds } from "../../src/residency/inference-holds.js";
import { manageJournalPair } from "../../src/residency/managed-journals.js";
import {
  defaultResidencyStorePath,
  openResidencyOperationStore,
} from "../../src/residency/store.js";
import { openNodeManagedAdmission } from "../../src/residency/target-admission-policy.js";
import { runModelRunStart, ServerStartInputSchema } from "../../src/router.js";
import { writeFileSync } from "../../src/safe-fs.js";
import { hashToken } from "../../src/server/auth.js";
import { startAgentServer } from "../../src/server/serve.js";
import { startManagedAgentServer } from "../../src/server/start-managed-agent.js";
import { modelRunStartInvocation } from "../../src/workload/apply.js";
import { loadWorkloadByName } from "../../src/workload/store.js";

const capacity: ManagedAgentDependencies = {
  nowMs: () => 100_000,
  onCapacityAudit: () => undefined,
  readCapacity: () => ({
    source: "linux-procfs",
    observedAtMs: 100_000,
    physicalBytes: 64 * 1024 ** 3,
    availableBytes: 48 * 1024 ** 3,
    scope: { kind: "host-physical" },
    pressure: "normal",
    swapUsedBytes: 0,
  }),
};
const token = "fixture-publication-token";
const requestHeaders = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};

function control(
  url: string,
  action: "load" | "unload",
  node: string,
  workload: string,
  drainTimeoutMs?: number,
): Promise<Response> {
  return fetch(`${url}/trpc/residencyControl`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ action, node, workload, dryRun: false, confirm: true, drainTimeoutMs }),
  });
}

function servingOptions(workload: string): StartAgentOptions {
  const port = loadWorkloadByName(workload).spec.endpoint?.port;
  if (port === undefined) throw new Error("missing fixture engine port");
  return {
    bindHost: "127.0.0.1",
    port: 0,
    tokenHash: hashToken(token),
    advertiseMdns: false,
    declaredModels: true,
    executionAdmission: [
      {
        name: "fixture-engine",
        foregroundPorts: [port],
        backgroundPorts: [port === 65535 ? port - 1 : port + 1],
        foregroundConcurrency: 1,
        maxQueued: 4,
        maxQueuedBytes: 4096,
        maxPerPrincipal: 4,
        maxQueueWaitMs: 2000,
        starvationBoundMs: 2000,
        maxContextTokens: 128,
        maxCompletionTokens: 8,
      },
    ],
  };
}

async function admitHeldStream(
  url: string,
  workload: string,
): Promise<{ cancel: () => Promise<void> }> {
  const response = await fetch(`${url}/v1/completions`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      model: loadWorkloadByName(workload).spec.target.value,
      prompt: [1, 2],
      max_tokens: 3,
      stream: true,
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok || response.body === null)
    throw new Error(`fixture inference was refused: ${await response.text()}`);
  const reader = response.body.getReader();
  const first = await reader.read();
  if (!new TextDecoder().decode(first.value).includes("fixture-stream-prefix"))
    throw new Error("missing live engine stream");
  return reader;
}

async function crashAtStopBoundary(
  stage: "drain" | "release",
  nodeName: string,
  workload: string,
  ownerAdmission: ManagedLaunchAdmission,
  inferenceHolds: InferenceHolds,
  crash: (pid: number | null, drain?: unknown) => never,
): Promise<void> {
  const admission: ManagedLaunchAdmission = {
    ...ownerAdmission,
    prepareStopRelease: (key, kind) => {
      const proof = ownerAdmission.prepareStopRelease?.(key, kind);
      return stage === "release" && proof !== undefined ? { ...proof, release: crash } : proof;
    },
  };
  const running = startAgentServer({
    ...servingOptions(workload),
    nodeName,
    residencyLeases: true,
    managedLaunchAdmission: admission,
    managedInferenceHolds: inferenceHolds,
  });
  try {
    const reader = stage === "drain" ? await admitHeldStream(running.url, workload) : undefined;
    if (reader !== undefined) {
      const registry = getResidencyLeaseRegistry();
      if (registry === null) throw new Error("missing mounted residency registry");
      const whenIdle = registry.whenIdle.bind(registry);
      registry.whenIdle = (drain, options): ReturnType<typeof whenIdle> => {
        const waiting = whenIdle(drain, options);
        const snapshot = registry.snapshot(drain.workload);
        if (snapshot.waiters > 0) crash(server.readServerPid({ name: workload }), snapshot);
        return waiting;
      };
    }
    const unload = await control(
      running.url,
      "unload",
      nodeName,
      workload,
      stage === "drain" ? 2_000 : undefined,
    );
    await reader?.cancel();
    throw new Error(`fixture returned before the stop fault: ${await unload.text()}`);
  } finally {
    await running.stop();
  }
}

async function crashManagedLifecycle(
  stage: "dispatch" | "launch" | "ready" | "drain" | "release",
  nodeName: string,
  workload: string,
  report: (value: unknown) => void,
): Promise<void> {
  const runtimeDir = resolveEnv().LOCAL_AI_RUNTIME_DIR;
  const operationsPath = defaultResidencyStorePath();
  const journals = manageJournalPair(runtimeDir, operationsPath, nodeName);
  const inferenceHolds = createDurableInferenceHolds({
    path: operationsPath,
    verifyJournal: journals.verify,
  });
  const owner = await openNodeManagedAdmission({
    ...capacity,
    nodeName,
    aliases: ["local"],
    inferenceHolds,
    verifyJournalPair: journals.verify,
  });
  try {
    openResidencyOperationStore({ path: operationsPath }).close();
    journals.install();
    if (!inferenceHolds.initialize()) throw new Error("fixture inference journal unavailable");
    const crash = (pid: number | null, drain?: unknown): never => {
      const key = { name: workload };
      report({
        pid,
        recordedPid: server.readServerPid(key),
        state: server.readServerState(key),
        claims: owner.authority.snapshot(),
        inferenceHold: inferenceHolds.state(workload),
        ...(drain === undefined ? {} : { drain }),
      });
      process.kill(process.pid, "SIGKILL");
      throw new Error("fixture survived SIGKILL");
    };
    if (stage === "dispatch") {
      const admit = owner.authority.admit.bind(owner.authority);
      owner.authority.admit = (request): ReturnType<typeof admit> => {
        const result = admit(request);
        if (result.kind === "admitted") crash(null);
        return result;
      };
    }
    const crashOnReady: ManagedLaunchAdmission["run"] = (request, signal, start) =>
      owner.admission.run(request, signal, (commit, checkSpawn) =>
        start((pid) => commit(pid) ?? crash(pid), checkSpawn),
      );
    const managed = stage === "ready" ? { ...owner.admission, run: crashOnReady } : owner.admission;
    const input = ServerStartInputSchema.parse({
      ...modelRunStartInvocation(loadWorkloadByName(workload)),
      timeoutSeconds: 5,
    });
    const attempted = await runModelRunStart(
      input,
      new AbortController().signal,
      (event) => {
        if (stage === "launch" && event.type === "launch") crash(event.pid);
      },
      managed,
    );
    if ((stage === "drain" || stage === "release") && attempted.ran && attempted.result.ok) {
      await crashAtStopBoundary(stage, nodeName, workload, owner.admission, inferenceHolds, crash);
    }
    throw new Error(`fixture returned before the fault: ${JSON.stringify(attempted)}`);
  } finally {
    owner.authority.close();
  }
}

async function inspectRecoveredOwner(
  nodeName: string,
  workload: string,
  report: (value: unknown) => void,
  fault: string | undefined,
): Promise<void> {
  const manifest = loadWorkloadByName(workload);
  const running = await startManagedAgentServer(servingOptions(workload), nodeName, capacity);
  try {
    const headers = requestHeaders;
    const routes = await fetch(`${running.url}/v1/fleet/snapshot?include=local-routes`, {
      headers,
    });
    const statusUrl = new URL("/trpc/residencyStatus", running.url);
    statusUrl.searchParams.set("input", JSON.stringify({ node: nodeName }));
    const status = await fetch(statusUrl, { headers });
    const model = manifest.spec.target.value;
    const completion = await fetch(`${running.url}/v1/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, prompt: [1, 2], max_tokens: 3 }),
    });
    const replacement = await control(running.url, "load", nodeName, `${workload}-replacement`);
    const unload =
      fault === "drain" ? await control(running.url, "unload", nodeName, workload) : undefined;
    const statusBody: unknown = await status.json();
    const replacementBody: unknown = await replacement.json();
    const routesBody: unknown =
      routes.ok && routes.status !== 204 ? await routes.json() : await routes.text();
    const unloadBody: unknown = await unload?.json();
    report({
      routes: {
        status: routes.status,
        body: routesBody,
      },
      status: { status: status.status, body: statusBody },
      completion: { status: completion.status, body: await completion.text() },
      replacement: { status: replacement.status, body: replacementBody },
      ...(unload === undefined ? {} : { unload: { status: unload.status, body: unloadBody } }),
    });
  } finally {
    await running.stop();
  }
}

const [mode, nodeName, workload, reportPath, fault] = Bun.argv.slice(2);
if (nodeName === undefined || workload === undefined || reportPath === undefined) {
  throw new Error("expected publication fixture arguments");
}
const report = (value: unknown): void => {
  writeFileSync(reportPath, JSON.stringify(value));
};
try {
  if (
    mode === "dispatch" ||
    mode === "launch" ||
    mode === "ready" ||
    mode === "drain" ||
    mode === "release"
  )
    await crashManagedLifecycle(mode, nodeName, workload, report);
  else if (mode === "recover") await inspectRecoveredOwner(nodeName, workload, report, fault);
  else throw new Error("expected publication fixture mode");
} catch (error) {
  report({ error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
