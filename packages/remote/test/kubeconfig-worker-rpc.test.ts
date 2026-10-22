/**
 * #190: a kubeconfig node's workerRpc block is validated per owner when a
 * worker-RPC attempt targets it, not at kubeconfig load. A present block
 * that does not validate fails that owner closed, over its own transport,
 * with the offending key named in the log; it never reads as "not opted
 * in", which would silently put the owner back on the existing path.
 * Another node's malformed block leaves every other owner as it was: an
 * owner with a valid block keeps its worker-RPC client, and an owner
 * without one keeps the existing path.
 */
import type { PeerNode } from "@llamactl/core/config/peers";

import { inferenceContracts, routingCatalog } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import type { BackendExecutor } from "../src/proxy/create-proxy.js";

import { envForTemp, makeTempRuntime } from "../../core/test/helpers.js";
import { configSchema, config as kubecfg } from "../src/index.js";
import { acquireWorkerRpcExecutor } from "../src/inference/client.js";
import { writeFileSync } from "../src/safe-fs.js";

const TENANT = "local";
const UPSTREAM = "upstream-model";
const UNREACHABLE = "https://127.0.0.1:1";

let temp: ReturnType<typeof makeTempRuntime>;
let configBackup: string | undefined;

function writeKubeconfig(nodes: Record<string, unknown>): void {
  let cfg = configSchema.freshConfig();
  for (const [name, workerRpc] of Object.entries(nodes)) {
    cfg = kubecfg.upsertNode(cfg, "home", {
      name,
      endpoint: UNREACHABLE,
      ...(workerRpc === undefined ? {} : { workerRpc }),
    });
  }
  const path = join(temp.devStorage, "config");
  writeFileSync(path, stringifyYaml(cfg));
  process.env["LLAMACTL_CONFIG"] = path;
}

function candidate(owner: string): routingCatalog.RouteCandidate {
  const deploymentId = `deploy/${owner}/wl`;
  return {
    advertisement: {
      schemaVersion: 1,
      routeId: `route/${deploymentId}`,
      deploymentId,
      backendId: `backend/${deploymentId}`,
      ownerNodeId: owner,
      publicModelIds: [`public/${deploymentId}`],
      upstreamModelId: UPSTREAM,
      backendKind: "local-model",
      transport: "worker-rpc",
      endpoint: UNREACHABLE,
      capabilities: {
        operations: ["generate"],
        protocols: ["openai-chat"],
        streaming: "sse",
        modalities: ["text"],
        tools: true,
        structuredOutput: true,
        tokenCounting: false,
        cancellation: true,
        sessions: false,
      },
      modelRevision: routingCatalog.knownRevision("rev-1"),
      deploymentEpoch: routingCatalog.knownRevision("epoch-1"),
      adapterRevision: routingCatalog.UNKNOWN_REVISION,
      policyRevision: routingCatalog.UNKNOWN_REVISION,
      weight: 1,
      draining: false,
    },
    alias: `public/${deploymentId}`,
    source: "advertised",
    legacyWinner: false,
  };
}

function peer(id: string, tunnelPreferred: boolean): PeerNode {
  return tunnelPreferred
    ? { id, endpoint: UNREACHABLE, tunnelPreferred, tunnelCentralUrl: UNREACHABLE }
    : { id, endpoint: UNREACHABLE };
}

