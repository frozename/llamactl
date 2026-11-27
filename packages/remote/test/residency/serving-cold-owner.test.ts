import type { ExecutionAdmissionConfig } from "@llamactl/core/config/agent-config";

import { getResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TrustedColdOwner, TrustedColdPin } from "../../src/residency/cold-owner-admission.js";

import { createOwnerAdmission } from "../../src/residency/owner-admission.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { hashToken } from "../../src/server/auth.js";
import { prepareColdOwnerMount } from "../../src/server/cold-owner-mount.js";
import { type RunningAgent, startAgentServer } from "../../src/server/serve.js";
import {
  type ManagedAgentDependencies,
  startManagedAgentServer,
} from "../../src/server/start-managed-agent.js";
import { generateSelfSignedCert } from "../../src/server/tls.js";
import { parseNodeRun, saveNodeRun } from "../../src/workload/noderun-store.js";
import { parseWorkload, saveWorkload } from "../../src/workload/store.js";

const MODEL = "org/cold.gguf";
const WORKLOAD = "cold-model";
const TOKEN = "cold-owner-test-token";
const NODE = "fixture-cold-owner";
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
const CAP: ExecutionAdmissionConfig[number] = {
  name: "test-device",
  foregroundPorts: [19000],
  backgroundPorts: [19001],
  foregroundConcurrency: 1,
  maxQueued: 4,
  maxQueuedBytes: 4096,
  maxPerPrincipal: 4,
  maxQueueWaitMs: 2000,
  starvationBoundMs: 2000,
  maxContextTokens: 128,
  maxCompletionTokens: 8,
};

function isolate(dir: string): () => void {
  const env = {
    DEV_STORAGE: dir,
    LOCAL_AI_RUNTIME_DIR: join(dir, "runtime"),
    LLAMACTL_WORKLOADS_DIR: join(dir, "workloads"),
    LLAMACTL_RESIDENCY_STORE: join(dir, "operations.sqlite"),
    LLAMACTL_UNIFIED_PROXY: "0",
  };
  const previous = Object.keys(env).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, env);
  saveNodeRun(
    parseNodeRun(`
apiVersion: llamactl/v1
kind: NodeRun
metadata: { name: ${NODE} }
spec: { node: ${NODE}, budget: { memoryGiB: 24 } }
`),
    env.LLAMACTL_WORKLOADS_DIR,
  );
  saveWorkload(
    parseWorkload(`
apiVersion: llamactl/v1
kind: ModelRun
metadata: { name: ${WORKLOAD} }
spec: { node: local, target: { kind: rel, value: ${MODEL} } }
`),
    env.LLAMACTL_WORKLOADS_DIR,
  );
  return (): void => {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  };
}

function request(agent: RunningAgent, authenticated = true, signal?: AbortSignal): Request {
  return new Request(`${agent.url}/v1/completions`, {
    method: "POST",
    body: JSON.stringify({ model: MODEL, prompt: [1, 2], max_tokens: 3 }),
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    ...(signal === undefined ? {} : { signal }),
  });
}

function fixtureOwner(activate: TrustedColdOwner["activate"]): TrustedColdOwner {
  return {
    pin: (entry): TrustedColdPin => ({
      model: entry.id,
      workload: entry.workload,
      ownerNodeId: entry.ownerNodeId,
      deploymentId: "fixture-deployment",
      artifactRevision: "fixture-artifact",
      policyRevision: "fixture-policy",
      endpoint: "http://127.0.0.1:19000",
      pretokenizedCompletion: true,
    }),
    activate,
    ready: (): Promise<undefined> => Promise.resolve(undefined),
    stillOwns: (): boolean => false,
  };
}

