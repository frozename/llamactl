/**
 * #280 DF-07 — the declared cold-model source registered by
 * startAgentServer behind an explicit opt-in. `StartAgentOptions` has
 * no `declaredModels` field at base, so the options are typed as
 * `StartAgentOptions & { declaredModels?: boolean }`: the file
 * typechecks at base, the flag is ignored, and (a), (c) and the first
 * assertion of (d) fail by assertion — never by import or type error.
 * (b) is the production-inert pin and passes at base.
 *
 * (e) pins that a request already inside the handler when `stop()` began
 * still reads the declared source, (f) pins the other side of the same
 * seam — without the opt-in nothing is tracked, so `stop()` never waits on
 * a client request — and (g) pins where the source takes its `liveModelIds`
 * from: a fresh read of the local routes, not the proxy's cached ones.
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
  TERMINAL_FLUSH_MS,
} from "../../src/server/serve.js";
import { ModelRunSchema } from "../../src/workload/schema.js";

const COLD_PIN = "cold/model-a.gguf";
const WARM_PIN = "served/model-b.gguf";

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

/**
 * Same request, but the body lands `delayMs` after the handler took it —
 * the route miss is resolved only once the body is read, so this is what
 * makes a request still in flight while `stop()` runs.
 */
function lateBodyChatCompletions(model: string, delayMs: number): Request {
  const payload = JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] });
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      }, delayMs);
    },
  });
  // The strict typecheck's RequestInit omits `duplex`; the intersection names
  // it without a cast so a stream body still builds a half-duplex Request.
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  };
  return new Request("http://x/v1/chat/completions", init);
}

function writeLlamaServerState(workload: string, rel: string, port: number): void {
  writeFileSync(
    join(runtimeDir, "workloads", workload, "llama-server.state"),
    JSON.stringify({
      rel,
      extraArgs: [],
      host: "127.0.0.1",
      port,
      binary: "/x/llama-server",
      pid: process.pid,
      startedAt: "2026-05-24T00:00:00.000Z",
      tunedProfile: null,
    }),
  );
}

/** A live llama-server route for `rel`, backed by this test process's pid. */
function seedLiveRoute(workload: string, rel: string, port: number): void {
  const dir = join(runtimeDir, "workloads", workload);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(process.pid)}\n`);
  writeLlamaServerState(workload, rel, port);
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

    // Start stop() without awaiting — the drain/teardown sequence begins,
    // but the declared-model source survives until the HTTP server, the
    // tunnel client and every request already inside the handler are done.
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

    // Complete the stop to clean up: only now is the source gone.
    await stopPromise;
    agent = null;
    expect(openaiProxy.listOpenAIModels().declared).toEqual([]);
    expect(stubCalls).toHaveLength(0);
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

  test("(e) opt-in: a request accepted before stop() whose body lands mid-teardown still gets 503", async () => {
    setupSandbox();
    writeRunColdManifest();
    const running = startAgentServer(agentOptions(true));
    agent = running;

    // The handler takes the request while the listener is still up, then
    // awaits the body. stop() runs entirely inside that window, so without
    // in-flight tracking the source is unregistered before the route miss
    // is resolved and the pin falls through to the default target.
    const inflight = running.handleRequest!(
      lateBodyChatCompletions(COLD_PIN, 120),
      LOOPBACK_CLIENT,
    );
    const stopPromise = running.stop();

    const res = await inflight;
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; state: string; auto_load_eligible: boolean };
    };
    expect(body.error.code).toBe("model_not_loaded");
    expect(body.error.state).toBe("cold");
    expect(body.error.auto_load_eligible).toBe(true);
    expect(stubCalls).toHaveLength(0);

    await stopPromise;
    agent = null;
  });

  test("(f) inert default: stop() does not wait for an in-flight request without the opt-in", async () => {
    setupSandbox();
    writeRunColdManifest();
    const running = startAgentServer(agentOptions());
    agent = running;

    // The body outlives the whole flush window, so a handler wrapped for
    // tracking would hold stop() open for TERMINAL_FLUSH_MS. With no
    // declared source registered there is nothing to keep alive.
    const inflight = running.handleRequest!(
      lateBodyChatCompletions(COLD_PIN, TERMINAL_FLUSH_MS + 200),
      LOOPBACK_CLIENT,
    );
    const startedAt = Date.now();
    await running.stop();
    agent = null;
    expect(Date.now() - startedAt).toBeLessThan(TERMINAL_FLUSH_MS);

    // The late request is still answered — over the default target, which
    // is exactly the pre-#610 behaviour.
    const res = await inflight;
    expect(res.status).toBe(200);
    expect(stubCalls).toContain("POST /v1/chat/completions");
  });

  test("(g) opt-in: the live-model set is read fresh from local routes, not from the cached ones", async () => {
    setupSandbox();
    writeRunColdManifest();
    const running = startAgentServer(agentOptions(true));
    agent = running;

    // A live route for another model warms the route and models caches.
    // Rewriting llama-server.state in place is invisible to the cache
    // signature, so after the rewrite only a reader that goes back to
    // listLocalRoutes sees the declared rel served — which is exactly what
    // the source's live-model projection has to do. A cached or empty set
    // would leave the claim cold: `declared` would list it and the pin
    // would get a 503 instead of an answer.
    seedLiveRoute("run-cold", WARM_PIN, stub!.port ?? 0);
    const warmed = openaiProxy.listOpenAIModels();
    expect(warmed.data.map((model) => model.id)).toEqual([WARM_PIN]);
    expect(warmed.declared.find((entry) => entry.id === COLD_PIN)?.status).toBe("cold");

    writeLlamaServerState("run-cold", COLD_PIN, stub!.port ?? 0);

    const models = openaiProxy.listOpenAIModels();
    expect(models.data.map((model) => model.id)).toEqual([WARM_PIN]);
    expect(models.declared.find((entry) => entry.id === COLD_PIN)).toBeUndefined();

    const served = await running.handleRequest!(postChatCompletions(COLD_PIN), LOOPBACK_CLIENT);
    expect(served.status).toBe(200);
  });
});
