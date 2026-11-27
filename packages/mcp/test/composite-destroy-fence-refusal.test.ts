import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveConfig } from "../../core/src/config/kubeconfig.js";
import { freshConfig } from "../../core/src/config/schema.js";
import {
  createResidencyLeases,
  setResidencyLeaseRegistry,
} from "../../core/src/residency/leases.js";
import {
  createSessionRefcounts,
  type SessionRefcounts,
  setSessionRefcountRegistry,
} from "../../core/src/residency/sessions.js";
import { CompositeSchema } from "../../remote/src/composite/schema.js";
import { loadComposite, saveComposite } from "../../remote/src/composite/store.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "../src/safe-fs.js";
import { buildMcpServer } from "../src/server.js";
import { SERVER_SLUG } from "../src/tools/shared.js";

let runtimeDir = "";
let auditDir = "";
const originalEnv = { ...process.env };

function workloadComposite(): ReturnType<typeof CompositeSchema.parse> {
  return CompositeSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "Composite",
    metadata: { name: "stack" },
    spec: {
      services: [],
      workloads: [{ node: "local", target: { kind: "rel", value: "m.gguf" } }],
      ragNodes: [],
      gateways: [],
      pipelines: [],
      dependencies: [],
      onFailure: "rollback",
    },
  });
}

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
    LLAMACTL_COMPOSITES_DIR: join(runtimeDir, "composites"),
    LLAMACTL_SIRIUS_PROVIDERS: join(runtimeDir, "sirius-providers.yaml"),
    LLAMACTL_EMBERSYNTH_CONFIG: join(runtimeDir, "embersynth.yaml"),
  });
  delete process.env["LLAMACTL_RUNTIME_BACKEND"];
  saveConfig(freshConfig(), join(runtimeDir, "config"));
  saveComposite(workloadComposite());
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

type DestroyPayload = {
  ok?: unknown;
  code?: unknown;
  error?: unknown;
  manifestPreserved?: unknown;
  errors?: { message?: unknown }[];
  dryRun?: unknown;
  wouldRemove?: unknown;
};

