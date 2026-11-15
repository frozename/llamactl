// #284 (DF-11): `llamactl.residency.applyProfile` MCP tool — RED tests pinning
// the destructive projection of the residencyApplyProfile mutation. At the
// pinned base the tool is not registered, so every case fails by assertion:
// listTools lacks the name and callTool rejects as an unknown tool. The new
// remote module is reached only through a guarded dynamic import whose exports
// are asserted `typeof === "function"`.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  CompatibilityCallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openResidencyOperationStore,
  type ResidencyLifecycleStore,
  type ResidencyOperationStore,
} from "../../remote/src/residency/store.js";
import { router } from "../../remote/src/router.js";
import { saveNodeRun } from "../../remote/src/workload/noderun-store.js";
import { type ModelRun, ModelRunSchema } from "../../remote/src/workload/schema.js";
import { saveWorkload } from "../../remote/src/workload/store.js";
import { existsSync, mkdtempSync, rmSync } from "../src/safe-fs.js";
import { buildMcpServer } from "../src/server.js";

let runtimeDir = "";
let auditDir = "";
let storePath = "";
const originalEnv = { ...process.env };
let stepCalls: [string, string][] = [];

type StepOutcome = { ok: true } | { ok: false; detail: string };

type ApplyProfileSteps = {
  stop: (workload: string) => Promise<StepOutcome>;
  start: (workload: string) => Promise<StepOutcome>;
};

type ApplyProfileResult = {
  ok: boolean;
  dryRun?: boolean;
  outcome: string;
  operationId?: string | null;
  refusal?: { reason: string; detail: string };
  inFlightOperationId?: string | null;
};

type FenceIdentity = { ownerId: string; incarnation: string };

type Fence = { ownerId: string; incarnation: string; fenceToken: number };

type StoreHandle = ResidencyOperationStore & ResidencyLifecycleStore;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-mcp-runtime-"));
  auditDir = mkdtempSync(join(tmpdir(), "llamactl-mcp-audit-"));
  storePath = join(runtimeDir, "residency-state", "operations.sqlite");
  // Scope llamactl state (preset-overrides.tsv etc.) + audit writes
  // into the sandbox so no test touches the real `~/.llamactl`.
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: runtimeDir,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LOCAL_AI_PRESET_OVERRIDES_FILE: join(runtimeDir, "preset-overrides.tsv"),
    LLAMACTL_MCP_AUDIT_DIR: auditDir,
    LLAMACTL_WORKLOADS_DIR: join(runtimeDir, "workloads"),
    LLAMACTL_EMBERSYNTH_CONFIG: join(runtimeDir, "embersynth.yaml"),
    LLAMACTL_CONFIG: join(runtimeDir, "config"),
    LLAMACTL_MCP_PIPELINES_DIR: join(runtimeDir, "mcp-pipelines"),
    LLAMACTL_RESIDENCY_STORE: storePath,
    LLAMACTL_NODE_NAME: "local",
  });
  setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  stepCalls = [];
});

afterEach(async () => {
  await resetStepsSeam();
  setSystemTime();
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  rmSync(runtimeDir, { recursive: true, force: true });
  rmSync(auditDir, { recursive: true, force: true });
});

async function connected(): Promise<{ client: Client; server: McpServer }> {
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text: string }[] }).content ?? [];
  return content[0]?.text ?? "";
}

type GuardedToolResult =
  | CallToolResult
  | CompatibilityCallToolResult
  | { isError: boolean; content: { type: string; text: string }[] };

function guardedCallTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<GuardedToolResult> {
  return client.callTool({ name, arguments: args }).then(
    (result) => result,
    (err: unknown) => ({ isError: true, content: [{ type: "text", text: String(err) }] }),
  );
}

function runManifest(
  name: string,
  options: {
    profiles?: string;
    phase?: "Pending" | "Running" | "Failed" | "Stopped";
    expectedMemoryGiB?: number;
  } = {},
): ModelRun {
  const annotations =
    options.profiles === undefined
      ? undefined
      : { ["llamactl.io/residency-profiles"]: options.profiles };
  return ModelRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: {
      name,
      ...(annotations === undefined ? {} : { annotations }),
    },
    spec: {
      node: "local",
      enabled: true,
      target: { kind: "rel", value: "org/repo/run.gguf" },
      ...(options.expectedMemoryGiB === undefined
        ? {}
        : { resources: { expectedMemoryGiB: options.expectedMemoryGiB } }),
    },
    ...(options.phase === undefined
      ? {}
      : {
          status: {
            phase: options.phase,
            lastTransitionTime: "2026-01-01T00:00:00.000Z",
          },
        }),
  });
}

function seedRouterFixture(): void {
  const workloadsDir = join(runtimeDir, "workloads");
  saveWorkload(
    runManifest("chat-a", { profiles: "chat", phase: "Running", expectedMemoryGiB: 10 }),
    workloadsDir,
  );
  saveWorkload(
    runManifest("code-b", { profiles: "code", phase: "Stopped", expectedMemoryGiB: 12 }),
    workloadsDir,
  );
  saveNodeRun(
    {
      apiVersion: "llamactl/v1",
      kind: "NodeRun",
      metadata: { name: "local", labels: {} },
      spec: { node: "local", budget: { memoryGiB: 24 }, infra: [] },
    },
    workloadsDir,
  );
}

