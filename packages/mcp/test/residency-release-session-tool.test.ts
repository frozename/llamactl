// #284 (DF-11): `llamactl.residency.releaseSession` MCP tool — RED tests
// pinning the destructive projection of the residencyReleaseSession
// mutation. At the pinned base the tool is not registered, so every case
// fails by assertion: listTools lacks the name.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  CompatibilityCallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
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

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "../src/safe-fs.js";
import { buildMcpServer } from "../src/server.js";

const TOOL = "llamactl.residency.releaseSession";

let runtimeDir = "";
let auditDir = "";
let nowMs = 1_000;
let reg: SessionRefcounts;
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-mcp-runtime-"));
  auditDir = mkdtempSync(join(tmpdir(), "llamactl-mcp-audit-"));
  // Scope llamactl state + audit writes into the sandbox so no test touches
  // the real `~/.llamactl`.
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

async function toolNames(client: Client): Promise<string[]> {
  const list = await client.listTools();
  return list.tools.map((t) => t.name);
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

describe("llamactl.residency.releaseSession MCP tool", () => {
  test("R1 listing: advertised destructive with process-locality, refusal and lease limits", async () => {
    const { client } = await connected();
    const names = await toolNames(client);
    expect(names).toContain(TOOL);

    const tool = (await client.listTools()).tools.find((t) => t.name === TOOL);
    expect(tool).toBeDefined();
    expect(tool?.annotations?.destructiveHint).toBe(true);
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.description ?? "").toContain("process");
    expect(tool?.description ?? "").toContain("SessionInFlight");
    expect(tool?.description ?? "").toContain("leases");
  });

  test("R2 no confirm: refuses before release and writes no audit row", async () => {
    const { client } = await connected();
    const names = await toolNames(client);
    expect(names).toContain(TOOL);
    reg.acquire("s-1", "gemma4-run-a");
    reg.release("s-1");

    const r = await guardedCallTool(client, TOOL, { sessionId: "s-1" });

    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("refusing without confirm: true");
    expect(reg.activeSessions("gemma4-run-a")).toEqual(["s-1"]);
    expect(auditLines()).toHaveLength(0);
  });

  test("R3 idle release: confirm releases the binding and audits the mutation", async () => {
    const { client } = await connected();
    const names = await toolNames(client);
    expect(names).toContain(TOOL);
    reg.acquire("s-1", "gemma4-run-a");
    reg.release("s-1");

    const r = await guardedCallTool(client, TOOL, { sessionId: "s-1", confirm: true });

    expect(r.isError).toBeFalsy();
    expect(parsedText(r)).toMatchObject({
      ok: true,
      sessionId: "s-1",
      workload: "gemma4-run-a",
      refs: 0,
      forced: false,
      source: "operator",
    });
    expect(reg.activeSessions("gemma4-run-a")).toEqual([]);

    const lines = auditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.["tool"]).toBe(TOOL);
    expect(lines[0]?.["dryRun"]).toBe(false);
    expect(lines[0]?.["input"]).toEqual({ sessionId: "s-1", force: false });
    expect((lines[0]?.["result"] as Record<string, unknown> | undefined)?.["ok"]).toBe(true);
  });

  test("R4 in flight: refuses without force and a forced release drops only the binding", async () => {
    const { client } = await connected();
    const names = await toolNames(client);
    expect(names).toContain(TOOL);
    reg.acquire("s-1", "gemma4-run-a");

    const refused = await guardedCallTool(client, TOOL, { sessionId: "s-1", confirm: true });

    expect(refused.isError).toBe(true);
    const refusal = parsedText(refused);
    expect(refusal["reason"]).toBe("SessionInFlight");
    expect(refusal["refs"]).toBe(1);
    expect(refusal["workload"]).toBe("gemma4-run-a");
    expect(reg.activeSessions("gemma4-run-a")).toEqual(["s-1"]);

    const forced = await guardedCallTool(client, TOOL, {
      sessionId: "s-1",
      force: true,
      confirm: true,
    });

    expect(forced.isError).toBeFalsy();
    const released = parsedText(forced);
    expect(released["ok"]).toBe(true);
    expect(released["forced"]).toBe(true);
    expect(released["refs"]).toBe(1);
    expect(reg.activeSessions("gemma4-run-a")).toEqual([]);
  });

  test("R5 Unavailable: no installed session registry is an error result", async () => {
    const { client } = await connected();
    const names = await toolNames(client);
    expect(names).toContain(TOOL);
    setSessionRefcountRegistry(null);

    const r = await guardedCallTool(client, TOOL, { sessionId: "s-1", confirm: true });

    expect(r.isError).toBe(true);
    const parsed = parsedText(r);
    expect(parsed["reason"]).toBe("Unavailable");
    expect(parsed["detail"]).toBe("no session registry installed; nothing to release");
  });

  test("R6 SessionNotFound: an unknown live id is an error result", async () => {
    const { client } = await connected();
    const names = await toolNames(client);
    expect(names).toContain(TOOL);

    const r = await guardedCallTool(client, TOOL, { sessionId: "ghost", confirm: true });

    expect(r.isError).toBe(true);
    expect(parsedText(r)["reason"]).toBe("SessionNotFound");
  });

  test("R7 bounds: invalid session ids fail validation before release or audit", async () => {
    const { client } = await connected();
    const names = await toolNames(client);
    expect(names).toContain(TOOL);
    reg.acquire("s-1", "gemma4-run-a");

    const badSpace = await guardedCallTool(client, TOOL, {
      sessionId: "bad id",
      confirm: true,
    });
    const tooLong = await guardedCallTool(client, TOOL, {
      sessionId: "x".repeat(129),
      confirm: true,
    });

    expect(badSpace.isError).toBe(true);
    expect(tooLong.isError).toBe(true);
    // MCP -32602: the tool's own sessionId bounds reject these, not a downstream refusal.
    expect(textOf(badSpace)).toContain("Input validation error");
    expect(textOf(tooLong)).toContain("Input validation error");
    expect(reg.activeSessions("gemma4-run-a")).toEqual(["s-1"]);
    expect(auditLines()).toHaveLength(0);
  });
});
