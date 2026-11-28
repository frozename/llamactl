// #520: `llamactl.residency.forceUnload` session preview — RED tests pinning
// the dry-run read-out of session bindings before the destructive unload.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  CompatibilityCallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { createResidencyLeases, setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import {
  createSessionRefcounts,
  type SessionRefcounts,
  setSessionRefcountRegistry,
} from "@llamactl/core/residency/sessions";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, rmSync } from "../src/safe-fs.js";
import { buildMcpServer } from "../src/server.js";

const TOOL = "llamactl.residency.forceUnload";

let runtimeDir = "";
let auditDir = "";
let nowMs = 1_000;
let reg: SessionRefcounts;
let leases: ReturnType<typeof createResidencyLeases>;
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-mcp-runtime-"));
  auditDir = mkdtempSync(join(tmpdir(), "llamactl-mcp-audit-"));
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
  });
  nowMs = 1_000;
  reg = createSessionRefcounts({ idleTimeoutMs: 60_000, now: () => nowMs });
  setSessionRefcountRegistry(reg);
  leases = createResidencyLeases();
  setResidencyLeaseRegistry(leases);
});

afterEach(() => {
  setSessionRefcountRegistry(null);
  setResidencyLeaseRegistry(null);
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

function parsedText(result: unknown): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
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

function bindIdle(sessionId: string, workload: string): void {
  const acquired = reg.acquire(sessionId, workload);
  if (!acquired.ok) throw new Error(`acquire failed: ${acquired.reason}`);
  reg.release(sessionId, acquired.generation);
}

describe("llamactl.residency.forceUnload session release (#520)", () => {
  test("R1 listing: describes the session release contract", async () => {
    const { client } = await connected();

    const tool = (await client.listTools()).tools.find((t) => t.name === TOOL);

    expect(tool).toBeDefined();
    const description = tool?.description ?? "";
    expect(description).toContain("drops every session bound to the workload");
    expect(description).toContain("releasedSessions");
    expect(description).toContain("wouldReleaseSessions");
    expect(description).toContain("sessionsDetail");
    expect(description).toContain("llamactl.residency.releaseSession");
    expect(description).toContain("releases nothing");
  });

  test("R2 dry run: lists bound sessions without releasing them", async () => {
    const { client } = await connected();
    bindIdle("s1", "gemma4-run-a");
    bindIdle("s2", "other-run");

    const result = await guardedCallTool(client, TOOL, {
      workload: "gemma4-run-a",
      reason: "drill",
      dryRun: true,
    });

    expect(result.isError).toBeFalsy();
    const parsed = parsedText(result);
    expect(parsed["wouldReleaseSessions"]).toEqual(["s1"]);
    expect(parsed["wouldForceUnload"]).toEqual({ workload: "gemma4-run-a", reason: "drill" });
    expect(reg.activeSessions("gemma4-run-a")).toEqual(["s1"]);
    expect(reg.activeSessions("other-run")).toEqual(["s2"]);
    const leaseSnapshot = leases.snapshot("gemma4-run-a");
    expect(leaseSnapshot.phase).toBe("open");
    expect(leaseSnapshot.active).toEqual([]);
  });

  test("R3 dry run: no session registry previews an empty session list", async () => {
    const { client } = await connected();
    setSessionRefcountRegistry(null);

    const result = await guardedCallTool(client, TOOL, {
      workload: "gemma4-run-a",
      reason: "drill",
      dryRun: true,
    });

    expect(result.isError).toBeFalsy();
    expect(parsedText(result)["wouldReleaseSessions"]).toEqual([]);
  });

  test("R4 dry run: a session-listing failure is reported without failing the preview", async () => {
    const { client } = await connected();
    setSessionRefcountRegistry({
      ...reg,
      activeSessions: () => {
        throw new Error("boom");
      },
    });

    const result = await guardedCallTool(client, TOOL, {
      workload: "gemma4-run-a",
      reason: "drill",
      dryRun: true,
    });

    expect(result.isError).toBeFalsy();
    const parsed = parsedText(result);
    expect(parsed["wouldReleaseSessions"]).toBeNull();
    expect(parsed["sessionsDetail"]).toContain("could not list sessions");
    expect(parsed["sessionsDetail"]).toContain("boom");
  });

  test("R5 listing: residency.status describes the sessions section and missing registry", async () => {
    const { client } = await connected();

    const tool = (await client.listTools()).tools.find(
      (t) => t.name === "llamactl.residency.status",
    );

    expect(tool).toBeDefined();
    const description = tool?.description ?? "";
    expect(description).toContain("sessions section");
    expect(description).toContain("idle timeout plus per-session workload");
    expect(description).toContain("no session registry is installed");
  });

  test("G1 guard: no confirm refuses before touching session bindings", async () => {
    const { client } = await connected();
    bindIdle("s1", "gemma4-run-a");

    const result = await guardedCallTool(client, TOOL, {
      workload: "gemma4-run-a",
      reason: "drill",
      confirm: false,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("refusing without confirm");
    expect(reg.activeSessions("gemma4-run-a")).toEqual(["s1"]);
  });
});