function seedInflight(fenceIdentity?: FenceIdentity): Fence {
  const store = openResidencyOperationStore({ path: storePath });
  try {
    const fence = store.claimOwnership(
      fenceIdentity ?? { ownerId: "other-writer", incarnation: "x" },
    );
    const begun = store.beginOperation({
      fenceToken: fence.fenceToken,
      operationId: "op-inflight",
      model: "profile-switch:local",
      targetState: "profile:chat",
      desiredRevision: 0,
      reservationGiB: 0,
      nowMs: Date.now(),
    });
    expect(begun.ok).toBe(true);
    return fence;
  } finally {
    store.close();
  }
}

function withStore<T>(fn: (store: StoreHandle) => T): T {
  const store = openResidencyOperationStore({ path: storePath });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function recordingSteps(): ApplyProfileSteps {
  return {
    stop: (workload: string): Promise<{ ok: true }> => {
      stepCalls.push(["stop", workload]);
      return Promise.resolve({ ok: true });
    },
    start: (workload: string): Promise<{ ok: true }> => {
      stepCalls.push(["start", workload]);
      return Promise.resolve({ ok: true });
    },
  };
}

async function applyProfileModule(): Promise<Record<string, unknown>> {
  return await import("../../remote/src/residency/apply-profile.js").catch(() => ({}));
}

async function installStepsFake(): Promise<void> {
  const mod = await applyProfileModule();
  const set = mod["__setResidencyApplyProfileStepsForTests"];
  expect(typeof set).toBe("function");
  (set as (steps: ApplyProfileSteps | null) => void)(recordingSteps());
}

async function resetStepsSeam(): Promise<void> {
  const mod = await applyProfileModule();
  const reset = mod["__setResidencyApplyProfileStepsForTests"];
  if (typeof reset === "function") {
    (reset as (steps: ApplyProfileSteps | null) => void)(null);
  }
}

type ApplyProfileCaller = {
  residencyApplyProfile: (input: Record<string, unknown>) => Promise<ApplyProfileResult>;
};

function residencyApplyProfileProc(): ApplyProfileCaller {
  const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
    .procedures;
  expect(Object.keys(procs)).toContain("residencyApplyProfile");
  return router.createCaller({}) as unknown as ApplyProfileCaller;
}

describe("llamactl.residency.applyProfile MCP tool", () => {
  test("M1: advertised destructive and defaults to a dry run", async () => {
    // kills: a missing registration, a read-only hint, or a wet default.
    seedRouterFixture();
    const { client } = await connected();

    const list = await client.listTools();
    const tool = list.tools.find((t) => t.name === "llamactl.residency.applyProfile");
    expect(tool).toBeDefined();
    expect(tool?.annotations?.destructiveHint).toBe(true);

    const r = await guardedCallTool(client, "llamactl.residency.applyProfile", {
      node: "local",
      to: "code",
      from: "chat",
    });
    expect(r.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(r)) as Record<string, unknown>;
    expect(parsed["dryRun"]).toBe(true);
    expect(parsed["operationId"] ?? null).toBeNull();
    expect(existsSync(join(runtimeDir, "residency-state"))).toBe(false);
  });

  test("M2: wet call without confirm is refused before any step", async () => {
    // kills: dropping the confirm guard.
    seedRouterFixture();
    await installStepsFake();
    const { client } = await connected();

    const r = await guardedCallTool(client, "llamactl.residency.applyProfile", {
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: false,
    });

    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("refusing without confirm: true");
    expect(stepCalls).toEqual([]);
  });

  test("M3: an in-flight operation surfaces as an error carrying the refusal", async () => {
    // kills: swallowing refusal details into a success result.
    seedRouterFixture();
    seedInflight();
    await installStepsFake();
    const { client } = await connected();
    const direct = await residencyApplyProfileProc().residencyApplyProfile({
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    });

    const r = await guardedCallTool(client, "llamactl.residency.applyProfile", {
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    });

    expect(r.isError).toBe(true);
    const parsed = JSON.parse(textOf(r)) as {
      refusal?: { reason?: string };
      inFlightOperationId?: string | null;
    };
    expect(parsed).toEqual(direct);
    expect(parsed.refusal?.reason).toBe("NodeBusy");
    expect(parsed.inFlightOperationId).toBe("op-inflight");
  });

  test("M4: a confirmed switch returns the recorded operation id", async () => {
    // kills: dropping operationId from the result or failing to execute.
    seedRouterFixture();
    await installStepsFake();
    const { client } = await connected();

    const r = await guardedCallTool(client, "llamactl.residency.applyProfile", {
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    });

    expect(r.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(r)) as { operationId?: string | null };
    expect(typeof parsed.operationId).toBe("string");
    const opId = parsed.operationId!;
    const rec = withStore((store) => store.getOperation(opId));
    expect(rec).not.toBeNull();
    expect(rec?.phase).toBe("terminal");
    expect(rec?.outcome).toBe("succeeded");
    expect(stepCalls).toEqual([
      ["stop", "chat-a"],
      ["start", "code-b"],
    ]);
  });
});
