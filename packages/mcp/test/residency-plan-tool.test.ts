// #284 (DF-11): `llamactl.residency.plan` MCP tool — RED tests pinning the
// read-only projection of the residencyPlan query onto the MCP surface. At
// the pinned base the tool is not registered, so every case fails by
// assertion: callTool rejects as an unknown tool and listTools lacks the name.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  CompatibilityCallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { getResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { router } from "../../remote/src/router.js";
import { saveNodeRun } from "../../remote/src/workload/noderun-store.js";
import { type ModelRun, ModelRunSchema } from "../../remote/src/workload/schema.js";
import { saveWorkload } from "../../remote/src/workload/store.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "../src/safe-fs.js";
import { buildMcpServer } from "../src/server.js";

let runtimeDir = "";
let auditDir = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-mcp-runtime-"));
  auditDir = mkdtempSync(join(tmpdir(), "llamactl-mcp-audit-"));
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
    LLAMACTL_RESIDENCY_STORE: join(runtimeDir, "residency-state", "operations.sqlite"),
    LLAMACTL_NODE_NAME: "local",
  });
  setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});

afterEach(() => {
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

function stripClock(p: unknown): Record<string, unknown> {
  const { deadlineMs, ...rest } = p as Record<string, unknown>;
  return rest;
}

function snapshotTree(dir: string, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [key, value] of snapshotTree(path, rel)) out.set(key, value);
    } else if (entry.isFile()) {
      out.set(rel, readFileSync(path).toString("base64"));
    }
  }
  return out;
}

type RunPhase = "Pending" | "Running" | "Failed" | "Stopped";

interface RunManifestOptions {
  node?: string;
  enabled?: boolean;
  profiles?: string;
  phase?: RunPhase;
  expectedMemoryGiB?: number;
}

function runManifest(name: string, options: RunManifestOptions = {}): ModelRun {
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
      node: options.node ?? "local",
      enabled: options.enabled ?? true,
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
    runManifest("chat-a", {
      node: "local",
      profiles: "chat",
      phase: "Running",
      expectedMemoryGiB: 10,
    }),
    workloadsDir,
  );
  saveWorkload(
    runManifest("code-b", {
      node: "local",
      profiles: "code",
      phase: "Stopped",
      expectedMemoryGiB: 12,
    }),
    workloadsDir,
  );
  saveWorkload(
    runManifest("embed", { node: "local", phase: "Running", expectedMemoryGiB: 1 }),
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

describe("llamactl.residency.plan MCP tool", () => {
  test("returns the residencyPlan payload for node/to", async () => {
    // Kills: an unregistered tool name or a non-plan payload.
    seedRouterFixture();
    const { client } = await connected();
    const r = await guardedCallTool(client, "llamactl.residency.plan", {
      node: "local",
      to: "code",
    });
    expect(r.isError).not.toBe(true);

    const parsed = JSON.parse(textOf(r)) as Record<string, unknown>;
    const expected = await router.createCaller({}).residencyPlan({ node: "local", to: "code" });
    expect(stripClock(parsed)).toEqual(stripClock(expected));
    expect(parsed["ok"]).toBe(true);
    expect(parsed["victims"]).toEqual(["chat-a"]);
    expect(parsed["replacements"]).toEqual(["code-b"]);
    expect(typeof parsed["deadlineMs"]).toBe("number");
  });

  test("forwards the from profile to the residencyPlan query", async () => {
    // Kills: dropping from forwarding to the residencyPlan query.
    seedRouterFixture();
    const { client } = await connected();
    const r = await guardedCallTool(client, "llamactl.residency.plan", {
      node: "local",
      to: "code",
      from: "chat",
    });
    expect(r.isError).not.toBe(true);

    const parsed = JSON.parse(textOf(r)) as { from?: string | null };
    expect(parsed.from).toBe("chat");
  });

  test("is advertised read-only with a node/to/from input schema", async () => {
    // Kills: a missing registration, a mutation hint, or a wrong input schema.
    const { client } = await connected();
    const list = await client.listTools();
    const names = list.tools.map((tool) => tool.name);
    expect(names).toContain("llamactl.residency.plan");

    const tool = list.tools.find((candidate) => candidate.name === "llamactl.residency.plan");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    const schema = (tool?.inputSchema ?? {}) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty("node");
    expect(schema.properties).toHaveProperty("to");
    expect(schema.properties).toHaveProperty("from");
    expect([...(schema.required ?? [])].sort()).toEqual(["node", "to"]);
  });

  test("stays a dry run: workloads tree, store and lease registry untouched", async () => {
    // Kills: the tool writing manifests, creating the store, or installing the registry.
    seedRouterFixture();
    const workloadsDir = join(runtimeDir, "workloads");
    const before = snapshotTree(workloadsDir);
    expect(getResidencyLeaseRegistry()).toBeNull();
    const { client } = await connected();

    const r = await guardedCallTool(client, "llamactl.residency.plan", {
      node: "local",
      to: "code",
    });
    expect(r.isError).not.toBe(true);

    const after = snapshotTree(workloadsDir);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
    expect(existsSync(join(runtimeDir, "residency-state"))).toBe(false);
    expect(getResidencyLeaseRegistry()).toBeNull();
  });
});
