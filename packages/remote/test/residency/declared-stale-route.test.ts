/**
 * #280 DF-07 — serve-level stale binding. With the declaredModels
 * opt-in, a pin whose declared entry is stale (the owner epoch or the
 * artifact revision moved under a live route) is refused by the routed
 * branch with the declared 503 instead of forwarded to the engine
 * still serving the old binding. `liveRoutes` and the stale reasons
 * land with the fix: at base both pins forward with 200, so the status
 * assertion fails by assertion — never by import or type error. The
 * flag-off and current-binding cases are guards that pass at base and
 * must keep passing.
 */
import { openaiProxy } from "@llamactl/core";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { generateToken } from "../../src/server/auth.js";
import {
  type RunningAgent,
  type StartAgentOptions,
  startAgentServer,
} from "../../src/server/serve.js";
import { ModelHostManifestSchema } from "../../src/workload/modelhost-schema.js";

const LOOPBACK_CLIENT = { address: "127.0.0.1", port: 12345, family: "IPv4" };

const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMACTL_WORKLOADS_DIR",
  "LLAMACTL_CONFIG",
  "LLAMA_CPP_HOST",
  "LLAMA_CPP_PORT",
  "LLAMA_CPP_SERVER_ALIAS",
  "LLAMA_CPP_DEFAULT_MODEL",
  "LLAMACTL_UNIFIED_PROXY",
  "LLAMACTL_NODE_NAME",
] as const;

// Deleted for every test: the unified flag would reroute /v1/* away from
// the legacy passthrough the fix targets, and the alias / default-model /
// node-name vars could turn the pinned id into a default-target id.
const INERT_ENV_KEYS = [
  "LLAMACTL_UNIFIED_PROXY",
  "LLAMA_CPP_SERVER_ALIAS",
  "LLAMA_CPP_DEFAULT_MODEL",
  "LLAMACTL_NODE_NAME",
] as const;

let envBackup: Record<string, string | undefined> = {};
let sandbox = "";
let runtimeDir = "";
let workloadsDir = "";
let hostPort = 0;
let defaultStub: ReturnType<typeof Bun.serve> | null = null;
let hostStub: ReturnType<typeof Bun.serve> | null = null;
let defaultCalls: string[] = [];
let hostCalls: string[] = [];
let agent: RunningAgent | null = null;

beforeAll(() => {
  envBackup = {};
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
  for (const key of INERT_ENV_KEYS) Reflect.deleteProperty(process.env, key);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const prev = envBackup[key];
    if (prev === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = prev;
  }
});

afterEach(async () => {
  await agent?.stop();
  agent = null;
  if (defaultStub !== null) {
    await defaultStub.stop(true);
    defaultStub = null;
  }
  if (hostStub !== null) {
    await hostStub.stop(true);
    hostStub = null;
  }
  defaultCalls = [];
  hostCalls = [];
  hostPort = 0;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
  const seam = (openaiProxy as unknown as Record<string, unknown>)[
    "__setOpenAIProxyServingReadinessForTests"
  ] as ((value: null) => void) | undefined;
  seam?.(null);
  if (sandbox !== "") {
    rmSync(sandbox, { recursive: true, force: true });
    sandbox = "";
  }
});

const chatCalls = (calls: string[]): string[] =>
  calls.filter((entry) => entry === "POST /v1/chat/completions");

