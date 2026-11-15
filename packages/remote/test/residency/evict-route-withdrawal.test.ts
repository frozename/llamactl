/**
 * #280 DF-07 — a fenced workload stop must withdraw the workload's serving
 * routes for the stop's duration: a pinned request inside the window gets
 * the typed draining 503 (the declared catalog state when the declaredModels
 * opt-in is on, the synthesized 'route-withdrawn' rejection otherwise),
 * upstreams see no traffic, and every settle path — verified, unverified,
 * rejected — restores the route. withdrawServingRoute /
 * servingWithdrawnWorkloads land with the fix in core, so they are reached
 * through a namespace lookup that degrades to undefined/empty at base;
 * every RED case fails by assertion, never by import or type error.
 */
import { openaiProxy } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import {
  createResidencyLeases,
  type ResidencyLeases,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { listLocalRoutes } from "@llamactl/core/workloadRuntime";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { listDeclaredModels } from "../../src/residency/catalog.js";
import { fenceWorkloadStop } from "../../src/residency/stop-fence.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { generateToken } from "../../src/server/auth.js";
import {
  type RunningAgent,
  type StartAgentOptions,
  startAgentServer,
} from "../../src/server/serve.js";
import { ModelHostManifestSchema } from "../../src/workload/modelhost-schema.js";

const VICTIM = "host-victim";
const BYSTANDER = "host-bystander";
const VICTIM_PIN = "victim/model.gguf";
const BYSTANDER_PIN = "bystander/model.gguf";

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

type HostStopResult = { ok: boolean; pid: number | null; error?: string };

interface PendingStop {
  promise: Promise<HostStopResult>;
  resolve: (value: HostStopResult) => void;
  reject: (error: unknown) => void;
}

function deferredStop(): PendingStop {
  let resolve!: (value: HostStopResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<HostStopResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const servingWithdrawnWorkloads = (): ReadonlySet<string> =>
  (
    (openaiProxy as unknown as Record<string, unknown>)["servingWithdrawnWorkloads"] as
      | (() => ReadonlySet<string>)
      | undefined
  )?.() ?? new Set<string>();

let envBackup: Record<string, string | undefined> = {};
let sandbox = "";
let runtimeDir = "";
let workloadsDir = "";
let defaultStub: ReturnType<typeof Bun.serve> | null = null;
let victimStub: ReturnType<typeof Bun.serve> | null = null;
let bystanderStub: ReturnType<typeof Bun.serve> | null = null;
let defaultCalls: string[] = [];
let victimCalls: string[] = [];
let bystanderCalls: string[] = [];
let agent: RunningAgent | null = null;
let pendingStop: PendingStop | null = null;
let pendingFence: Promise<HostStopResult> | null = null;

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
  pendingStop?.resolve({ ok: false, pid: null, error: "afterEach" });
  pendingStop = null;
  if (pendingFence !== null) {
    await pendingFence.then(
      () => undefined,
      () => undefined,
    );
    pendingFence = null;
  }
  await agent?.stop();
  agent = null;
  for (const stub of [defaultStub, victimStub, bystanderStub]) {
    if (stub !== null) await stub.stop(true);
  }
  defaultStub = null;
  victimStub = null;
  bystanderStub = null;
  defaultCalls = [];
  victimCalls = [];
  bystanderCalls = [];
  setResidencyLeaseRegistry(null);
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

function chatStub(calls: string[]): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req: Request): Response {
      const path = new URL(req.url).pathname;
      calls.push(`${req.method} ${path}`);
      if (path === "/v1/chat/completions") {
        return Response.json({
          id: "chatcmpl-evict-route",
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
}

function writeHostManifest(name: string, rel: string, port: number): void {
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
          endpoint: { host: "127.0.0.1", port },
          hostedModels: [{ rel }],
        },
      }),
    ),
  );
}

function writeHostRuntime(name: string, rel: string, port: number): void {
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
      port,
      modelAliases: [rel],
      startedAt: "2026-11-14T00:00:00.000Z",
    }),
  );
}

