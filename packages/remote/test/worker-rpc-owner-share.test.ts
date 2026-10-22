/**
 * #191 through `agent serve`'s wiring: agent.yaml's `workerRpc` block, read
 * as `agent serve` reads it, sets each owner's share of the worker's 64
 * active attempts, with a default that depends on how many distinct owners
 * the block binds.
 */
import { inferenceContracts, inferenceRpc } from "@llamactl/core";
import * as agentConfigMod from "@llamactl/core/config/agent-config";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { envForTemp, makeTempRuntime } from "../../core/test/helpers.js";
import { auth, type RunningAgent, startAgentServer } from "../src/index.js";
import { currentWorkerRpcHost } from "../src/inference/procedures.js";
import { mkdirSync, writeFileSync } from "../src/safe-fs.js";

type Claims = inferenceRpc.InferenceServiceClaimsV1;

const WORKER = "worker-share";
const TENANT = "local";
const WORKLOAD = "wl-share";
const MODEL = "share/model.gguf";
const DEPLOYMENT = `deploy/${WORKER}/${WORKLOAD}`;
const V1_0 = { major: 1, minor: 0 };
const SHARE_REFUSAL = "overloaded: the service is at its active attempt share";
const WORKER_REFUSAL = "overloaded: the worker is at its attempt limit";
const ENV_KEYS = ["DEV_STORAGE", "LOCAL_AI_RUNTIME_DIR", "LLAMA_CPP_MODELS"] as const;

let temp: ReturnType<typeof makeTempRuntime>;
let configPath: string;
let agent: RunningAgent | undefined;
let attempts = 0;
const envBackup: Record<string, string | undefined> = {};

function owner(serviceId: string): Claims {
  return {
    serviceId,
    operations: [...inferenceRpc.InferenceRpcOperationSchema.options],
    deployments: [DEPLOYMENT],
    models: [],
    tenants: [TENANT],
    credentialScopeId: TENANT,
  };
}

/** One binding per entry, each with a credential of its own. */
function bound(...owners: Claims[]): agentConfigMod.AgentWorkerRpcCredential[] {
  return owners.map((o) => ({ ...o, tokenHash: auth.generateToken().hash }));
}

/** Rewrites agent.yaml's workerRpc block, advertising v1.0, as an operator edits it. */
function writeWorkerRpc(block: Record<string, unknown>): void {
  const cfg = agentConfigMod.loadAgentConfig(configPath);
  agentConfigMod.saveAgentConfig({ ...cfg, workerRpc: { versions: [V1_0], ...block } }, configPath);
}

/** Starts the agent with the worker-RPC options `llamactl agent serve` derives from agent.yaml. */
function serve(): void {
  agent = startAgentServer({
    bindHost: "127.0.0.1",
    port: 0,
    tokenHash: auth.generateToken().hash,
    advertiseMdns: false,
    workerRpc: {
      workerId: WORKER,
      settings: agentConfigMod.workerRpcSettingsReader(configPath),
      drainTimeoutMs: 0,
    },
  });
}

function fencedTarget(who: Claims): inferenceRpc.InferenceRpcTargetV1 {
  const listing = currentWorkerRpcHost().catalog(who);
  if (listing.outcome !== "catalog") throw new Error("catalog rejected");
  const epoch = listing.deployments.find((d) => d.deploymentId === DEPLOYMENT)?.deploymentEpoch;
  if (epoch === undefined || epoch === null) throw new Error(`${DEPLOYMENT} has no known epoch`);
  return {
    deploymentId: DEPLOYMENT,
    expectedDeploymentEpoch: epoch,
    catalogGeneration: listing.catalogGeneration,
    workerIncarnation: listing.workerIncarnation,
  };
}

/** Submits a new attempt as `who` to the host the agent published, as its tRPC route does. */
function submitAs(who: Claims, fenced: inferenceRpc.InferenceRpcTargetV1): string {
  attempts += 1;
  const attemptId = `att-share-${String(attempts)}`;
  const result = currentWorkerRpcHost().submit(who, {
    version: V1_0,
    envelope: inferenceContracts.parseInferenceEnvelope({
      requestId: `req-${attemptId}`,
      attemptId,
      deadline: Date.now() + 60_000,
      tenantId: TENANT,
      projectId: TENANT,
      credentialScopeId: TENANT,
      operation: "generate",
      ingressProtocol: "openai-chat",
      publicModelId: MODEL,
      features: {
        operation: "generate",
        protocol: "openai-chat",
        stream: true,
        modalities: ["text"],
        tools: false,
        structuredOutput: false,
        session: false,
        cancellation: true,
      },
      stream: true,
      nativeBody: { model: MODEL, stream: true, messages: [{ role: "user", content: "hi" }] },
      headerFingerprint: { allowlist: ["content-type"], fingerprint: "share" },
    }),
    target: fenced,
    cancelId: `cancel-${attemptId}`,
  });
  return result.outcome === "rejected"
    ? `${result.rejection.code}: ${result.rejection.message}`
    : result.outcome;
}

function submitMany(who: Claims, fenced: inferenceRpc.InferenceRpcTargetV1, n: number): string[] {
  return Array.from({ length: n }, () => submitAs(who, fenced));
}

function accepted(n: number): string[] {
  return Array.from({ length: n }, () => "accepted");
}

