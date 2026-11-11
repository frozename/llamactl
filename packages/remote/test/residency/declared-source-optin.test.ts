/**
 * #280 DF-07 — the declared cold-model source registered by
 * startAgentServer behind an explicit opt-in. `StartAgentOptions` has
 * no `declaredModels` field at base, so the options are typed as
 * `StartAgentOptions & { declaredModels?: boolean }`: the file
 * typechecks at base, the flag is ignored, and (a), (c) and the first
 * assertion of (d) fail by assertion — never by import or type error.
 * (b) is the production-inert pin and passes at base.
 */
import { openaiProxy } from "@llamactl/core";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "../../src/safe-fs.js";
import { generateToken } from "../../src/server/auth.js";
import {
  type RunningAgent,
  type StartAgentOptions,
  startAgentServer,
} from "../../src/server/serve.js";
import { ModelRunSchema } from "../../src/workload/schema.js";

const COLD_PIN = "cold/model-a.gguf";

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
// node-name vars could turn the declared id into a default-target id.
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
let stub: ReturnType<typeof Bun.serve> | null = null;
let stubCalls: string[] = [];
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
  if (stub !== null) {
    await stub.stop(true);
    stub = null;
  }
  stubCalls = [];
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
  if (sandbox !== "") {
    rmSync(sandbox, { recursive: true, force: true });
    sandbox = "";
  }
});

function setupSandbox(): void {
  sandbox = mkdtempSync(join(tmpdir(), "llamactl-declared-optin-"));
  runtimeDir = join(sandbox, "runtime");
  workloadsDir = join(sandbox, "workloads");
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(workloadsDir, { recursive: true });
  process.env["DEV_STORAGE"] = join(sandbox, "dev-storage");
  process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
  process.env["LLAMACTL_WORKLOADS_DIR"] = workloadsDir;
  process.env["LLAMACTL_CONFIG"] = join(sandbox, "missing-kubeconfig.yaml");

  stubCalls = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req: Request): Response {
      stubCalls.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json({ ok: true });
    },
  });
  stub = server;
  process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
  process.env["LLAMA_CPP_PORT"] = String(server.port ?? 0);
}

function runColdYaml(specExtra: Record<string, unknown> = {}): string {
  return stringifyYaml(
    ModelRunSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: { name: "run-cold" },
      spec: {
        node: "local",
        target: { kind: "rel", value: COLD_PIN },
        ...specExtra,
      },
    }),
  );
}

function writeRunColdManifest(specExtra: Record<string, unknown> = {}): void {
  writeFileSync(join(workloadsDir, "run-cold.yaml"), runColdYaml(specExtra));
}

function agentOptions(declaredModels?: boolean): StartAgentOptions & { declaredModels?: boolean } {
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

describe("declared cold-model source opt-in (#280 DF-07)", () => {
  test("(a) opt-in: a cold declared pin returns 503 model_not_loaded, default target untouched", async () => {
    setupSandbox();
    writeRunColdManifest();
    const running = startAgentServer(agentOptions(true));
    agent = running;

    const res = await running.handleRequest!(postChatCompletions(COLD_PIN), LOOPBACK_CLIENT);

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; state: string; auto_load_eligible: boolean };
    };
    expect(body.error.code).toBe("model_not_loaded");
    expect(body.error.state).toBe("cold");
    expect(body.error.auto_load_eligible).toBe(true);
    expect(stubCalls).toHaveLength(0);
  });

  test("(b) inert default: without the opt-in the cold pin matches the no-source baseline", async () => {
    setupSandbox();
    writeRunColdManifest();
    const running = startAgentServer(agentOptions());
    agent = running;

    const pin = await running.handleRequest!(postChatCompletions(COLD_PIN), LOOPBACK_CLIENT);
    const pinStatus = pin.status;
    const pinText = await pin.text();
    expect(openaiProxy.listOpenAIModels().declared).toEqual([]);

    openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
    const baseline = await running.handleRequest!(postChatCompletions(COLD_PIN), LOOPBACK_CLIENT);

    expect(pinStatus).toBe(baseline.status);
    expect(pinText).toBe(await baseline.text());
    expect(pinStatus).not.toBe(503);
  });

  test("(c) opt-in: declared entries list while running and clear on stop", async () => {
    setupSandbox();
    writeRunColdManifest();
    const running = startAgentServer(agentOptions(true));
    agent = running;

    const entry = openaiProxy
      .listOpenAIModels()
      .declared.find((candidate) => candidate.id === COLD_PIN);
    expect(entry?.status).toBe("cold");

    await running.stop();
    agent = null;
    expect(openaiProxy.listOpenAIModels().declared).toEqual([]);
  });

  test("(d) opt-in: a cold pin during stop() returns 503 model_not_loaded, source not unregistered before server stops", async () => {
    setupSandbox();
    writeRunColdManifest();
    const running = startAgentServer(agentOptions(true));
    agent = running;

    // Verify the source is registered
    const entry = openaiProxy
      .listOpenAIModels()
      .declared.find((candidate) => candidate.id === COLD_PIN);
    expect(entry?.status).toBe("cold");

    // Start stop() without awaiting — this begins the drain/teardown sequence
    // but does not yet unregister the declared-model source (DF-07 fix).
    const stopPromise = running.stop();

    // Send a cold pin request while stop() is in-flight. The source is still
    // registered and the HTTP server is not yet fully stopped, so the proxy
    // must return 503 model_not_loaded (not fall through to the default
    // target stub).
    const res = await running.handleRequest!(postChatCompletions(COLD_PIN), LOOPBACK_CLIENT);

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; state: string; auto_load_eligible: boolean };
    };
    expect(body.error.code).toBe("model_not_loaded");
    expect(body.error.state).toBe("cold");
    expect(body.error.auto_load_eligible).toBe(true);
    expect(stubCalls).toHaveLength(0);

    // Complete the stop to clean up.
    await stopPromise;
    agent = null;
  });

  test("(d) opt-in: an in-place manifest disable is observed on the next request", async () => {
    setupSandbox();
    writeRunColdManifest();
    const running = startAgentServer(agentOptions(true));
    agent = running;

    const first = await running.handleRequest!(postChatCompletions(COLD_PIN), LOOPBACK_CLIENT);
    expect(first.status).toBe(503);
    const firstBody = (await first.json()) as { error: { code: string } };
    expect(firstBody.error.code).toBe("model_not_loaded");

    const before = statSync(workloadsDir, { bigint: true }).mtimeNs;
    writeRunColdManifest({ enabled: false });
    expect(statSync(workloadsDir, { bigint: true }).mtimeNs).toBe(before);

    const second = await running.handleRequest!(postChatCompletions(COLD_PIN), LOOPBACK_CLIENT);
    expect(second.status).toBe(503);
    const secondBody = (await second.json()) as {
      error: { code: string; state: string; auto_load_eligible: boolean };
    };
    expect(secondBody.error.code).toBe("model_unavailable");
    expect(secondBody.error.state).toBe("disabled");
    expect(secondBody.error.auto_load_eligible).toBe(false);
    expect(stubCalls).toHaveLength(0);
  });
});