function setupSandbox(): void {
  sandbox = mkdtempSync(join(tmpdir(), "llamactl-evict-route-"));
  runtimeDir = join(sandbox, "runtime");
  workloadsDir = join(sandbox, "workloads");
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(workloadsDir, { recursive: true });
  process.env["DEV_STORAGE"] = join(sandbox, "dev-storage");
  process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
  process.env["LLAMACTL_WORKLOADS_DIR"] = workloadsDir;
  process.env["LLAMACTL_CONFIG"] = join(sandbox, "missing-kubeconfig.yaml");

  defaultCalls = [];
  defaultStub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req: Request): Response {
      defaultCalls.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json({ ok: true });
    },
  });
  process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
  process.env["LLAMA_CPP_PORT"] = String(defaultStub.port ?? 0);

  victimCalls = [];
  victimStub = chatStub(victimCalls);
  bystanderCalls = [];
  bystanderStub = chatStub(bystanderCalls);

  writeHostManifest(VICTIM, VICTIM_PIN, victimStub.port ?? 0);
  writeHostRuntime(VICTIM, VICTIM_PIN, victimStub.port ?? 0);
  writeHostManifest(BYSTANDER, BYSTANDER_PIN, bystanderStub.port ?? 0);
  writeHostRuntime(BYSTANDER, BYSTANDER_PIN, bystanderStub.port ?? 0);
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

// Starts fenceWorkloadStop on the victim with a stop() that stays pending
// until the test settles it, so the withdrawal window stays open while
// requests are made. `registry: null` exercises the no-registry path; a
// published registry exercises the fenced path.
function beginPendingStop(registry: ResidencyLeases | null): {
  fenced: Promise<HostStopResult>;
  settle: (result: HostStopResult) => void;
  fail: (error: unknown) => void;
} {
  const stop = deferredStop();
  pendingStop = stop;
  const fenced = fenceWorkloadStop<HostStopResult>({
    workload: VICTIM,
    registry,
    stop: () => stop.promise,
    isVerifiedStop: (r) => r.ok,
    refuse: (f) => ({ ok: false, pid: null, error: `${f.reason}: ${f.active.join(", ")}` }),
  });
  pendingFence = fenced;
  // Mark the rejection handled so a mid-test failure cannot surface as an
  // unhandled rejection before afterEach awaits it; awaiters of `fenced`
  // still observe the rejection.
  void fenced.catch(() => undefined);
  return { fenced, settle: stop.resolve, fail: stop.reject };
}

async function pinVictim(running: RunningAgent): Promise<Response> {
  const res = await running.handleRequest!(postChatCompletions(VICTIM_PIN), LOOPBACK_CLIENT);
  return res;
}

