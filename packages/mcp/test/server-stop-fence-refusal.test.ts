import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createResidencyLeases,
  setResidencyLeaseRegistry,
} from "../../core/src/residency/leases.js";
import {
  createSessionRefcounts,
  type SessionRefcounts,
  setSessionRefcountRegistry,
} from "../../core/src/residency/sessions.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "../src/safe-fs.js";
import { buildMcpServer } from "../src/server.js";

let runtimeDir = "";
let auditDir = "";
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
    LLAMACTL_CONFIG: join(runtimeDir, "config"),
    LLAMACTL_MCP_PIPELINES_DIR: join(runtimeDir, "mcp-pipelines"),
    LLAMACTL_RESIDENCY_STORE: join(runtimeDir, "residency", "operations.sqlite"),
  });
});

afterEach(() => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  rmSync(runtimeDir, { recursive: true, force: true });
  rmSync(auditDir, { recursive: true, force: true });
});

function connected(): Promise<{ client: Client; server: McpServer }> {
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  void client.connect(clientTransport);
  return Promise.resolve({ client, server });
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text: string }[] }).content ?? [];
  return content[0]?.text ?? "";
}

function isErrorOf(result: unknown): boolean | undefined {
  return (result as { isError?: boolean }).isError;
}

function auditLines(server: string): Record<string, unknown>[] {
  if (!existsSync(auditDir)) return [];
  const files = readdirSync(auditDir).filter((f) => f.startsWith(`${server}-`));
  const out: Record<string, unknown>[] = [];
  for (const f of files) {
    const body = readFileSync(join(auditDir, f), "utf8");
    for (const line of body.trim().split("\n")) {
      if (line) out.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return out;
}

async function withConnected<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const { client, server } = await connected();
  try {
    return await run(client);
  } finally {
    await server.close();
    await client.close();
  }
}

async function callWetStop(client: Client): Promise<unknown> {
  return await client.callTool({
    name: "llamactl.server.stop",
    arguments: { workload: "w1", dryRun: false },
  });
}

function installLeaseRegistry(): ReturnType<typeof createResidencyLeases> {
  const leases = createResidencyLeases();
  setResidencyLeaseRegistry(leases);
  return leases;
}

function installIdleSessionBinding(): ReturnType<typeof createSessionRefcounts> {
  installLeaseRegistry();
  const sessions = createSessionRefcounts({ idleTimeoutMs: 60_000 });
  setSessionRefcountRegistry(sessions);
  const acquired = sessions.acquire("s1", "w1");
  expect(acquired.ok).toBe(true);
  if (acquired.ok) sessions.release("s1", acquired.generation);
  return sessions;
}

function throwingSessionRegistry(): SessionRefcounts {
  return {
    acquire: (): never => {
      throw new Error("unused acquire");
    },
    release: () => undefined,
    touch: () => undefined,
    forceRelease: () => [],
    activeSessions: () => [],
    checkUnload: (): never => {
      throw new Error("session registry unavailable");
    },
  };
}

describe("llamactl.server.stop stop-fence refusal", () => {
  // Kills: returning the raw procedure payload without isError, or never wiring
  // the shared refusal helper into the MCP tool.
  test("R1 SessionsActive refuses as isError with stop_refused and keeps the session", async () => {
    const sessions = installIdleSessionBinding();

    await withConnected(async (client) => {
      const result = await callWetStop(client);
      expect(isErrorOf(result)).toBe(true);

      const text = textOf(result);
      expect(text).toContain(
        "serverStop refused by the node stop fence (SessionsActive: s1); nothing was stopped",
      );
      const payload = JSON.parse(text) as {
        code?: unknown;
        refused?: { reason?: unknown };
      };
      expect(payload.code).toBe("stop_refused");
      expect(payload.refused?.reason).toBe("SessionsActive");
    });

    expect(sessions.activeSessions("w1")).toEqual(["s1"]);
  });

  // Kills: always appending `: ${ids}`, which turns an unknown-session refusal
  // into a message with a trailing empty id list.
  test("R2 SessionsUnknown refuses without an id-list suffix", async () => {
    installLeaseRegistry();
    setSessionRefcountRegistry(throwingSessionRegistry());

    await withConnected(async (client) => {
      const result = await callWetStop(client);
      expect(isErrorOf(result)).toBe(true);

      const text = textOf(result);
      expect(text).toContain(
        "serverStop refused by the node stop fence (SessionsUnknown); nothing was stopped",
      );
      expect(text).not.toContain("SessionsUnknown: ");
    });
  });

  // Kills: narrowing the MCP refusal mapping to session reasons and dropping
  // the lease-refusal branch.
  test("R3 LeasesActive refuses as isError with the held lease id", async () => {
    const leases = installLeaseRegistry();
    setSessionRefcountRegistry(null);
    const acquired = leases.acquire("w1");
    const leaseId = acquired.ok ? acquired.lease.id : "";
    expect(leaseId).toBe("w1#1");

    await withConnected(async (client) => {
      const result = await callWetStop(client);
      expect(isErrorOf(result)).toBe(true);

      const text = textOf(result);
      expect(text).toContain(
        `serverStop refused by the node stop fence (LeasesActive: ${leaseId}); nothing was stopped`,
      );
      const payload = JSON.parse(text) as { code?: unknown; refused?: { reason?: unknown } };
      expect(payload.code).toBe("stop_refused");
      expect(payload.refused?.reason).toBe("LeasesActive");
    });
  });

  // Kills: auditing the raw stop result unchanged instead of the refusal
  // envelope the operator saw.
  test("R4 the wet audit row records ok:false and stop_refused", async () => {
    installIdleSessionBinding();

    await withConnected(async (client) => {
      await callWetStop(client);
    });

    const lines = auditLines("llamactl");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: "llamactl.server.stop", dryRun: false });
    const result = lines[0]?.["result"] as { ok?: unknown; code?: unknown } | undefined;
    expect(result?.ok).toBe(false);
    expect(result?.code).toBe("stop_refused");
  });

  test("G1 guard: an unfenced wet stop stays a normal success", async () => {
    setResidencyLeaseRegistry(null);
    setSessionRefcountRegistry(null);

    await withConnected(async (client) => {
      const result = await callWetStop(client);
      expect(isErrorOf(result)).toBeFalsy();
      expect(textOf(result)).not.toContain("stop_refused");
    });
  });

  test("G2 guard: dryRun stays a non-error preview with wouldStop", async () => {
    await withConnected(async (client) => {
      const result = await client.callTool({
        name: "llamactl.server.stop",
        arguments: { workload: "w1", dryRun: true },
      });
      expect(isErrorOf(result)).toBeFalsy();

      const payload = JSON.parse(textOf(result)) as {
        dryRun?: unknown;
        wouldStop?: unknown;
      };
      expect(payload.dryRun).toBe(true);
      expect(payload.wouldStop).toBeDefined();
    });
  });
});
