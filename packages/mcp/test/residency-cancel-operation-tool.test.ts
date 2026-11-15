// #284 (DF-11): `llamactl.residency.cancelOperation` MCP tool — RED tests
// pinning the destructive projection of the residencyCancelOperation
// mutation. At the pinned base the tool is not registered, so every case
// fails by assertion: listTools lacks the name and callTool answers an
// unknown-tool error whose text never contains the pinned strings.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  CompatibilityCallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { existsSync, mkdtempSync, rmSync } from "../src/safe-fs.js";
import { buildMcpServer } from "../src/server.js";

let runtimeDir = "";
let auditDir = "";
let storePath = "";
const originalEnv = { ...process.env };

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
  setResidencyLeaseRegistry(null);
});

afterEach(() => {
  setResidencyLeaseRegistry(null);
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

describe("llamactl.residency.cancelOperation MCP tool", () => {
  test("M1: advertised destructive with the process-local limitation in the description", async () => {
    // kills: a non-destructive annotation; omitting the limitation from the
    // description.
    const { client } = await connected();

    const list = await client.listTools();
    const tool = list.tools.find((t) => t.name === "llamactl.residency.cancelOperation");
    expect(tool).toBeDefined();
    expect(tool?.annotations?.destructiveHint).toBe(true);
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.description ?? "").toContain("process");
    expect(tool?.description ?? "").toContain("cancel-requested");
  });

  test("M2: a call without confirm is refused before any store write", async () => {
    // kills: a missing confirm gate.
    const { client } = await connected();

    const r = await guardedCallTool(client, "llamactl.residency.cancelOperation", {
      operationId: "op-x",
    });

    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("refusing without confirm: true");
    expect(existsSync(join(runtimeDir, "residency-state"))).toBe(false);
    expect(existsSync(storePath)).toBe(false);
  });

  test("M3: an unknown operation id surfaces not-found as an error result", async () => {
    // kills: dropping isError on !ok.
    const { client } = await connected();

    const r = await guardedCallTool(client, "llamactl.residency.cancelOperation", {
      operationId: "op-missing",
      confirm: true,
    });

    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("not-found");
    const parsed = JSON.parse(textOf(r)) as { outcome?: string; operationId?: string | null };
    expect(parsed.outcome).toBe("not-found");
    expect(parsed.operationId).toBe("op-missing");
  });
});
