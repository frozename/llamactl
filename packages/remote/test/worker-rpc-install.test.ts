/**
 * P4.1 (#139) INSTALL-6 — one case per item, I1 to I6, built from temp
 * runtimes: a clean install with no kubeconfig, a kubeconfig and
 * agent.yaml in the base-release (c2a6a83c) shape, the optional Sirius
 * service absent, the RPC unavailable, and after rollback. Every agent is
 * started the way `llamactl agent serve` starts it, and every caller
 * resolves its owner and service credential from the kubeconfig, as in
 * production. Ends with a required-field diff against the recorded
 * baseline.
 */
import type { PeerNode } from "@llamactl/core/config/peers";

import {
  inferenceContracts,
  inferenceRpc,
  routingCapabilities,
  routingCatalog,
} from "@llamactl/core";
import * as agentConfigMod from "@llamactl/core/config/agent-config";
import { listPeers } from "@llamactl/core/config/peers";
import { resolveEnv } from "@llamactl/core/env";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { envForTemp, makeTempRuntime } from "../../core/test/helpers.js";
import { makePinnedFetch } from "../src/client/links.js";
import {
  auth,
  configSchema,
  config as kubecfg,
  router,
  type RunningAgent,
  startAgentServer,
  tls,
} from "../src/index.js";
import {
  acquireWorkerRpcExecutor,
  createEmbeddedInferenceRpcClient,
} from "../src/inference/client.js";
import { type BackendExecutor, createProxy } from "../src/proxy/create-proxy.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "../src/safe-fs.js";
import { type FakeEngine, startFakeEngine } from "./fixtures/inference-rpc-v1/fake-engine.js";
import { type ControllerClosedGuard, installControllerClosedGuard } from "./helpers.js";

const WORKER = "worker-i6";
const GATEWAY = "gateway-i6";
const TENANT = "local";
const WORKLOAD = "wl-rpc";
const MODEL = "rpc/model.gguf";
const DEPLOYMENT = `deploy/${WORKER}/${WORKLOAD}`;
const V1_0 = { major: 1, minor: 0 };
const CLI_BIN = join(import.meta.dir, "..", "..", "cli", "src", "bin.ts");
const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_MODELS",
  "LLAMA_CPP_HOST",
  "LLAMA_CPP_PORT",
  "LLAMACTL_CONFIG",
  "LLAMACTL_UNIFIED_PROXY",
  "LLAMACTL_SIRIUS_PROVIDERS",
  "PATH",
] as const;

let temp: ReturnType<typeof makeTempRuntime>;
let engine: FakeEngine;
let guard: ControllerClosedGuard;
const envBackup: Record<string, string | undefined> = {};
const agents: RunningAgent[] = [];

interface WorkerFiles {
  dir: string;
  configPath: string;
  certPath: string;
  keyPath: string;
  certPem: string;
  fingerprint: string;
  operatorToken: string;
}

interface ServiceCredential {
  token: string;
  /** The caller's secret reference to the token: a file only the caller reads. */
  ref: string;
  binding: agentConfigMod.AgentWorkerRpcCredential;
}

function writeWorkload(): void {
  const dir = join(temp.runtimeDir, "workloads", WORKLOAD);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify({
      rel: MODEL,
      extraArgs: [],
      host: "127.0.0.1",
      port: Number(new URL(engine.url).port),
      binary: "/x/llama-server",
      pid: process.pid,
      startedAt: "2026-10-19T00:00:00.000Z",
      tunedProfile: null,
    }),
  );
}

/** An agent dir exactly as the base release's `agent init` writes it: no worker-RPC field. */
async function initAgent(name: string): Promise<WorkerFiles> {
  const dir = join(temp.devStorage, `agent-${name}`);
  mkdirSync(dir, { recursive: true });
  const cert = await tls.generateSelfSignedCert({
    dir,
    commonName: "127.0.0.1",
    hostnames: ["127.0.0.1", "localhost"],
  });
  const operator = auth.generateToken();
  const configPath = join(dir, "agent.yaml");
  agentConfigMod.saveAgentConfig(
    {
      apiVersion: "llamactl/v1",
      kind: "AgentConfig",
      nodeName: WORKER,
      bindHost: "127.0.0.1",
      port: 0,
      certPath: cert.certPath,
      keyPath: cert.keyPath,
      tokenHash: operator.hash,
      fingerprint: cert.fingerprint,
    },
    configPath,
  );
  return {
    dir,
    configPath,
    certPath: cert.certPath,
    keyPath: cert.keyPath,
    certPem: cert.certPem,
    fingerprint: cert.fingerprint,
    operatorToken: operator.token,
  };
}

