/**
 * #280 DF-07 — a live ModelHost route whose declared readiness probe
 * fails must not receive chat traffic: the pin gets the typed 503
 * instead of a forward. With the declaredModels opt-in the 503 carries
 * the declared catalog state ('loading', auto_load_eligible false, no
 * synthesized reason — the state comes from the warmingModelIds
 * projection); without it the proxy synthesizes 'serving-readiness-
 * pending'. Both cases forward at base, so the status assertion fails
 * by assertion — never by import or type error.
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

const WARM_PIN = "warm/model.gguf";

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
  sandbox = mkdtempSync(join(tmpdir(), "llamactl-declared-warming-"));
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
      if (path === "/ready") {
        return Response.json({ status: "loading" }, { status: 503 });
      }
      if (path === "/v1/chat/completions") {
        return Response.json({
          id: "chatcmpl-warm-host",
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

  writeWarmHostFixtures(hostServer.port ?? 0);
}

function writeWarmHostFixtures(hostPort: number): void {
  writeFileSync(
    join(workloadsDir, "host-warm.yaml"),
    stringifyYaml(
      ModelHostManifestSchema.parse({
        apiVersion: "llamactl/v1",
        kind: "ModelHost",
        metadata: { name: "host-warm" },
        spec: {
          engine: "llamacpp",
          node: "local",
          binary: "/x/llama-server",
          endpoint: { host: "127.0.0.1", port: hostPort },
          hostedModels: [{ rel: WARM_PIN }],
        },
      }),
    ),
  );

  const dir = join(runtimeDir, "workloads", "host-warm");
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
      modelAliases: [WARM_PIN],
      startedAt: "2026-11-14T00:00:00.000Z",
      readiness: { path: "/ready" },
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

describe("declared warming route (#280 DF-07)", () => {
  test("(a) opt-in: a warming declared pin returns 503 with the declared loading state", async () => {
    // Kills: serve.ts not passing warmingModelIds into listDeclaredModels,
    // and catalog.ts ignoring it — both leave the declared entry 'ready',
    // so the pin falls back to the synthesized 'serving-readiness-pending'
    // rejection instead of the declaration's own state.
    setupSandbox();
    const running = startAgentServer(agentOptions(true));
    agent = running;

    const res = await running.handleRequest!(postChatCompletions(WARM_PIN), LOOPBACK_CLIENT);

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: {
        code: string;
        state: string;
        auto_load_eligible: boolean;
        reason?: string;
      };
    };
    expect(body.error.code).toBe("model_not_loaded");
    expect(body.error.state).toBe("loading");
    expect(body.error.auto_load_eligible).toBe(false);
    expect(body.error.reason).toBeUndefined();
    expect(chatCalls(hostCalls)).toHaveLength(0);
    expect(chatCalls(defaultCalls)).toHaveLength(0);
  });

  test("(b) inert default: without the opt-in the warming pin gets the synthesized rejection", async () => {
    // Kills: gating only when a declared source is registered — the
    // readiness gate must hold with no declaredModels opt-in.
    setupSandbox();
    const running = startAgentServer(agentOptions());
    agent = running;

    const res = await running.handleRequest!(postChatCompletions(WARM_PIN), LOOPBACK_CLIENT);

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; state: string; reason?: string };
    };
    expect(body.error.code).toBe("model_not_loaded");
    expect(body.error.state).toBe("loading");
    expect(body.error.reason).toBe("serving-readiness-pending");
    expect(chatCalls(hostCalls)).toHaveLength(0);
    expect(chatCalls(defaultCalls)).toHaveLength(0);
  });
});
