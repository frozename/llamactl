import { server } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";

import type { ManagedLaunchAdmission } from "../../src/residency/managed-launch-admission.js";
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

async function crashManagedStart(
  stage: "launch" | "ready",
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
    const crash = (pid: number): never => {
      const key = { name: workload };
      report({
        pid,
        recordedPid: server.readServerPid(key),
        state: server.readServerState(key),
        claims: owner.authority.snapshot(),
      });
      process.kill(process.pid, "SIGKILL");
      throw new Error("fixture survived SIGKILL");
    };
    const crashOnReady: ManagedLaunchAdmission["run"] = (request, signal, start) =>
      owner.admission.run(request, signal, (commit, checkSpawn) =>
        start((pid) => commit(pid) ?? crash(pid), checkSpawn),
      );
    const managed =
      stage === "launch" ? owner.admission : { ...owner.admission, run: crashOnReady };
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
    throw new Error(`fixture returned before the fault: ${JSON.stringify(attempted)}`);
  } finally {
    owner.authority.close();
  }
}

async function inspectRecoveredOwner(
  nodeName: string,
  workload: string,
  report: (value: unknown) => void,
): Promise<void> {
  const token = "fixture-publication-token";
  const manifest = loadWorkloadByName(workload);
  const port = manifest.spec.endpoint?.port;
  if (port === undefined) throw new Error("missing fixture engine port");
  const running = await startManagedAgentServer(
    {
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
    },
    nodeName,
    capacity,
  );
  try {
    const headers = { authorization: `Bearer ${token}` };
    const routes = await fetch(`${running.url}/v1/fleet/snapshot?include=local-routes`, {
      headers,
    });
    const statusUrl = new URL("/trpc/residencyStatus", running.url);
    statusUrl.searchParams.set("input", JSON.stringify({ node: nodeName }));
    const status = await fetch(statusUrl, { headers });
    const model = manifest.spec.target.value;
    const completion = await fetch(`${running.url}/v1/completions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: [1, 2], max_tokens: 3 }),
    });
    const replacement = await fetch(`${running.url}/trpc/residencyControl`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        action: "load",
        node: nodeName,
        workload: `${workload}-replacement`,
        dryRun: false,
        confirm: true,
      }),
    });
    const statusBody: unknown = await status.json();
    const replacementBody: unknown = await replacement.json();
    report({
      routes: { status: routes.status, body: await routes.text() },
      status: { status: status.status, body: statusBody },
      completion: { status: completion.status, body: await completion.text() },
      replacement: { status: replacement.status, body: replacementBody },
    });
  } finally {
    await running.stop();
  }
}

const [mode, nodeName, workload, reportPath] = Bun.argv.slice(2);
if (nodeName === undefined || workload === undefined || reportPath === undefined) {
  throw new Error("expected publication fixture arguments");
}
const report = (value: unknown): void => {
  writeFileSync(reportPath, JSON.stringify(value));
};
try {
  if (mode === "launch" || mode === "ready")
    await crashManagedStart(mode, nodeName, workload, report);
  else if (mode === "recover") await inspectRecoveredOwner(nodeName, workload, report);
  else throw new Error("expected publication fixture mode");
} catch (error) {
  report({ error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