/** A service credential made with the agent's own token mechanics. */
function serviceCredential(
  name: string,
  overrides: Partial<agentConfigMod.AgentWorkerRpcCredential> = {},
): ServiceCredential {
  const { token, hash } = auth.generateToken();
  const file = join(temp.devStorage, `svc-${name}.token`);
  writeFileSync(file, `${token}\n`);
  chmodSync(file, 0o600);
  return {
    token,
    ref: `file:${file}`,
    binding: {
      serviceId: name,
      operations: [...inferenceRpc.InferenceRpcOperationSchema.options],
      deployments: [DEPLOYMENT],
      models: [],
      tenants: [TENANT],
      credentialScopeId: TENANT,
      tokenHash: hash,
      ...overrides,
    },
  };
}

/** Enabling the RPC on the worker: the one additive, optional block. */
function enableWorkerRpc(
  files: WorkerFiles,
  block: Partial<agentConfigMod.AgentWorkerRpc> & {
    serviceCredentials: agentConfigMod.AgentWorkerRpcCredential[];
  },
): void {
  const cfg = agentConfigMod.loadAgentConfig(files.configPath);
  agentConfigMod.saveAgentConfig(
    { ...cfg, workerRpc: { versions: [V1_0], ...block } },
    files.configPath,
  );
}

/** Starts the agent with the options `llamactl agent serve` derives from agent.yaml. */
function serve(files: WorkerFiles): RunningAgent {
  const cfg = agentConfigMod.loadAgentConfig(files.configPath);
  const agent = startAgentServer({
    bindHost: cfg.bindHost,
    port: cfg.port,
    tokenHash: cfg.tokenHash,
    tls: { certPath: cfg.certPath, keyPath: cfg.keyPath },
    advertiseMdns: false,
    workerRpc: {
      workerId: cfg.nodeName ?? "agent",
      settings: agentConfigMod.workerRpcSettingsReader(files.configPath),
      drainTimeoutMs: 2_000,
    },
  });
  agents.push(agent);
  return agent;
}

/** The caller's kubeconfig in the base-release shape, plus `extra` on the worker's node. */
function writeKubeconfig(
  files: WorkerFiles,
  agent: RunningAgent,
  extra: Partial<configSchema.ClusterNode> = {},
): string {
  let cfg = configSchema.freshConfig();
  cfg = kubecfg.upsertNode(cfg, "home", {
    name: WORKER,
    endpoint: agent.url,
    certificate: files.certPem,
    certificateFingerprint: files.fingerprint,
    ...extra,
  });
  cfg = { ...cfg, users: [{ name: "me", token: files.operatorToken }] };
  const path = join(temp.devStorage, "config");
  kubecfg.saveConfig(cfg, path);
  process.env["LLAMACTL_CONFIG"] = path;
  return path;
}

