import { getLocalEngineForwarder } from "@llamactl/core/residency/engine-forwarder";

import { writeFileSync } from "../../src/safe-fs.js";
import { startManagedAgentServer } from "../../src/server/start-managed-agent.js";

const [nodeName, target, workload, statusPath] = Bun.argv.slice(2);
if (
  nodeName === undefined ||
  target === undefined ||
  workload === undefined ||
  statusPath === undefined
) {
  throw new Error("expected fixture owner arguments");
}
const port = Number(new URL(target).port);
const report = (status: unknown): void => {
  writeFileSync(statusPath, JSON.stringify(status));
};

try {
  const running = await startManagedAgentServer(
    {
      bindHost: "127.0.0.1",
      port: 0,
      tokenHash: "fleet-fixture",
      advertiseMdns: false,
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
    {
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
    },
  );
  try {
    const dispatch = getLocalEngineForwarder();
    const body = JSON.stringify({ model: workload, prompt: [1, 2], max_tokens: 3 });
    const response = await dispatch?.({
      target,
      body,
      workload,
      pretokenizedCompletion: true,
      stillOwnsTarget: () => true,
      deadlineMs: Date.now() + 15_000,
      clientSignal: new AbortController().signal,
      principal: { bearer: null },
      send: (signal) => fetch(target, { method: "POST", body, signal }),
    });
    if (response === undefined) throw new Error("expected the mounted owner to handle dispatch");
    report({ status: response.status, body: await response.text() });
  } finally {
    await running.stop();
  }
} catch (error) {
  report({ error: error instanceof Error ? error.message : String(error) });
}
