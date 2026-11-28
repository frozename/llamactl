// #519: `llamactl.residency.evictIdle` MCP tool — RED tests pinning the
// read-only preview of the residencyEvictIdle dry run. At the pinned base
// the tool is not registered, so every case fails by assertion on the
// listTools probe before callTool is reached.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  CompatibilityCallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import {
  createResidencyLeases,
  type ResidencyLeases,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import {
  createSessionRefcounts,
  setSessionRefcountRegistry,
} from "@llamactl/core/residency/sessions";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../remote/src/residency/apply-profile.js";
import {
  defaultResidencyStorePath,
  openResidencyOperationStore,
  type ResidencyStateRecord,
} from "../../remote/src/residency/store.js";
import { saveNodeRun } from "../../remote/src/workload/noderun-store.js";
import { ModelRunSchema } from "../../remote/src/workload/schema.js";
import { loadWorkloadByName, saveWorkload } from "../../remote/src/workload/store.js";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "../src/safe-fs.js";
import { buildMcpServer } from "../src/server.js";

const TOOL = "llamactl.residency.evictIdle";
const GROUP = "z13-large-gpu";
const GROUP_LABEL = "llamactl.io/residency-group";
const NODE = "local";
const NOW = 1_000_000_000;
const IDLE_EVICTED_AT = "llamactl.io/idle-evicted-at";

type EvictIdleKind = "modelrun" | "modelhost";
type EvictIdleRow = {
  workload: string;
  action: "would-evict" | "evicted" | "skipped";
  kind?: EvictIdleKind;
  idleSinceMs?: number;
  dueAtMs?: number;
  reason?: string;
  detail?: string;
};
type EvictIdleResult =
  | { ok: false; reason: string }
  | { ok: true; dryRun: boolean; windowSeconds: number; rows: EvictIdleRow[] };

const originalEnv = { ...process.env };
let root = "";
let workloadsDir = "";
let auditDir = "";
let leases: ResidencyLeases;

function seedPathTo(target: ResidencyState): ResidencyState[] {
  switch (target) {
    case "downloaded":
      return ["downloaded"];
    case "loading":
      return ["downloaded", "loading"];
    case "ready":
      return ["downloaded", "loading", "warming", "ready"];
    case "unavailable":
    case "warming":
    case "draining":
    case "unloading":
    case "failed":
      throw new Error(`no seed path to residency state ${target}`);
  }
}

function seed(model: string): void {
  const store = openResidencyOperationStore({ path: defaultResidencyStorePath() });
  try {
    const fence = store.claimOwnership({
      ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
      incarnation: "seed",
    });
    for (const to of seedPathTo("ready")) {
      const result = store.transitionResidencyState({
        fenceToken: fence.fenceToken,
        model,
        ...(to === "loading" ? { group: GROUP } : {}),
        to,
        expectedVersion: store.getResidencyState(model)?.version ?? 0,
        nowMs: NOW,
      });
      expect(result.ok).toBe(true);
    }
  } finally {
    store.close();
  }
}

function readState(model: string): ResidencyStateRecord | null {
  const store = openResidencyOperationStore({ path: defaultResidencyStorePath() });
  try {
    return store.getResidencyState(model);
  } finally {
    store.close();
  }
}

function writeNodeRun(name: string, residency?: { idleEvictSeconds: number }): void {
  saveNodeRun(
    {
      apiVersion: "llamactl/v1",
      kind: "NodeRun",
      metadata: { name, labels: {} },
      spec: {
        node: name,
        ...(residency === undefined ? {} : { residency }),
        infra: [],
      },
    },
    workloadsDir,
  );
}

function writeRun(name: string): void {
  saveWorkload(
    ModelRunSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: {
        name,
        labels: { [GROUP_LABEL]: GROUP },
      },
      spec: {
        node: NODE,
        enabled: true,
        restartPolicy: "Always",
        target: { kind: "rel", value: `${name}/missing.gguf` },
      },
    }),
    workloadsDir,
  );
}

beforeEach(() => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  root = mkdtempSync(join(tmpdir(), "llamactl-mcp-evict-idle-"));
  workloadsDir = join(root, "workloads");
  auditDir = join(root, "audit");
  mkdirSync(workloadsDir, { recursive: true });
  mkdirSync(auditDir, { recursive: true });
  mkdirSync(join(root, "models"), { recursive: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: join(root, "dev"),
    LOCAL_AI_RUNTIME_DIR: join(root, "runtime"),
    LOCAL_AI_PRESET_OVERRIDES_FILE: join(root, "preset-overrides.tsv"),
    LLAMACTL_MCP_AUDIT_DIR: auditDir,
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
    LLAMACTL_EMBERSYNTH_CONFIG: join(root, "embersynth.yaml"),
    LLAMACTL_CONFIG: join(root, "config"),
    LLAMACTL_MCP_PIPELINES_DIR: join(root, "mcp-pipelines"),
    LLAMACTL_RESIDENCY_STORE: join(root, "residency", "operations.sqlite"),
    LLAMA_CPP_MODELS: join(root, "models"),
    LLAMACTL_NODE_NAME: NODE,
  });
  leases = createResidencyLeases({ now: () => NOW });
  setResidencyLeaseRegistry(leases);
  writeNodeRun(NODE, { idleEvictSeconds: 60 });
  writeRun("w1");
  seed("w1");
});