function withStderr<T>(run: () => T): { result: T; stderr: string } {
  let stderr = "";
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  try {
    return { result: run(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

beforeAll(() => {
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
  temp = makeTempRuntime();
  const tempEnv = envForTemp(temp);
  for (const key of ENV_KEYS) process.env[key] = tempEnv[key];
  const dir = join(temp.runtimeDir, "workloads", WORKLOAD);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify({
      rel: MODEL,
      extraArgs: [],
      host: "127.0.0.1",
      port: 1,
      binary: "/x/llama-server",
      pid: process.pid,
      startedAt: "2026-10-19T00:00:00.000Z",
      tunedProfile: null,
    }),
  );
  configPath = join(temp.devStorage, "agent-share", "agent.yaml");
  agentConfigMod.saveAgentConfig(
    {
      apiVersion: "llamactl/v1",
      kind: "AgentConfig",
      nodeName: WORKER,
      bindHost: "127.0.0.1",
      port: 0,
      certPath: join(temp.devStorage, "agent-share", "unused.crt"),
      keyPath: join(temp.devStorage, "agent-share", "unused.key"),
      tokenHash: auth.generateToken().hash,
      fingerprint: `sha256:${"0".repeat(64)}`,
    },
    configPath,
  );
});

afterEach(async () => {
  await agent?.stop();
  agent = undefined;
});

afterAll(() => {
  try {
    temp.cleanup();
  } finally {
    for (const key of ENV_KEYS) {
      const prev = envBackup[key];
      if (prev === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = prev;
    }
  }
});

describe("agent.yaml's workerRpc.maxActiveAttemptsPerOwner through agent serve (#191)", () => {
  test("unset, one owner keeps the whole cap, even bound twice as during a rotation", () => {
    const a = owner("svc-a");
    writeWorkerRpc({ serviceCredentials: bound(a, a) });
    serve();
    const fenced = fencedTarget(a);
    expect(submitMany(a, fenced, 64)).toEqual(accepted(64));
    expect(submitAs(a, fenced)).toBe(SHARE_REFUSAL);
  });

  test("unset, two distinct owners are each held 16 below the cap", () => {
    const a = owner("svc-a");
    const b = owner("svc-b");
    writeWorkerRpc({ serviceCredentials: bound(a, b) });
    serve();
    const fenced = fencedTarget(a);
    expect(submitMany(a, fenced, 48)).toEqual(accepted(48));
    expect(submitAs(a, fenced)).toBe(SHARE_REFUSAL);
    expect(submitMany(b, fenced, 16)).toEqual(accepted(16));
    expect(submitAs(b, fenced)).toBe(WORKER_REFUSAL);
  });

  test("unset, one service bound under two credential scopes is two owners", () => {
    const a = owner("svc-a");
    writeWorkerRpc({ serviceCredentials: bound(a, { ...a, credentialScopeId: "scope-other" }) });
    serve();
    const fenced = fencedTarget(a);
    expect(submitMany(a, fenced, 48)).toEqual(accepted(48));
    expect(submitAs(a, fenced)).toBe(SHARE_REFUSAL);
  });

  test("a set share wins over the default and applies to the next submit without a restart", () => {
    const a = owner("svc-a");
    writeWorkerRpc({ serviceCredentials: bound(a), maxActiveAttemptsPerOwner: 2 });
    serve();
    const fenced = fencedTarget(a);
    expect(submitMany(a, fenced, 2)).toEqual(accepted(2));
    expect(submitAs(a, fenced)).toBe(SHARE_REFUSAL);
    writeWorkerRpc({ serviceCredentials: bound(a), maxActiveAttemptsPerOwner: 10 });
    expect(submitMany(a, fenced, 8)).toEqual(accepted(8));
    expect(submitAs(a, fenced)).toBe(SHARE_REFUSAL);
    // Above the two-owner default, for two owners.
    writeWorkerRpc({ serviceCredentials: bound(a, owner("svc-b")), maxActiveAttemptsPerOwner: 60 });
    expect(submitMany(a, fenced, 50)).toEqual(accepted(50));
    expect(submitAs(a, fenced)).toBe(SHARE_REFUSAL);
  });

  test("a share that is not a positive integer is ignored with a warning, and the bindings stay in force", () => {
    const a = owner("svc-a");
    const b = owner("svc-b");
    writeWorkerRpc({ serviceCredentials: bound(a), maxActiveAttemptsPerOwner: 2 });
    const valid = withStderr(() => agentConfigMod.workerRpcSettingsReader(configPath)());
    expect(valid.stderr).toBe("");
    expect(valid.result?.maxActiveAttemptsPerOwner).toBe(2);
    for (const bad of [0, -1, 1.5, "8", null]) {
      const parsed = agentConfigMod.AgentWorkerRpcSchema.safeParse({
        serviceCredentials: bound(a),
        maxActiveAttemptsPerOwner: bad,
      });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.maxActiveAttemptsPerOwner).toBeUndefined();
      expect(parsed.data?.serviceCredentials).toHaveLength(1);
    }
    writeWorkerRpc({ serviceCredentials: bound(a, b), maxActiveAttemptsPerOwner: 0 });
    const { result: settings, stderr: warning } = withStderr(() =>
      agentConfigMod.workerRpcSettingsReader(configPath)(),
    );
    expect(warning).toContain("ignoring workerRpc.maxActiveAttemptsPerOwner");
    expect(warning).not.toContain("ignoring the workerRpc block");
    expect(settings?.serviceCredentials.map((c) => c.serviceId)).toEqual(["svc-a", "svc-b"]);
    serve();
    const fenced = fencedTarget(a);
    expect(submitMany(a, fenced, 48)).toEqual(accepted(48));
    expect(submitAs(a, fenced)).toBe(SHARE_REFUSAL);
  });
});
