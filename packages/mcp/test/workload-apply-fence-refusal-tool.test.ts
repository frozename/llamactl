import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { router } from "@llamactl/remote";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "../src/safe-fs.js";
import { buildMcpServer } from "../src/server.js";

let runtimeDir = "";
let auditDir = "";
const originalEnv = { ...process.env };
let restoreCaller: (() => void) | null = null;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-mcp-apply-tool-"));
  auditDir = join(runtimeDir, "audit");
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: runtimeDir,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMACTL_CONFIG: join(runtimeDir, "config"),
    LLAMACTL_MCP_AUDIT_DIR: auditDir,
    LLAMACTL_WORKLOADS_DIR: join(runtimeDir, "workloads"),
    LLAMACTL_MCP_PIPELINES_DIR: join(runtimeDir, "mcp-pipelines"),
  });
});

afterEach(() => {
  restoreCaller?.();
  restoreCaller = null;
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  rmSync(runtimeDir, { recursive: true, force: true });
});

const transition = "2026-01-02T03:04:05.000Z";

function fencedApplyPayload(): Record<string, unknown> {
  return {
    action: "unchanged",
    path: "/tmp/w1.yaml",
    status: {
      phase: "Running",
      serverPid: 123,
      endpoint: "http://127.0.0.1:8081",
      lastTransitionTime: transition,
      conditions: [
        {
          type: "Applied",
          status: "False",
          reason: "StopRefused",
          message: "serverStop refused: SessionsActive: s1",
          lastTransitionTime: transition,
        },
      ],
    },
    name: "w1",
    node: "n1",
  };
}

// The registered tool builds its caller via router.createCaller({}) at call
// time, so stubbing createCaller swaps in a canned workloadApply result
// without a real node or manifest store.
function stubWorkloadApply(payload: unknown): void {
  const spy = spyOn(router, "createCaller").mockImplementation(((): {
    workloadApply: () => Promise<unknown>;
  } => ({
    workloadApply: (): Promise<unknown> => Promise.resolve(payload),
  })) as unknown as typeof router.createCaller);
  restoreCaller = (): void => {
    spy.mockRestore();
  };
}

async function callWetApply(): Promise<unknown> {
  const server: McpServer = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    return await client.callTool({
      name: "llamactl.workload.apply",
      arguments: { yaml: "kind: ModelRun\n", dryRun: false },
    });
  } finally {
    await server.close();
    await client.close();
  }
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text: string }[] }).content ?? [];
  return content[0]?.text ?? "";
}

function auditLines(): Record<string, unknown>[] {
  if (!existsSync(auditDir)) return [];
  const out: Record<string, unknown>[] = [];
  for (const f of readdirSync(auditDir).filter((name) => name.startsWith("llamactl-"))) {
    for (const line of readFileSync(join(auditDir, f), "utf8").trim().split("\n")) {
      if (line) out.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return out;
}

describe("#520 llamactl.workload.apply registered tool fence refusal", () => {
  // Kills: registerWorkloadApply returning toTextContent(result) (and auditing
  // the raw result) instead of routing through workloadApplyToolResult.
  test("T1 a fenced wet apply is an isError apply_refused with an ok:false audit row", async () => {
    stubWorkloadApply(fencedApplyPayload());

    const result = await callWetApply();

    expect((result as { isError?: boolean }).isError).toBe(true);
    const payload = JSON.parse(textOf(result)) as { ok?: unknown; code?: unknown };
    expect(payload.code).toBe("apply_refused");
    expect(payload.ok).toBe(false);

    const lines = auditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: "llamactl.workload.apply", dryRun: false });
    const audit = lines[0]?.["result"] as { ok?: unknown; code?: unknown } | undefined;
    expect(audit?.ok).toBe(false);
    expect(audit?.code).toBe("apply_refused");
  });

  test("G1 guard: a clean wet apply stays a non-error", async () => {
    stubWorkloadApply({
      ...fencedApplyPayload(),
      action: "started",
      status: {
        phase: "Running",
        conditions: [{ type: "Applied", status: "True", reason: "started" }],
      },
    });

    const result = await callWetApply();

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(textOf(result)).not.toContain("apply_refused");
  });
});