afterEach(() => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  if (root !== "") {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

async function connected(): Promise<{ client: Client; server: McpServer }> {
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

async function toolNames(client: Client): Promise<string[]> {
  const list = await client.listTools();
  return list.tools.map((t) => t.name);
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text: string }[] }).content ?? [];
  return content[0]?.text ?? "";
}

function parsedPayload(result: unknown): EvictIdleResult {
  return JSON.parse(textOf(result)) as EvictIdleResult;
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

function auditLines(): Record<string, unknown>[] {
  const files = readdirSync(auditDir).filter((f) => f.startsWith("llamactl-"));
  const out: Record<string, unknown>[] = [];
  for (const f of files) {
    const body = readFileSync(join(auditDir, f), "utf8");
    for (const line of body.trim().split("\n")) {
      if (line) out.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return out;
}

function rowFor(result: EvictIdleResult, workload: string): EvictIdleRow | undefined {
  return result.ok ? result.rows.find((row) => row.workload === workload) : undefined;
}

describe("llamactl.residency.evictIdle MCP tool", () => {
  test("E1 listing: advertised read-only with only the node input and the dry-run contract", async () => {
    const { client } = await connected();
    expect(await toolNames(client)).toContain(TOOL);

    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === TOOL);
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.destructiveHint).not.toBe(true);
    const schema = (tool?.inputSchema ?? {}) as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {})).toEqual(["node"]);
    const description = tool?.description ?? "";
    for (const pin of [
      "residencyEvictIdle",
      "dry run",
      "never sends targets",
      "never stamps the idle hold or stops a workload",
      "llamactl residency evict-idle --node <name> --yes",
      "MCP server's own process",
      "LeasesUnavailable",
    ]) {
      expect(description).toContain(pin);
    }
  });

  test("E2 dry run: reports would-evict and changes neither lifecycle, lease nor hold", async () => {
    const { client } = await connected();
    expect(await toolNames(client)).toContain(TOOL);

    const result = await guardedCallTool(client, TOOL, { node: NODE });

    expect(result.isError).not.toBe(true);
    const payload = parsedPayload(result);
    expect(payload).toMatchObject({ ok: true, dryRun: true, windowSeconds: 60 });
    expect(rowFor(payload, "w1")).toMatchObject({
      workload: "w1",
      action: "would-evict",
      kind: "modelrun",
    });
    expect(readState("w1")?.state).toBe("ready");
    expect(leases.snapshot("w1").phase).toBe("open");
    expect(
      loadWorkloadByName("w1", workloadsDir).metadata.annotations[IDLE_EVICTED_AT],
    ).toBeUndefined();
  });

  test("E3 extra targets are ignored: the preview never enters the wet path", async () => {
    const { client } = await connected();
    expect(await toolNames(client)).toContain(TOOL);

    const result = await guardedCallTool(client, TOOL, {
      node: NODE,
      targets: [{ workload: "w1", kind: "modelrun" }],
    });

    expect(readState("w1")?.state).toBe("ready");
    expect(leases.snapshot("w1").phase).toBe("open");
    if (!result.isError) {
      const payload = parsedPayload(result);
      expect(payload.ok ? payload.dryRun : false).toBe(true);
      expect(payload.ok ? payload.rows.some((row) => row.action === "evicted") : false).toBe(false);
    }
  });

  test("E4 disabled: a NodeRun without residency policy reports Disabled without an error", async () => {
    writeNodeRun(NODE);
    const { client } = await connected();
    expect(await toolNames(client)).toContain(TOOL);

    const result = await guardedCallTool(client, TOOL, { node: NODE });

    expect(result.isError).not.toBe(true);
    expect(parsedPayload(result)).toEqual({ ok: false, reason: "Disabled" });
  });

  test("E5 not the serving node: reports NotServingNode", async () => {
    process.env["LLAMACTL_NODE_NAME"] = "other";
    const { client } = await connected();
    expect(await toolNames(client)).toContain(TOOL);

    const result = await guardedCallTool(client, TOOL, { node: NODE });

    expect(parsedPayload(result)).toMatchObject({ ok: false, reason: "NotServingNode" });
  });

  test("E6 no lease registry: reports LeasesUnavailable", async () => {
    const { client } = await connected();
    expect(await toolNames(client)).toContain(TOOL);
    setResidencyLeaseRegistry(null);

    const result = await guardedCallTool(client, TOOL, { node: NODE });

    expect(parsedPayload(result)).toMatchObject({ ok: false, reason: "LeasesUnavailable" });
  });

  test("E7 session hold: a session-bound workload is skipped SessionsActive", async () => {
    const sessions = createSessionRefcounts({ idleTimeoutMs: 60_000, now: () => NOW });
    setSessionRefcountRegistry(sessions);
    const acquired = sessions.acquire("s1", "w1");
    expect(acquired.ok).toBe(true);
    const { client } = await connected();
    expect(await toolNames(client)).toContain(TOOL);

    const result = await guardedCallTool(client, TOOL, { node: NODE });

    expect(result.isError).not.toBe(true);
    const row = rowFor(parsedPayload(result), "w1");
    expect(row).toMatchObject({ action: "skipped", reason: "SessionsActive" });
    expect(row?.detail ?? "").toContain("s1");
    expect(readState("w1")?.state).toBe("ready");
  });

  test("E8 no audit: the read-only preview writes no audit line", async () => {
    const { client } = await connected();
    expect(await toolNames(client)).toContain(TOOL);

    const result = await guardedCallTool(client, TOOL, { node: NODE });

    expect(result.isError).not.toBe(true);
    expect(auditLines().some((line) => line["tool"] === TOOL)).toBe(false);
  });
});