async function negotiate(
  files: WorkerFiles,
  agent: RunningAgent,
  token: string,
): Promise<{ status: number; data: unknown }> {
  const pinned = makePinnedFetch({
    name: WORKER,
    endpoint: agent.url,
    certificate: files.certPem,
    certificateFingerprint: files.fingerprint,
  });
  const input = encodeURIComponent(
    JSON.stringify({ versions: [V1_0], requiredFeatures: ["execution-event-v1"] }),
  );
  const res = await pinned(`${agent.url}/trpc/inferenceRpc.negotiate?input=${input}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => null)) as { result?: { data?: unknown } } | null;
  return { status: res.status, data: body?.result?.data };
}

function recordingFallback(calls: string[]): BackendExecutor {
  return {
    describe: () => ({ id: "fallback", backendKinds: ["local-model"], transports: ["worker-rpc"] }),
    execute: (envelope): Promise<Response> => {
      calls.push(envelope.attemptId);
      return Promise.resolve(new Response("legacy", { status: 299 }));
    },
    cancel: () => false,
    drain: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

function candidate(
  overrides: Partial<routingCatalog.RouteAdvertisementV1> = {},
): routingCatalog.RouteCandidate {
  return {
    advertisement: {
      schemaVersion: 1,
      routeId: `route/${WORKER}/${WORKLOAD}`,
      deploymentId: DEPLOYMENT,
      backendId: `backend/${WORKER}/${WORKLOAD}`,
      ownerNodeId: WORKER,
      publicModelIds: [MODEL],
      upstreamModelId: MODEL,
      backendKind: "local-model",
      transport: "worker-rpc",
      endpoint: "https://127.0.0.1:1",
      capabilities: routingCapabilities.LEGACY_PROXY_CAPABILITIES,
      modelRevision: routingCatalog.UNKNOWN_REVISION,
      deploymentEpoch: routingCatalog.UNKNOWN_REVISION,
      adapterRevision: routingCatalog.UNKNOWN_REVISION,
      policyRevision: routingCatalog.UNKNOWN_REVISION,
      weight: 1,
      draining: false,
      ...overrides,
    },
    alias: MODEL,
    source: "legacy",
    legacyWinner: true,
  };
}

/** The gateway's executor for the worker's deployment, resolved from its kubeconfig. */
function gatewayExecutor(fallback: string[]): BackendExecutor | null {
  return acquireWorkerRpcExecutor(candidate(), {
    nodeId: GATEWAY,
    scope: TENANT,
    fallback: recordingFallback(fallback),
    peers: (): PeerNode[] => listPeers({ currentNodeName: GATEWAY }),
  });
}

function envelope(attemptId: string): inferenceContracts.InferenceEnvelopeV1 {
  return inferenceContracts.parseInferenceEnvelope({
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
    headerFingerprint: { allowlist: ["content-type"], fingerprint: "install" },
  });
}

async function execute(
  executor: BackendExecutor,
  attemptId: string,
): Promise<{ status: number; body: string; transport: string | null }> {
  const env = envelope(attemptId);
  const req = new Request("http://gateway/v1/chat/completions", { method: "POST" });
  const res = await executor.execute(env, {
    req,
    resolved: resolveEnv(),
    attemptId,
    deadline: env.deadline,
  });
  return {
    status: res.status,
    body: await res.text(),
    transport: res.headers.get("x-llamactl-worker-transport"),
  };
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Bytes and mtime of every file under the given roots. */
function snapshot(roots: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string): void => {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) walk(join(path, entry));
      return;
    }
    out[path] = `${digest(path)}@${String(stat.mtimeMs)}`;
  };
  for (const root of roots) walk(root);
  return out;
}

function fakeCli(): { marker: string; command: string } {
  const binDir = join(temp.devStorage, "fake-bin");
  mkdirSync(binDir, { recursive: true });
  const marker = join(temp.devStorage, "fake-cli.invocations");
  const command = join(binDir, "fake-cli");
  writeFileSync(command, `#!/bin/sh\necho "$*" >> '${marker}'\necho fake\n`);
  chmodSync(command, 0o755);
  return { marker, command };
}

function invocations(marker: string): number {
  return existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").length : 0;
}

/** Required keys of an object schema: those that reject `undefined`. */
function requiredKeys(shape: Record<string, z.ZodType>): string[] {
  return Object.entries(shape)
    .filter(([, schema]) => !schema.safeParse(undefined).success)
    .map(([key]) => key)
    .sort();
}

beforeAll(() => {
  guard = installControllerClosedGuard();
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
  temp = makeTempRuntime();
  const tempEnv = envForTemp(temp);
  for (const key of ["DEV_STORAGE", "LOCAL_AI_RUNTIME_DIR", "LLAMA_CPP_MODELS"] as const) {
    process.env[key] = tempEnv[key];
  }
  process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
  process.env["LLAMA_CPP_PORT"] = "1";
  process.env["LLAMACTL_CONFIG"] = join(temp.devStorage, "no-kubeconfig");
  Reflect.deleteProperty(process.env, "LLAMACTL_UNIFIED_PROXY");
  Reflect.deleteProperty(process.env, "LLAMACTL_SIRIUS_PROVIDERS");
  engine = startFakeEngine();
  writeWorkload();
});

beforeEach(() => {
  engine.reset();
  process.env["LLAMACTL_CONFIG"] = join(temp.devStorage, "no-kubeconfig");
});

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
});