test("mount prerequisites reject no-auth and foreign or missing managed ownership", () => {
  const warm = createOwnerAdmission([CAP]);
  const managed = {
    run: (): Promise<{ ran: false; detail: string }> =>
      Promise.resolve({ ran: false, detail: "fixture" }),
    runOwnedLifecycle: <T>(run: () => T): T => run(),
    ownsNode: (node: string): boolean => node === "local",
  };
  let calls = 0;
  const base = {
    factory: (): TrustedColdOwner => {
      calls++;
      return fixtureOwner((): Promise<"refused"> => Promise.resolve("refused"));
    },
    managed,
    warm,
    executionAdmission: [CAP],
    managedRuntime: true,
    tls: true,
    noAuth: false,
    declaredModels: true,
    residencyLeases: true,
  };
  try {
    for (const disabled of [
      { noAuth: true },
      { managedRuntime: false },
      { managed: undefined },
      { managed: { ...managed, ownsNode: (): boolean => false } },
      { residencyLeases: false },
    ]) {
      expect(prepareColdOwnerMount({ ...base, ...disabled })).toBeUndefined();
    }
    expect(calls).toBe(0);
    expect(prepareColdOwnerMount(base)).toBeDefined();
    expect(calls).toBe(1);
  } finally {
    warm.stop();
  }
});

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "only the authenticated TLS managed agent with declarations and explicit caps mounts a local cold owner",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-serve-cold-owner-"));
    const restore = isolate(dir);
    let running: RunningAgent | undefined;
    try {
      let factories = 0;
      let attempts = 0;
      const factory = (): TrustedColdOwner => {
        factories++;
        return fixtureOwner((): Promise<"refused"> => {
          attempts++;
          return Promise.resolve("refused");
        });
      };
      const cert = await generateSelfSignedCert({ dir, commonName: "127.0.0.1" });
      const tls = { certPath: cert.certPath, keyPath: cert.keyPath };
      const base = { tokenHash: hashToken(TOKEN), advertiseMdns: false };
      const opts = { ...base, tls, declaredModels: true, executionAdmission: [CAP] };

      running = startAgentServer({ ...opts, managedColdOwnerFactory: factory });
      expect(factories).toBe(0);
      await running.stop();
      running = undefined;

      const { maxContextTokens: _context, ...unbounded } = CAP;
      const { maxCompletionTokens: _completion, ...noCompletionCap } = CAP;
      for (const options of [
        { ...base, declaredModels: true, executionAdmission: [CAP] },
        { ...base, tls, declaredModels: false, executionAdmission: [CAP] },
        { ...base, tls, declaredModels: true, executionAdmission: [unbounded] },
        { ...base, tls, declaredModels: true, executionAdmission: [noCompletionCap] },
      ]) {
        running = await startManagedAgentServer(
          { ...options, managedColdOwnerFactory: factory },
          NODE,
          capacity,
        );
        expect(factories).toBe(0);
        await running.stop();
        running = undefined;
      }

      running = await startManagedAgentServer(
        { ...opts, managedColdOwnerFactory: factory },
        NODE,
        capacity,
      );
      expect(factories).toBe(1);
      expect((await fetch(request(running, false), { tls: { ca: cert.certPem } })).status).toBe(
        401,
      );
      expect(attempts).toBe(0);
      const response = await fetch(request(running), { tls: { ca: cert.certPem } });
      expect(response.status).toBe(503);
      expect(attempts).toBe(1);

      process.env["LLAMACTL_UNIFIED_PROXY"] = "1";
      expect((await fetch(request(running), { tls: { ca: cert.certPem } })).status).toBe(503);
      expect(attempts).toBe(1);
    } finally {
      await running?.stop();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "managed agent shutdown cancels the cold launch and waits for it to settle",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-serve-cold-stop-"));
    const restore = isolate(dir);
    const entered = Promise.withResolvers<undefined>();
    const canceled = Promise.withResolvers<undefined>();
    const settleLaunch = Promise.withResolvers<undefined>();
    let running: RunningAgent | undefined;
    try {
      const cert = await generateSelfSignedCert({ dir, commonName: "127.0.0.1" });
      running = await startManagedAgentServer(
        {
          tokenHash: hashToken(TOKEN),
          tls: { certPath: cert.certPath, keyPath: cert.keyPath },
          advertiseMdns: false,
          declaredModels: true,
          executionAdmission: [CAP],
          managedColdOwnerFactory: (): TrustedColdOwner =>
            fixtureOwner(async (_pin, signal): Promise<"uncertain"> => {
              signal.addEventListener(
                "abort",
                () => {
                  canceled.resolve(undefined);
                },
                { once: true },
              );
              entered.resolve(undefined);
              await settleLaunch.promise;
              return "uncertain";
            }),
        },
        NODE,
        capacity,
      );
      const dispatch = running.handleRequest;
      if (dispatch === undefined) throw new Error("expected test agent request seam");
      const registry = getResidencyLeaseRegistry();
      expect(registry).not.toBeNull();
      const pending = dispatch(request(running));
      await entered.promise;
      let stopped = false;
      const stopping = running.stop().then(() => {
        stopped = true;
      });
      await canceled.promise;
      await pending;
      await Bun.sleep(25);
      expect(stopped).toBe(false);
      expect(getResidencyLeaseRegistry()).toBe(registry);
      settleLaunch.resolve(undefined);
      await stopping;
      expect(stopped).toBe(true);
      expect(getResidencyLeaseRegistry()).not.toBe(registry);
      running = undefined;
    } finally {
      settleLaunch.resolve(undefined);
      await running?.stop();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
