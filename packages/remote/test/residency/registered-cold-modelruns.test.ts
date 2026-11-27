import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunningAgent } from "../../src/server/serve.js";

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { hashToken } from "../../src/server/auth.js";
import {
  type ManagedAgentDependencies,
  startManagedAgentServer,
} from "../../src/server/start-managed-agent.js";
import { generateSelfSignedCert } from "../../src/server/tls.js";
import { parseNodeRun, saveNodeRun } from "../../src/workload/noderun-store.js";
import { loadWorkloadByName, parseWorkload, saveWorkload } from "../../src/workload/store.js";

const NODE = "registered-owner";
const REL = "fixture.gguf";
const TOKEN = "registered-cold-fixture-token";
const verifiedCapacity: ManagedAgentDependencies = {
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

async function fixtureEngine(dir: string): Promise<{ port: number; binary: string }> {
  const held = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 204 }),
  });
  const port = held.port;
  await held.stop(true);
  if (port === undefined) throw new Error("expected an ephemeral fixture engine port");
  const program = `
    const listener = Bun.serve({hostname:"127.0.0.1", port:${String(port)},
      fetch: (req) => new URL(req.url).pathname === "/v1/completions"
        ? Response.json({fixture:"managed-owner"})
        : new Response("ok")});
    process.on("SIGTERM", () => { listener.stop(true); process.exit(0); });
    setTimeout(() => process.exit(0), 10000);
  `;
  const binary = join(dir, "fixture-llama-server");
  writeFileSync(
    binary,
    `#!/bin/bash\nexec -a "$0" ${JSON.stringify(process.execPath)} -e ${JSON.stringify(program.replaceAll("\n", " "))} -- "$@"\n`,
    { mode: 0o755 },
  );
  return { port, binary };
}

function savePolicy(dir: string, memoryGiB: number): void {
  saveNodeRun(
    parseNodeRun(`
apiVersion: llamactl/v1
kind: NodeRun
metadata: { name: ${NODE} }
spec: { node: ${NODE}, budget: { memoryGiB: ${String(memoryGiB)} } }
`),
    dir,
  );
}