afterAll(async () => {
  try {
    await engine.stop();
    temp.cleanup();
  } finally {
    for (const key of ENV_KEYS) {
      const prev = envBackup[key];
      if (prev === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = prev;
    }
    guard.dispose();
  }
});

describe("I1: clean install", () => {
  test("with no kubeconfig and no worker-RPC fields, the agent serves as before and does not advertise the RPC", async () => {
    expect(existsSync(process.env["LLAMACTL_CONFIG"] ?? "")).toBe(false);
    const files = await initAgent("clean");
    expect(Object.keys(parseYaml(readFileSync(files.configPath, "utf8")) as object)).not.toContain(
      "workerRpc",
    );
    const agent = serve(files);
    const health = await fetch(`${agent.url}/health`, { tls: { ca: files.certPem } });
    expect(health.status).toBe(200);
    // The operator bearer reaches the route; a worker that lists no
    // version answers a positive "not advertised".
    const negotiated = await negotiate(files, agent, files.operatorToken);
    expect(negotiated).toEqual({
      status: 200,
      data: { outcome: "not-advertised", workerId: WORKER },
    });
    // Local serving through openaiProxy is unchanged.
    const pinned = makePinnedFetch({
      name: WORKER,
      endpoint: agent.url,
      certificate: files.certPem,
    });
    const chat = await pinned(`${agent.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${files.operatorToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(chat.status).toBe(200);
    expect(engine.requests).toHaveLength(1);
  });

  test("agent serve, the real entry point, starts from a base-shaped agent.yaml and does not advertise", async () => {
    const files = await initAgent("cli");
    const proc = Bun.spawn(["bun", CLI_BIN, "agent", "serve", `--dir=${files.dir}`, "--port=0"], {
      env: { ...process.env, LLAMACTL_DISABLE_MDNS: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = proc.stdout.getReader();
      let out = "";
      while (!out.includes("press Ctrl-C")) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
      reader.releaseLock();
      const url = /agent listening on (\S+)/.exec(out)?.[1];
      expect(url).toBeDefined();
      const agent = { url: url ?? "" } as RunningAgent;
      expect((await fetch(`${agent.url}/health`, { tls: { ca: files.certPem } })).status).toBe(200);
      const negotiated = await negotiate(files, agent, files.operatorToken);
      expect(negotiated.status).toBe(200);
      expect((negotiated.data as { outcome: string }).outcome).toBe("not-advertised");
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
    }
  }, 30_000);

  test("no command, agent subcommand or environment variable is new", () => {
    const verbs = (path: string): string[] =>
      [...readFileSync(path, "utf8").matchAll(/case "([a-z][a-z-]*)"/g)]
        .map((m) => m[1] ?? "")
        .filter((verb, i, all) => all.indexOf(verb) === i)
        .sort();
    expect(verbs(CLI_BIN)).toEqual(
      [
        "admit",
        "agent",
        "apply",
        "artifacts",
        "bench",
        "candidate",
        "catalog",
        "composite",
        "controller",
        "cost-guardian",
        "ctx",
        "delete",
        "deploy-node",
        "describe",
        "disable",
        "discover",
        "doctor",
        "embersynth",
        "enable",
        "env",
        "eval",
        "expose",
        "fleet",
        "get",
        "heal",
        "help",
        "infra",
        "init",
        "keep-alive",
        "lmstudio",
        "node",
        "plan",
        "project",
        "pull",
        "rag",
        "recommendations",
        "runbook",
        "server",
        "sirius",
        "supervisor",
        "tunnel",
        "uninstall",
      ].sort(),
    );
    const agentCommands = join(import.meta.dir, "..", "..", "cli", "src", "commands", "agent.ts");
    expect(verbs(agentCommands)).toEqual([
      "cli",
      "heal",
      "help",
      "init",
      "install-launchd",
      "rollback",
      "rotate-token",
      "rpc-doctor",
      "serve",
      "status",
      "update",
    ]);
    // Every LLAMACTL_* variable the sources read existed at the base release.
    const BASELINE_ENV = new Set(
      "AGENT_DIR AGENT_HOST ARTIFACTS_DIR BENCH_SCHEDULES CLI_JOURNAL_DIR COMPOSITES_DIR CONFIG COST_GUARDIAN_CONFIG COST_JOURNAL DISABLE_MDNS EMBERSYNTH_CONFIG FLEET_DIR FLEET_LEASE_MODE FLEET_MOVE_ENABLED HEALER_JOURNAL HOME INFRA_DIR INFRA_LOGS_DIR INFRA_PACKAGES_DIR INSTALL_DIR INTERNAL_PROXY_URL KV_QUARANTINE_PURGE_HOURS KV_WORKLOAD_BUDGET_MB MCP_AUDIT_DIR MCP_PIPELINES_DIR MEASURED_MEMORY_PATH MODELS_DIR NODES NODE_NAME OPERATOR_PLAN_API_KEY_ENVS OPERATOR_PLAN_HOST_ALLOWLIST OPS_CHAT_AUDIT PLIST_EOF__ PROJECTS_FILE PROJECT_ROUTING_JOURNAL PROVIDERS_FILE RAG_PIPELINES_DIR RESPONSE_CACHE_BUDGET_MB RESPONSE_CACHE_MAX_ENTRY_MB RESPONSE_CACHE_TTL_HOURS RUNTIME_BACKEND RUNTIME_DIR SERVICE_TYPE SIGN_IDENTITY SIRIUS_PROVIDERS TEST_PROFILE TOKEN_ TUNNEL_BEARER TUNNEL_CENTRAL_BEARER TUNNEL_JOURNAL UNIFIED_PROXY UNIT_EOF__ VERSION WORKLOADS_DIR"
        .split(" ")
        .map((name) => `LLAMACTL_${name}`),
    );
    const sources = join(import.meta.dir, "..", "..");
    const read = new Set<string>();
    for (const pkg of readdirSync(sources)) {
      const src = join(sources, pkg, "src");
      if (!existsSync(src)) continue;
      const walk = (path: string): void => {
        if (statSync(path).isDirectory()) {
          for (const entry of readdirSync(path)) walk(join(path, entry));
          return;
        }
        if (!/\.tsx?$/.test(path)) return;
        for (const m of readFileSync(path, "utf8").matchAll(/LLAMACTL_[A-Z0-9_]+/g)) read.add(m[0]);
      };
      walk(src);
    }
    expect([...read].filter((name) => !BASELINE_ENV.has(name))).toEqual([]);
    expect(read.has("LLAMACTL_PROXY_EXECUTION")).toBe(false);
  });
});

describe("I2: existing-config upgrade", () => {
  test("a base-shaped agent.yaml and kubeconfig load unchanged, with no migration", async () => {
    const files = await initAgent("upgrade");
    const agentYaml = readFileSync(files.configPath, "utf8");
    const loaded = agentConfigMod.loadAgentConfig(files.configPath);
    expect(loaded.workerRpc).toBeUndefined();
    agentConfigMod.saveAgentConfig(loaded, files.configPath);
    expect(readFileSync(files.configPath, "utf8")).toBe(agentYaml);

    const agent = serve(files);
    const path = writeKubeconfig(files, agent);
    const kubeYaml = readFileSync(path, "utf8");
    const cfg = kubecfg.loadConfig(path);
    expect(cfg.clusters[0]?.nodes.find((n) => n.name === WORKER)?.workerRpc).toBeUndefined();
    expect(cfg).toEqual(configSchema.ConfigSchema.parse(parseYaml(kubeYaml)));
    // A re-save only normalizes key order, as the base release does; it adds nothing.
    kubecfg.saveConfig(cfg, path);
    const normalized = readFileSync(path, "utf8");
    expect(normalized.split("\n").sort()).toEqual(kubeYaml.split("\n").sort());
    kubecfg.saveConfig(kubecfg.loadConfig(path), path);
    expect(readFileSync(path, "utf8")).toBe(normalized);
    // An owner with no worker-RPC block keeps the existing path for its deployments.
    expect(gatewayExecutor([])).toBeNull();
  });

  test("enabling the RPC writes only additive, optional fields on both sides", async () => {
    const files = await initAgent("additive");
    const before = readFileSync(files.configPath, "utf8");
    const svc = serviceCredential("svc-additive");
    enableWorkerRpc(files, { serviceCredentials: [svc.binding] });
    const after = readFileSync(files.configPath, "utf8");
    const kept = before.trimEnd().split("\n");
    const added = after
      .trimEnd()
      .split("\n")
      .filter((line) => !kept.includes(line));
    expect(after.trimEnd().split("\n").slice(0, kept.length)).toEqual(kept);
    expect(added[0]).toBe("workerRpc:");
    expect(after).not.toContain(svc.token);

    const agent = serve(files);
    const path = writeKubeconfig(files, agent);
    const kubeBefore = readFileSync(path, "utf8");
    writeKubeconfig(files, agent, { workerRpc: { serviceCredentialRef: svc.ref } });
    const kubeAfter = readFileSync(path, "utf8");
    const kubeKept = new Set(kubeBefore.trimEnd().split("\n"));
    expect(
      kubeAfter
        .trimEnd()
        .split("\n")
        .filter((line) => !kubeKept.has(line)),
    ).toEqual(["        workerRpc:", `          serviceCredentialRef: ${svc.ref}`]);
    expect(kubeAfter).not.toContain(svc.token);

    // The new fields are the opt-in: the worker now negotiates with the
    // service credential, and only with it.
    const negotiated = await negotiate(files, agent, svc.token);
    expect(negotiated.status).toBe(200);
    expect(negotiated.data).toMatchObject({
      outcome: "negotiated",
      version: V1_0,
      workerId: WORKER,
    });
    const fallback: string[] = [];
    const ran = await execute(gatewayExecutor(fallback)!, "att-additive");
    expect(ran).toMatchObject({ status: 200, transport: "direct" });
    expect(ran.body).toContain("[DONE]");
    expect(fallback).toEqual([]);
    expect(engine.requests).toHaveLength(1);
    expect(engine.requests[0]?.body?.["model"]).toBe(MODEL);
  });

  for (const stage of ["upgraded", "rolled back"] as const) {
    for (const flag of [undefined, "1"] as const) {
      test(`I2/I5: an existing cli: binding runs through the legacy path once per call (${stage}, LLAMACTL_UNIFIED_PROXY=${flag ?? "unset"})`, async () => {
        const files = await initAgent(`cli-${stage.replace(" ", "-")}-${flag ?? "off"}`);
        const svc = serviceCredential(`svc-cli-${stage.replace(" ", "-")}`);
        const { marker, command } = fakeCli();
        writeFileSync(marker, "");
        if (stage === "upgraded") enableWorkerRpc(files, { serviceCredentials: [svc.binding] });
        const agent = serve(files);
        writeKubeconfig(files, agent, {
          cli: [
            configSchema.CliBindingSchema.parse({
              name: "fakecli",
              preset: "custom",
              command,
              args: ["{{prompt}}"],
            }),
          ],
          ...(stage === "upgraded" ? { workerRpc: { serviceCredentialRef: svc.ref } } : {}),
        });
        if (flag === undefined) Reflect.deleteProperty(process.env, "LLAMACTL_UNIFIED_PROXY");
        else process.env["LLAMACTL_UNIFIED_PROXY"] = flag;
        try {
          const caller = router.createCaller({});
          for (let call = 1; call <= 2; call += 1) {
            const response = (await caller.chatComplete({
              node: `${WORKER}.fakecli`,
              request: {
                model: "fakecli",
                messages: [{ role: "user", content: `call ${String(call)}` }],
              },
            })) as { choices?: { message?: { content?: string } }[] };
            expect(response.choices?.[0]?.message?.content).toContain("fake");
            expect(invocations(marker)).toBe(call);
          }
          expect(engine.requests).toHaveLength(0);
        } finally {
          Reflect.deleteProperty(process.env, "LLAMACTL_UNIFIED_PROXY");
        }
      });
    }
  }
});

describe("I3: optional service absent", () => {
  test("with no Sirius process, environment or configuration, startup, health, /v1 and the embedded client work and nothing dials Sirius", async () => {
    expect(Object.keys(process.env).filter((key) => /SIRIUS/i.test(key))).toEqual([]);
    const files = await initAgent("no-sirius");
    const svc = serviceCredential("svc-no-sirius");
    enableWorkerRpc(files, { serviceCredentials: [svc.binding] });
    const dialed: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        dialed.push(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        return realFetch(input, init);
      },
      realFetch,
    );
    try {
      const agent = serve(files);
      expect((await fetch(`${agent.url}/health`, { tls: { ca: files.certPem } })).status).toBe(200);
      const chat = await fetch(`${agent.url}/v1/chat/completions`, {
        method: "POST",
        tls: { ca: files.certPem },
        headers: {
          authorization: `Bearer ${files.operatorToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(chat.status).toBe(200);

      const { binding } = svc;
      const embedded = createEmbeddedInferenceRpcClient(binding);
      const negotiated = await embedded.negotiate({ versions: [V1_0] });
      expect(negotiated.outcome).toBe("negotiated");
      const listing = await embedded.catalog();
      if (listing.outcome !== "catalog") throw new Error("catalog refused");
      const deployment = listing.deployments.find((d) => d.deploymentId === DEPLOYMENT);
      const submitted = await embedded.submit({
        version: V1_0,
        envelope: envelope("att-embedded"),
        target: {
          deploymentId: DEPLOYMENT,
          expectedDeploymentEpoch: deployment?.deploymentEpoch ?? "",
          catalogGeneration: listing.catalogGeneration,
          workerIncarnation: listing.workerIncarnation,
        },
        cancelId: "cancel-embedded",
      });
      expect(submitted.outcome).toBe("accepted");
      const frames: inferenceRpc.InferenceRpcStreamFrameV1[] = [];
      for await (const frame of embedded.stream({ attemptId: "att-embedded" })) frames.push(frame);
      expect(frames.at(-1)).toMatchObject({
        frame: "event",
        event: { type: "terminal", terminal: { outcome: "completed" } },
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(engine.requests).toHaveLength(2);
    const hosts = new Set(dialed.map((url) => new URL(url).host));
    const allowed = new Set([new URL(engine.url).host, new URL(agents[0]?.url ?? "").host]);
    expect([...hosts].filter((host) => !allowed.has(host))).toEqual([]);
  });
});

describe("I4: fail closed", () => {
  test("an unreachable owner, a refused credential and an unresolvable reference each get a typed refusal; nothing is rerouted", async () => {
    const files = await initAgent("fail-closed");
    const svc = serviceCredential("svc-fail-closed");
    const stranger = serviceCredential("svc-stranger");
    enableWorkerRpc(files, { serviceCredentials: [svc.binding] });
    const agent = serve(files);
    const fallback: string[] = [];

    // Unreachable: the declared endpoint refuses connections.
    writeKubeconfig(files, agent, {
      endpoint: "https://127.0.0.1:1",
      workerRpc: { serviceCredentialRef: svc.ref },
    });
    const down = await execute(gatewayExecutor(fallback)!, "att-down");
    expect(down.status).toBe(503);
    expect(JSON.parse(down.body)).toMatchObject({ error: { code: "target-unavailable" } });

    // A credential the worker does not hold.
    writeKubeconfig(files, agent, { workerRpc: { serviceCredentialRef: stranger.ref } });
    const refused = await execute(gatewayExecutor(fallback)!, "att-refused");
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body)).toMatchObject({ error: { code: "unauthorized-scope" } });

    // A secret reference that does not resolve.
    writeKubeconfig(files, agent, {
      workerRpc: { serviceCredentialRef: `file:${join(files.dir, "missing.token")}` },
    });
    const unresolved = await execute(gatewayExecutor(fallback)!, "att-unresolved");
    expect(unresolved.status).toBe(503);
    expect(JSON.parse(unresolved.body)).toMatchObject({ error: { code: "target-unavailable" } });

    // An undeclared owner is never reached some other way.
    writeKubeconfig(files, agent, { name: "someone-else" });
    const undeclared = await execute(gatewayExecutor(fallback)!, "att-undeclared");
    expect(undeclared.status).toBe(503);
    expect(fallback).toEqual([]);
    expect(engine.requests).toHaveLength(0);
  });
});

describe("I5: disconnect and rollback", () => {
  test("stopping the advertisement sends new requests down the existing path while the active stream drains, untouched files and all", async () => {
    const files = await initAgent("rollback");
    const svc = serviceCredential("svc-rollback");
    enableWorkerRpc(files, { serviceCredentials: [svc.binding] });
    const agent = serve(files);
    const kubeconfig = writeKubeconfig(files, agent, {
      workerRpc: { serviceCredentialRef: svc.ref },
    });
    const seeds = [
      join(temp.devStorage, "responsecache"),
      join(temp.devStorage, "kvstore"),
      join(temp.runtimeDir, "kvstore", "slots", WORKLOAD),
    ];
    for (const dir of seeds) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "seed.bin"), "seed");
    }
    let release = (): void => undefined;
    engine.setScript({
      pieces: ["Hel", "lo"],
      holdAfter: 1,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    const fallback: string[] = [];
    const active = execute(gatewayExecutor(fallback)!, "att-active");
    const deadline = Date.now() + 5_000;
    while (engine.requests.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(engine.requests).toHaveLength(1);

    // Rollback: the operator stops the advertisement in agent.yaml.
    const cfg = agentConfigMod.loadAgentConfig(files.configPath);
    agentConfigMod.saveAgentConfig(
      { ...cfg, workerRpc: { versions: [], serviceCredentials: [svc.binding] } },
      files.configPath,
    );
    const roots = [files.dir, kubeconfig, svc.ref.slice("file:".length), ...seeds];
    const untouched = snapshot(roots);

    // New requests take the existing path; nothing new reaches the engine.
    expect(await execute(gatewayExecutor(fallback)!, "att-after")).toMatchObject({ status: 299 });
    expect(fallback).toEqual(["att-after"]);

    // The active stream drains to its terminal and is never re-submitted.
    release();
    const drained = await active;
    expect(drained.status).toBe(200);
    expect(drained.body).toContain('"content":"lo"');
    expect(drained.body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(engine.requests).toHaveLength(1);
    expect(fallback).toEqual(["att-after"]);

    // Turning the caller's flag off keeps every new request on the
    // existing path; the worker RPC is never acquired.
    const passthrough: string[] = [];
    const acquired: string[] = [];
    const flagOff = createProxy({
      env: {},
      nodeId: GATEWAY,
      passthrough: (req) => {
        passthrough.push(req.url);
        return Promise.resolve(new Response("legacy", { status: 299 }));
      },
      acquireExecutor: (c) => {
        acquired.push(c.advertisement.deploymentId);
        return recordingFallback(fallback);
      },
    });
    const legacy = await flagOff.handleRequest(
      new Request("http://gateway/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(legacy.status).toBe(299);
    expect(passthrough).toHaveLength(1);
    expect(acquired).toEqual([]);
    expect(engine.requests).toHaveLength(1);
    expect(snapshot(roots)).toEqual(untouched);
  });

  test("stopping the agent drains active attempts, then ends what remains with an acknowledged cancel", async () => {
    const files = await initAgent("stop-drain");
    const svc = serviceCredential("svc-stop");
    enableWorkerRpc(files, { serviceCredentials: [svc.binding] });
    const agent = serve(files);
    writeKubeconfig(files, agent, { workerRpc: { serviceCredentialRef: svc.ref } });
    engine.setScript({ pieces: ["Hel", "lo"], holdAfter: 1 });
    const fallback: string[] = [];
    const stuck = execute(gatewayExecutor(fallback)!, "att-stuck");
    const deadline = Date.now() + 5_000;
    while (engine.requests.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const aborted = engine.nextAbort();
    const started = Date.now();
    await agents.splice(agents.indexOf(agent), 1)[0]?.stop();
    // The drain window passed, then the attempt was cancelled, not orphaned.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
    await aborted;
    const ended = await stuck;
    expect(ended.status).toBe(200);
    expect(ended.body).toContain('"code":"cancelled"');
    expect(fallback).toEqual([]);
    expect(engine.requests).toHaveLength(1);
  }, 30_000);

  test("the base release parses the upgraded configs; an older build that re-saves agent.yaml drops only the worker-RPC block", async () => {
    const files = await initAgent("base-parse");
    const original = agentConfigMod.loadAgentConfig(files.configPath);
    const svc = serviceCredential("svc-base-parse");
    enableWorkerRpc(files, { serviceCredentials: [svc.binding] });
    // The base release's schemas: the same strict-shape z.object, minus the new optional fields.
    const { workerRpc: _agentBlock, ...baseAgentShape } = agentConfigMod.AgentConfigSchema.shape;
    const BaseAgentConfig = z.object(baseAgentShape);
    const upgraded = parseYaml(readFileSync(files.configPath, "utf8")) as unknown;
    const parsedByBase = BaseAgentConfig.parse(upgraded);
    expect(parsedByBase).toEqual(original);
    // A re-save by the older build drops the block, which this build reads as not advertised.
    agentConfigMod.saveAgentConfig(parsedByBase, files.configPath);
    expect(agentConfigMod.loadAgentConfig(files.configPath)).toEqual(original);
    expect(agentConfigMod.workerRpcSettingsReader(files.configPath)()).toBeUndefined();

    const agent = serve(files);
    writeKubeconfig(files, agent, { workerRpc: { serviceCredentialRef: svc.ref } });
    const kube = parseYaml(readFileSync(process.env["LLAMACTL_CONFIG"] ?? "", "utf8")) as {
      clusters: { nodes: Record<string, unknown>[] }[];
    };
    const { workerRpc: _nodeBlock, ...baseNodeShape } = configSchema.ClusterNodeSchema.shape;
    const BaseNode = z.object(baseNodeShape);
    for (const node of kube.clusters.flatMap((c) => c.nodes)) {
      expect(Object.keys(BaseNode.parse(node))).not.toContain("workerRpc");
    }
    expect((await negotiate(files, agent, files.operatorToken)).data).toEqual({
      outcome: "not-advertised",
      workerId: WORKER,
    });
  });
});

describe("I6: nothing new is mandatory", () => {
  test("required config fields match the recorded baseline", () => {
    expect(requiredKeys(agentConfigMod.AgentConfigSchema.shape)).toEqual(
      ["apiVersion", "certPath", "fingerprint", "keyPath", "kind", "tokenHash"].sort(),
    );
    expect(requiredKeys(configSchema.ConfigSchema.shape)).toEqual([
      "apiVersion",
      "currentContext",
      "kind",
    ]);
    expect(requiredKeys(configSchema.ContextSchema.shape)).toEqual(["cluster", "name", "user"]);
    expect(requiredKeys(configSchema.ClusterNodeSchema.shape)).toEqual(["name"]);
    expect(requiredKeys(configSchema.UserSchema.shape)).toEqual(["name"]);
    // The new blocks are optional, and their own fields default where they can.
    expect(agentConfigMod.AgentWorkerRpcSchema.parse({})).toEqual({
      versions: [],
      serviceCredentials: [],
    });
  });

  test("the service credential is optional, made with the existing token mechanics, stored once as a hash and once as a reference", async () => {
    const files = await initAgent("credential");
    const svc = serviceCredential("svc-credential");
    expect(svc.binding.tokenHash).toBe(auth.hashToken(svc.token));
    enableWorkerRpc(files, { serviceCredentials: [svc.binding] });
    const agentYaml = readFileSync(files.configPath, "utf8");
    expect(agentYaml).toContain(svc.binding.tokenHash);
    expect(agentYaml).not.toContain(svc.token);
    // A plaintext credential is never kept on the worker.
    const parsed = agentConfigMod.AgentWorkerRpcCredentialSchema.safeParse({
      ...svc.binding,
      tokenHash: svc.token,
    });
    expect(parsed.success).toBe(false);
    const agent = serve(files);
    writeKubeconfig(files, agent, { workerRpc: { serviceCredentialRef: svc.ref } });
    const kubeYaml = readFileSync(process.env["LLAMACTL_CONFIG"] ?? "", "utf8");
    expect(kubeYaml).toContain(svc.ref);
    expect(kubeYaml).not.toContain(svc.token);
    expect(kubeYaml).not.toContain(svc.binding.tokenHash);
    // The caller holds no provider key for the worker-owned deployment.
    expect(kubeYaml).not.toContain("apiKeyRef");
    expect(
      configSchema.ClusterNodeSchema.safeParse({ name: "n", endpoint: "https://x" }).success,
    ).toBe(true);
  });
});