function recordingFallback(calls: string[]): BackendExecutor {
  return {
    describe: () => ({ id: "fallback", backendKinds: [], transports: [] }),
    execute: (): Promise<Response> => {
      calls.push("fallback");
      return Promise.resolve(Response.json({ path: "fallback" }));
    },
    cancel: () => false,
    drain: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

function acquire(
  owner: string,
  peers: readonly PeerNode[],
  fallback: string[],
): BackendExecutor | null {
  return acquireWorkerRpcExecutor(candidate(owner), {
    nodeId: "gw",
    scope: TENANT,
    fallback: recordingFallback(fallback),
    peers: () => peers,
  });
}

/** Executes one attempt, returning the response and everything written to stderr meanwhile. */
async function execute(
  executor: BackendExecutor,
  owner: string,
): Promise<{ res: Response; logged: string }> {
  const deploymentId = `deploy/${owner}/wl`;
  const env = inferenceContracts.parseInferenceEnvelope({
    requestId: `req-${owner}`,
    attemptId: `att-${owner}`,
    deadline: Date.now() + 60_000,
    tenantId: TENANT,
    projectId: TENANT,
    credentialScopeId: TENANT,
    operation: "generate",
    ingressProtocol: "openai-chat",
    publicModelId: `public/${deploymentId}`,
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
    nativeBody: {
      model: `public/${deploymentId}`,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    },
    headerFingerprint: { allowlist: ["content-type"], fingerprint: "test" },
  });
  const logged: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    logged.push(String(chunk));
    return true;
  };
  try {
    const res = await executor.execute(env, {
      req: new Request("http://127.0.0.1/v1/chat/completions", { method: "POST" }),
      resolved: resolveEnv(envForTemp(temp)),
      attemptId: env.attemptId,
      deadline: env.deadline,
    });
    return { res, logged: logged.join("") };
  } finally {
    process.stderr.write = write;
  }
}

beforeEach(() => {
  temp = makeTempRuntime();
  configBackup = process.env["LLAMACTL_CONFIG"];
});

afterEach(() => {
  if (configBackup === undefined) delete process.env["LLAMACTL_CONFIG"];
  else process.env["LLAMACTL_CONFIG"] = configBackup;
  temp.cleanup();
});

describe("kubeconfig workerRpc block, validated per owner", () => {
  test("a malformed block fails its owner closed over the owner's transport, naming the problem", async () => {
    writeKubeconfig({
      "w-typo": { serviceCredentialRef: "env:LLAMACTL_T190_SVC", relayCredentialsRef: "env:R" },
      "w-no-service": { relayCredentialRef: "env:LLAMACTL_T190_RELAY" },
      "w-empty-service": { serviceCredentialRef: "" },
      "w-empty-relay": { serviceCredentialRef: "env:LLAMACTL_T190_SVC", relayCredentialRef: "" },
      "w-null": null,
    });
    const cases = [
      { owner: "w-typo", tunnel: true, names: "relayCredentialsRef" },
      { owner: "w-no-service", tunnel: false, names: "serviceCredentialRef" },
      { owner: "w-empty-service", tunnel: false, names: "serviceCredentialRef" },
      { owner: "w-empty-relay", tunnel: true, names: "relayCredentialRef" },
      { owner: "w-null", tunnel: false, names: "invalid workerRpc block" },
    ];
    const peers = cases.map((c) => peer(c.owner, c.tunnel));
    for (const c of cases) {
      const fallback: string[] = [];
      const executor = acquire(c.owner, peers, fallback);
      expect(executor).not.toBeNull();
      const { res, logged } = await execute(executor!, c.owner);
      expect(res.status).toBe(503);
      expect(res.headers.get("x-llamactl-worker-transport")).toBe(c.tunnel ? "tunnel" : "direct");
      expect(await res.json()).toMatchObject({ error: { code: "target-unavailable" } });
      expect(logged).toContain(`owner '${c.owner}' has an invalid workerRpc block`);
      expect(logged).toContain(c.names);
      expect(fallback).toEqual([]);
    }
  });

  test("a misspelled required key is named before the key it leaves missing", async () => {
    writeKubeconfig({ "w-svc-typo": { serviceCredentialsRef: "env:LLAMACTL_T190_SVC" } });
    const fallback: string[] = [];
    const executor = acquire("w-svc-typo", [peer("w-svc-typo", false)], fallback);
    expect(executor).not.toBeNull();
    const { res, logged } = await execute(executor!, "w-svc-typo");
    expect(res.status).toBe(503);
    expect(logged).toContain("owner 'w-svc-typo' has an invalid workerRpc block");
    const misspelled = logged.indexOf("serviceCredentialsRef");
    expect(misspelled).toBeGreaterThanOrEqual(0);
    expect(logged.indexOf("serviceCredentialRef")).toBeGreaterThan(misspelled);
    expect(fallback).toEqual([]);
  });

  test("another node's malformed block leaves a valid owner its client and a plain owner the existing path", async () => {
    const credential = join(temp.devStorage, "service-credential");
    writeFileSync(credential, "t190-service-credential");
    writeKubeconfig({
      "w-null": null,
      "w-valid": { serviceCredentialRef: `file:${credential}` },
      "w-plain": undefined,
    });
    const peers = [peer("w-null", false), peer("w-valid", false), peer("w-plain", false)];
    expect(acquire("w-plain", peers, [])).toBeNull();
    const fallback: string[] = [];
    const executor = acquire("w-valid", peers, fallback);
    expect(executor).not.toBeNull();
    const { res, logged } = await execute(executor!, "w-valid");
    expect(res.headers.get("x-llamactl-worker-transport")).toBe("direct");
    expect(logged).not.toContain("workerRpc block");
    expect(logged).not.toContain("w-null");
    expect(fallback).toEqual([]);
  });
});