function fixtureWorkloads(dir: string, engine: Awaited<ReturnType<typeof fixtureEngine>>): void {
  savePolicy(dir, 24);
  for (const [name, artifact] of [
    ["enabled", REL],
    ["unlisted", "unlisted.gguf"],
  ] as const) {
    saveWorkload(
      parseWorkload(`
apiVersion: llamactl/v1
kind: ModelRun
metadata: { name: ${name} }
spec:
  node: local
  target: { kind: rel, value: ${artifact} }
  binary: ${JSON.stringify(engine.binary)}
  endpoint: { host: 127.0.0.1, port: ${String(engine.port)} }
  resources: { expectedMemoryGiB: 4 }
  extraArgs: ["--ctx-size", "256", "--parallel", "2"]
`),
      dir,
    );
  }
}

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "managed boot stages only configured artifacts and publishes owner-bound cold proof",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-registered-cold-"));
    const engine = await fixtureEngine(dir);
    const workloadsDir = join(dir, "workloads");
    const models = join(dir, "models");
    const modelPath = join(models, REL);
    const bytes = Buffer.alloc(48 * 1024, 42);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const env = {
      DEV_STORAGE: dir,
      LOCAL_AI_RUNTIME_DIR: join(dir, "runtime"),
      LLAMACTL_WORKLOADS_DIR: workloadsDir,
      LLAMACTL_RESIDENCY_STORE: join(dir, "operations.sqlite"),
      LLAMA_CPP_MODELS: models,
      LLAMA_CPP_HOST: "127.0.0.1",
      LLAMA_CPP_PORT: String(engine.port),
      LLAMA_CPP_CACHE: join(dir, "cache"),
      LLAMA_CPP_LOGS: join(dir, "logs"),
      LLAMA_CPP_USE_TUNED_ARGS: "false",
    };
    const previous = Object.keys(env).map((key) => [key, process.env[key]] as const);
    Object.assign(process.env, env);
    let running: RunningAgent | undefined;
    try {
      mkdirSync(models);
      writeFileSync(modelPath, bytes);
      fixtureWorkloads(workloadsDir, engine);
      writeFileSync(join(models, "unlisted.gguf"), bytes);
      const cert = await generateSelfSignedCert({ dir, commonName: "127.0.0.1" });
      running = await startManagedAgentServer(
        {
          tokenHash: hashToken(TOKEN),
          tls: { certPath: cert.certPath, keyPath: cert.keyPath },
          advertiseMdns: false,
          declaredModels: true,
          executionAdmission: [
            {
              name: "device",
              foregroundPorts: [engine.port],
              backgroundPorts: [engine.port === 65535 ? engine.port - 1 : engine.port + 1],
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
          managedColdModelRuns: [{ workload: "enabled", sha256, maxArtifactBytes: bytes.length }],
        },
        NODE,
        verifiedCapacity,
      );
      const url = `${running.url}/v1/fleet/snapshot?include=local-routes`;
      const headers = {
        authorization: `Bearer ${TOKEN}`,
        "x-llamactl-declaration-provenance": "1",
      };
      const tls = { ca: cert.certPem };
      expect(
        (await fetch(url, { tls, headers: { "x-llamactl-declaration-provenance": "1" } })).status,
      ).toBe(401);
      const cold = await fetch(url, { tls, headers });
      expect(cold.status).toBe(200);
      const body: unknown = await cold.json();
      expect(body).toMatchObject({
        workloads: [],
        declaredProvenance: {
          schemaVersion: 1,
          entries: [
            {
              id: REL,
              workload: "enabled",
              ownerNodeId: NODE,
              kind: "ModelRun",
              state: "cold",
              artifactRevision: `sha256:${sha256}`,
            },
          ],
        },
      });
      expect(JSON.stringify(body)).toMatch(/"policyRevision":"sha256:[0-9a-f]{64}"/);
      expect(
        (await fetch(url, { tls, headers: { authorization: headers.authorization } })).status,
      ).toBe(204);
      const inference = await fetch(`${running.url}/v1/completions`, {
        tls,
        method: "POST",
        headers: { authorization: headers.authorization, "content-type": "application/json" },
        body: JSON.stringify({ model: REL, prompt: [1, 2], max_tokens: 3 }),
      });
      expect(inference.status).toBe(200);
      expect(await inference.json()).toEqual({ fixture: "managed-owner" });
      const nowReady: unknown = await (await fetch(url, { tls, headers })).json();
      expect(nowReady).toMatchObject({
        declaredProvenance: { entries: [{ state: "ready", id: REL }] },
      });
      expect(JSON.stringify(nowReady)).toMatch(/"deploymentEpoch":"[0-9a-f]{64}"/);
      savePolicy(workloadsDir, 25);
      const drifted: unknown = await (await fetch(url, { tls, headers })).json();
      expect(drifted).toMatchObject({ workloads: [{ name: "enabled", reachable: true }] });
      expect(drifted).not.toHaveProperty("declaredProvenance");
      savePolicy(workloadsDir, 24);
      const stop = await fetch(`${running.url}/trpc/serverStop`, {
        tls,
        method: "POST",
        headers: { authorization: headers.authorization, "content-type": "application/json" },
        body: JSON.stringify({ workload: "enabled" }),
      });
      expect(await stop.json()).toMatchObject({
        result: { data: { stopped: false, managedRefusal: "ManagedStopIntentRequired" } },
      });
      const desired = loadWorkloadByName("enabled", workloadsDir);
      const disabled = await fetch(`${running.url}/trpc/managedWorkloadApply`, {
        tls,
        method: "POST",
        headers: { authorization: headers.authorization, "content-type": "application/json" },
        body: JSON.stringify({
          yaml: JSON.stringify({ ...desired, spec: { ...desired.spec, enabled: false } }),
        }),
      });
      expect(await disabled.json()).toMatchObject({
        result: { data: { status: { phase: "Stopped", serverPid: null } } },
      });
      expect(loadWorkloadByName("enabled", workloadsDir).spec.enabled).toBe(false);
      expect((await fetch(url, { tls, headers })).status).toBe(204);
      saveWorkload(desired, workloadsDir);
      writeFileSync(modelPath + ".replacement", bytes);
      renameSync(modelPath + ".replacement", modelPath);
      expect((await fetch(url, { tls, headers })).status).toBe(204);
    } finally {
      await running?.stop();
      for (const [key, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "only an explicit empty owner declaration inventory clears peer history",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-empty-cold-"));
    const env = {
      DEV_STORAGE: dir,
      LOCAL_AI_RUNTIME_DIR: join(dir, "runtime"),
      LLAMACTL_WORKLOADS_DIR: join(dir, "workloads"),
      LLAMACTL_RESIDENCY_STORE: join(dir, "operations.sqlite"),
    };
    const previous = Object.keys(env).map((key) => [key, process.env[key]] as const);
    Object.assign(process.env, env);
    let running: RunningAgent | undefined;
    try {
      savePolicy(env.LLAMACTL_WORKLOADS_DIR, 24);
      const cert = await generateSelfSignedCert({ dir, commonName: "127.0.0.1" });
      const opts = {
        tokenHash: hashToken(TOKEN),
        tls: { certPath: cert.certPath, keyPath: cert.keyPath },
        advertiseMdns: false,
        declaredModels: true,
      };
      const tls = { ca: cert.certPem };
      const inventory = { "x-llamactl-declaration-inventory": "2" };
      const auth = { authorization: `Bearer ${TOKEN}` };
      const endpoint = (agent: RunningAgent): string =>
        `${agent.url}/v1/fleet/snapshot?include=local-routes`;
      running = await startManagedAgentServer(opts, NODE, verifiedCapacity);
      expect(
        (await fetch(endpoint(running), { tls, headers: { ...auth, ...inventory } })).status,
      ).toBe(204);
      await running.stop();
      running = await startManagedAgentServer(
        { ...opts, managedColdModelRuns: [] },
        NODE,
        verifiedCapacity,
      );
      const url = endpoint(running);
      expect((await fetch(url, { tls, headers: inventory })).status).toBe(401);
      expect((await fetch(url, { tls, headers: auth })).status).toBe(204);
      const response = await fetch(url, { tls, headers: { ...auth, ...inventory } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        workloads: [],
        declaredInventory: { schemaVersion: 2, ownerNodeId: NODE, complete: true, entries: [] },
      });

      const operations = env.LLAMACTL_RESIDENCY_STORE;
      renameSync(operations, operations + ".saved");
      try {
        expect((await fetch(url, { tls, headers: { ...auth, ...inventory } })).status).toBe(204);
      } finally {
        renameSync(operations + ".saved", operations);
      }
    } finally {
      await running?.stop();
      for (const [key, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