describe("evict route withdrawal (#280 DF-07)", () => {
  test("(a) during a stop with no lease registry, a pinned request for the victim gets the declared draining 503 and the upstream is not called", async () => {
    // Kills: fenceWorkloadStop's no-registry path not withdrawing, and
    // serve.ts not passing withdrawnWorkloads to listDeclaredModels (the
    // reason would then be 'route-withdrawn').
    setupSandbox();
    const running = startAgentServer(agentOptions(true));
    agent = running;
    const { fenced, settle } = beginPendingStop(null);

    const res = await pinVictim(running);

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
    expect(body.error.state).toBe("draining");
    expect(body.error.auto_load_eligible).toBe(false);
    expect(body.error.reason).toBeUndefined();
    expect(chatCalls(victimCalls)).toHaveLength(0);
    expect(chatCalls(defaultCalls)).toHaveLength(0);

    const bystander = await running.handleRequest!(
      postChatCompletions(BYSTANDER_PIN),
      LOOPBACK_CLIENT,
    );
    expect(bystander.status).toBe(200);
    await bystander.text();
    expect(chatCalls(bystanderCalls)).toHaveLength(1);

    settle({ ok: true, pid: null });
    await fenced;
  });

  test("(b) without the declared opt-in the window rejection is synthesized", async () => {
    // Kills: withdrawing only when a declared source is registered — the
    // route withdrawal must hold with no declaredModels opt-in.
    setupSandbox();
    const running = startAgentServer(agentOptions());
    agent = running;
    const { fenced, settle } = beginPendingStop(null);

    const res = await pinVictim(running);

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; state: string; reason?: string };
    };
    expect(body.error.code).toBe("model_not_loaded");
    expect(body.error.state).toBe("draining");
    expect(body.error.reason).toBe("route-withdrawn");
    expect(chatCalls(victimCalls)).toHaveLength(0);
    expect(chatCalls(defaultCalls)).toHaveLength(0);

    settle({ ok: true, pid: null });
    await fenced;
  });

  test("(c) a rolled-back stop restores the route", async () => {
    // Kills: releasing only on the verified path, and a missing finally on
    // throw.
    setupSandbox();
    const running = startAgentServer(agentOptions(true));
    agent = running;

    const first = beginPendingStop(null);
    const res = await pinVictim(running);
    expect(res.status).toBe(503);
    await res.text();
    expect(chatCalls(victimCalls)).toHaveLength(0);
    expect(chatCalls(defaultCalls)).toHaveLength(0);

    first.settle({ ok: false, pid: null, error: "x" });
    await first.fenced;

    const restored = await pinVictim(running);
    expect(restored.status).toBe(200);
    await restored.text();
    expect(chatCalls(victimCalls)).toHaveLength(1);
    expect(servingWithdrawnWorkloads().has(VICTIM)).toBe(false);

    const second = beginPendingStop(null);
    const res2 = await pinVictim(running);
    expect(res2.status).toBe(503);
    await res2.text();

    const err = new Error("stop exploded");
    second.fail(err);
    let caught: unknown;
    try {
      await second.fenced;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err);

    const restored2 = await pinVictim(running);
    expect(restored2.status).toBe(200);
    await restored2.text();
    expect(servingWithdrawnWorkloads().has(VICTIM)).toBe(false);
  });

  test("(d) a verified stop leaves the route gone", async () => {
    // Kills: leaking the marker after success, and restoring before the
    // record is gone.
    setupSandbox();
    const running = startAgentServer(agentOptions(true));
    agent = running;
    const { fenced, settle } = beginPendingStop(null);

    const res = await pinVictim(running);
    expect(res.status).toBe(503);
    await res.text();
    expect(chatCalls(victimCalls)).toHaveLength(0);
    expect(chatCalls(defaultCalls)).toHaveLength(0);

    rmSync(join(runtimeDir, "workloads", VICTIM), { recursive: true, force: true });
    settle({ ok: true, pid: null });
    await fenced;

    const after = await pinVictim(running);
    expect(after.status).not.toBe(200);
    await after.text();
    expect(chatCalls(victimCalls)).toHaveLength(0);
    expect(chatCalls(defaultCalls)).toHaveLength(0);

    const input: Parameters<typeof listDeclaredModels>[0] & {
      withdrawnWorkloads?: ReadonlySet<string>;
    } = {
      nodeName: "local",
      liveModelIds: new Set(listLocalRoutes(resolveEnv()).map((route) => route.model)),
      withdrawnWorkloads: servingWithdrawnWorkloads(),
    };
    const entries = listDeclaredModels(input);
    expect(entries.find((entry) => entry.id === VICTIM_PIN)?.state).toBe("cold");
  });

  test("(e) with a lease registry published, the fenced window answers with the declared draining 503, and a LeasesActive refusal withdraws nothing", async () => {
    // Kills: withdrawing before or around the LeasesActive refusal (the
    // captured-in-refuse assertion), and leaving the lease-acquire 503 as
    // the only window refusal.
    setupSandbox();
    const registry = createResidencyLeases();
    setResidencyLeaseRegistry(registry);
    const running = startAgentServer(agentOptions(true));
    agent = running;

    const acquired = registry.acquire(VICTIM);
    if (!acquired.ok) {
      throw new Error("expected lease acquire to succeed");
    }
    const heldLease = acquired.lease;

    let withdrawnDuringRefuse: boolean | undefined;
    let stopCalls = 0;
    const refused = await fenceWorkloadStop<HostStopResult>({
      workload: VICTIM,
      registry,
      stop: () => {
        stopCalls += 1;
        return Promise.resolve({ ok: true, pid: null });
      },
      isVerifiedStop: (r) => r.ok,
      refuse: (f) => {
        withdrawnDuringRefuse = servingWithdrawnWorkloads().has(VICTIM);
        return { ok: false, pid: null, error: `${f.reason}: ${f.active.join(", ")}` };
      },
    });

    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("LeasesActive");
    expect(stopCalls).toBe(0);
    expect(withdrawnDuringRefuse).toBe(false);
    expect(servingWithdrawnWorkloads().has(VICTIM)).toBe(false);

    const res = await pinVictim(running);
    expect(res.status).toBe(200);
    await res.text();
    expect(chatCalls(victimCalls)).toHaveLength(1);
    expect(heldLease.release()).toBe(true);
    expect(registry.active(VICTIM)).toEqual([]);

    const { fenced, settle } = beginPendingStop(registry);
    const draining = await pinVictim(running);
    expect(draining.status).toBe(503);
    const body = (await draining.json()) as { error: { code: string; state: string } };
    expect(body.error.code).toBe("model_not_loaded");
    expect(body.error.state).toBe("draining");

    settle({ ok: true, pid: null });
    await fenced;
  });
});