function setupSandbox(): void {
  sandbox = mkdtempSync(join(tmpdir(), "llamactl-declared-stale-"));
  runtimeDir = join(sandbox, "runtime");
  workloadsDir = join(sandbox, "workloads");
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(workloadsDir, { recursive: true });
  process.env["DEV_STORAGE"] = join(sandbox, "dev-storage");
  process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
  process.env["LLAMACTL_WORKLOADS_DIR"] = workloadsDir;
  process.env["LLAMACTL_CONFIG"] = join(sandbox, "missing-kubeconfig.yaml");

  defaultCalls = [];
  const defaultServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req: Request): Response {
      defaultCalls.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json({ ok: true });
    },
  });
  defaultStub = defaultServer;
  process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
  process.env["LLAMA_CPP_PORT"] = String(defaultServer.port ?? 0);

  hostCalls = [];
  const hostServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req: Request): Response {
      const path = new URL(req.url).pathname;
      hostCalls.push(`${req.method} ${path}`);
      if (path === "/v1/chat/completions") {
        return Response.json({
          id: "chatcmpl-stale-host",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  hostStub = hostServer;
  hostPort = hostServer.port ?? 0;
}

function writeHostManifest(name: string, rel: string): void {
  writeFileSync(
    join(workloadsDir, `${name}.yaml`),
    stringifyYaml(
      ModelHostManifestSchema.parse({
        apiVersion: "llamactl/v1",
        kind: "ModelHost",
        metadata: { name },
        spec: {
          engine: "llamacpp",
          node: "local",
          binary: "/x/llama-server",
          endpoint: { host: "127.0.0.1", port: hostPort },
          hostedModels: [{ rel }],
        },
      }),
    ),
  );
}

// The runtime record is the live binding: modelAliases order is the
// served-artifact order listLocalRoutes reports. No readiness probe —
// the routes are servable as soon as they exist.
function writeHostRuntime(name: string, modelAliases: readonly string[]): void {
  const dir = join(runtimeDir, "workloads", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "modelhost.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(dir, "modelhost.state"),
    JSON.stringify({
      kind: "ModelHost",
      engine: "llamacpp",
      pid: process.pid,
      host: "127.0.0.1",
      port: hostPort,
      modelAliases: [...modelAliases],
      startedAt: "2026-11-15T00:00:00.000Z",
    }),
  );
}

function agentOptions(declaredModels?: boolean): StartAgentOptions {
  return {
    tokenHash: generateToken().hash,
    noAuth: true,
    bindHost: "127.0.0.1",
    port: 0,
    // Deliberately not "local": production agents run under their own
    // node name while the manifest keeps spec.node "local".
    nodeName: "node-a",
    ...(declaredModels === true ? { declaredModels: true } : {}),
  };
}

function postChatCompletions(model: string): Request {
  return new Request("http://x/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

interface DeclaredErrorBody {
  error: {
    code: string;
    message: string;
    state: string;
    auto_load_eligible: boolean;
    reason?: string;
  };
}

describe("declared stale route (#280 DF-07)", () => {
  test("(a) a pin live under a stale artifact revision is refused 503", async () => {
    // Kills: (i) removing the routed-branch stale refusal in
    // openaiProxy.applyBodyModelRoute, (ii) serve.ts not passing
    // liveRoutes into listDeclaredModels.
    setupSandbox();
    writeHostManifest("host-a", "new/m.gguf");
    writeHostRuntime("host-a", ["old/m.gguf", "m.gguf"]);
    const running = startAgentServer(agentOptions(true));
    agent = running;

    const res = await running.handleRequest!(postChatCompletions("m.gguf"), LOOPBACK_CLIENT);

    expect(res.status).toBe(503);
    const body = (await res.json()) as DeclaredErrorBody;
    expect(body.error.code).toBe("model_not_loaded");
    expect(body.error.state).toBe("cold");
    expect(body.error.auto_load_eligible).toBe(false);
    expect(body.error.reason).toBe("stale-artifact-revision");
    expect(body.error.message).toContain("is declared but not loaded (state: cold)");
    expect(chatCalls(hostCalls)).toHaveLength(0);
    expect(chatCalls(defaultCalls)).toHaveLength(0);
  });

  test("(b) a pin live under a different workload epoch is refused 503", async () => {
    // Kills: the owner mutation, end to end.
    setupSandbox();
    writeHostManifest("host-v2", "fam/m.gguf");
    writeHostRuntime("host-v1", ["fam/m.gguf", "m.gguf"]);
    const running = startAgentServer(agentOptions(true));
    agent = running;

    const res = await running.handleRequest!(postChatCompletions("fam/m.gguf"), LOOPBACK_CLIENT);

    expect(res.status).toBe(503);
    const body = (await res.json()) as DeclaredErrorBody;
    expect(body.error.code).toBe("model_not_loaded");
    expect(body.error.state).toBe("cold");
    expect(body.error.auto_load_eligible).toBe(false);
    expect(body.error.reason).toBe("stale-owner-epoch");
    expect(body.error.message).toContain("is declared but not loaded (state: cold)");
    expect(chatCalls(hostCalls)).toHaveLength(0);
    expect(chatCalls(defaultCalls)).toHaveLength(0);
  });

  test("(c) guard: without the declaredModels opt-in the stale fixture still forwards", async () => {
    // Kills: consulting staleness when no declared source is registered.
    setupSandbox();
    writeHostManifest("host-a", "new/m.gguf");
    writeHostRuntime("host-a", ["old/m.gguf", "m.gguf"]);
    const running = startAgentServer(agentOptions());
    agent = running;

    const res = await running.handleRequest!(postChatCompletions("m.gguf"), LOOPBACK_CLIENT);

    expect(res.status).toBe(200);
    expect(chatCalls(hostCalls)).toHaveLength(1);
    expect(chatCalls(defaultCalls)).toHaveLength(0);
  });

  test("(d) guard: a current owner and artifact binding still forwards the pin", async () => {
    // Kills: refusing every routed declared id.
    setupSandbox();
    writeHostManifest("host-a", "fam/m.gguf");
    writeHostRuntime("host-a", ["fam/m.gguf", "m.gguf"]);
    const running = startAgentServer(agentOptions(true));
    agent = running;

    const res = await running.handleRequest!(postChatCompletions("m.gguf"), LOOPBACK_CLIENT);

    expect(res.status).toBe(200);
    expect(chatCalls(hostCalls)).toHaveLength(1);
    expect(chatCalls(defaultCalls)).toHaveLength(0);
  });
});