function payloadOf(result: unknown): DestroyPayload {
  return JSON.parse(textOf(result)) as DestroyPayload;
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

async function callWetDestroy(client: Client): Promise<unknown> {
  return await client.callTool({
    name: "llamactl.composite.destroy",
    arguments: { name: "stack", dryRun: false },
  });
}

function installLeaseRegistry(): ReturnType<typeof createResidencyLeases> {
  const leases = createResidencyLeases();
  setResidencyLeaseRegistry(leases);
  return leases;
}

function installIdleSessionBinding(): {
  leases: ReturnType<typeof createResidencyLeases>;
  sessions: ReturnType<typeof createSessionRefcounts>;
} {
  const leases = installLeaseRegistry();
  const sessions = createSessionRefcounts({ idleTimeoutMs: 60_000 });
  setSessionRefcountRegistry(sessions);
  const acquired = sessions.acquire("s1", "local");
  expect(acquired.ok).toBe(true);
  if (acquired.ok) sessions.release("s1", acquired.generation);
  return { leases, sessions };
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

describe("llamactl.composite.destroy stop-fence refusal", () => {
  // Kills: returning toTextContent(result) unchanged, and any fix that releases sessions.
  test("R1 SessionsActive refuses as isError with destroy_refused and preserves the composite", async () => {
    const { leases, sessions } = installIdleSessionBinding();

    await withConnected(async (client) => {
      const result = await callWetDestroy(client);
      expect(isErrorOf(result)).toBe(true);

      const payload = payloadOf(result);
      expect(payload.ok).toBe(false);
      expect(payload.code).toBe("destroy_refused");
      expect(payload.error).toBe(
        "composite/stack not destroyed: a workload stop was refused; manifest preserved",
      );
      expect(payload.manifestPreserved).toBe(true);
      expect(payload.errors?.[0]?.message).toBe(
        "serverStop on local refused (SessionsActive: s1); composite manifest preserved",
      );
    });

    expect(loadComposite("stack")).not.toBeNull();
    expect(sessions.activeSessions("local")).toEqual(["s1"]);
    // Guard: the drain must be cancelled rather than committed or left open.
    expect(leases.snapshot("local").phase).toBe("open");
  });

  // Kills: mapping only when the refused active list is non-empty.
  test("R2 SessionsUnknown refuses without requiring active session ids", async () => {
    installLeaseRegistry();
    setSessionRefcountRegistry(throwingSessionRegistry());

    await withConnected(async (client) => {
      const result = await callWetDestroy(client);
      expect(isErrorOf(result)).toBe(true);

      const payload = payloadOf(result);
      expect(payload.ok).toBe(false);
      expect(payload.code).toBe("destroy_refused");
      expect(payload.error).toBe(
        "composite/stack not destroyed: a workload stop was refused; manifest preserved",
      );
      expect(payload.manifestPreserved).toBe(true);
      expect(payload.errors?.[0]?.message).toBe(
        "serverStop on local refused (SessionsUnknown); composite manifest preserved",
      );
    });

    expect(loadComposite("stack")).not.toBeNull();
  });

  // Kills: matching only session reasons.
  test("R3 LeasesActive refuses as isError with destroy_refused", async () => {
    const leases = installLeaseRegistry();
    setSessionRefcountRegistry(null);
    const acquired = leases.acquire("local");
    expect(acquired.ok).toBe(true);

    await withConnected(async (client) => {
      const result = await callWetDestroy(client);
      expect(isErrorOf(result)).toBe(true);

      const payload = payloadOf(result);
      expect(payload.ok).toBe(false);
      expect(payload.code).toBe("destroy_refused");
      expect(payload.manifestPreserved).toBe(true);
      const message = payload.errors?.[0]?.message;
      expect(typeof message).toBe("string");
      expect((message as string).startsWith("serverStop on local refused (LeasesActive")).toBe(
        true,
      );
    });

    expect(loadComposite("stack")).not.toBeNull();
  });

  // Kills: auditing a refused destroy without the code.
  test("R4 the wet audit row records ok:false, destroy_refused, and manifestPreserved", async () => {
    installIdleSessionBinding();

    await withConnected(async (client) => {
      await callWetDestroy(client);
    });

    const rows = auditLines(SERVER_SLUG).filter(
      (line) => line["tool"] === "llamactl.composite.destroy",
    );
    const row = rows.at(-1);
    expect(row).toBeDefined();
    const result = row?.["result"] as
      | { ok?: unknown; code?: unknown; manifestPreserved?: unknown }
      | undefined;
    expect(result?.ok).toBe(false);
    expect(result?.code).toBe("destroy_refused");
    expect(result?.manifestPreserved).toBe(true);
  });

  test("G1 guard: an unfenced wet destroy stays a normal success and removes the YAML", async () => {
    // Guard: the happy path must not gain isError or preserve the composite.
    setResidencyLeaseRegistry(null);
    setSessionRefcountRegistry(null);

    await withConnected(async (client) => {
      const result = await callWetDestroy(client);
      expect(isErrorOf(result)).toBeFalsy();

      const payload = payloadOf(result);
      expect(payload.manifestPreserved).toBe(false);
    });

    expect(loadComposite("stack")).toBeNull();
  });

  test("G2 guard: dryRun stays a non-error preview with wouldRemove and keeps the YAML", async () => {
    // Guard: dry-run previews must not take the refusal mapping or delete state.
    await withConnected(async (client) => {
      const result = await client.callTool({
        name: "llamactl.composite.destroy",
        arguments: { name: "stack", dryRun: true },
      });
      expect(isErrorOf(result)).toBeFalsy();

      const payload = payloadOf(result);
      expect(payload.dryRun).toBe(true);
      expect(payload.wouldRemove).toBeDefined();
    });

    expect(loadComposite("stack")).not.toBeNull();
  });
});
