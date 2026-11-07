import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveModelHost } from "../../remote/src/workload/modelhost-store.js";
import { saveNodeRun } from "../../remote/src/workload/noderun-store.js";
import { saveWorkload } from "../../remote/src/workload/store.js";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../src/safe-fs.js";
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
  });
});

afterEach(() => {
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

function seedWorkloads(): void {
  const workloadsDir = join(runtimeDir, "workloads");
  saveWorkload(
    {
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: { name: "zeta-run", labels: {}, annotations: {} },
      spec: {
        node: "local",
        enabled: true,
        target: { kind: "rel", value: "acme/zeta.gguf" },
        extraArgs: [],
        workers: [],
        restartPolicy: "Always",
        resources: { expectedMemoryGiB: 12 },
        endpoint: { host: "127.0.0.1", port: 8181 },
        timeoutSeconds: 60,
        gateway: false,
        allowExternalBind: false,
      },
    },
    workloadsDir,
  );
  saveWorkload(
    {
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: { name: "mid-run", labels: {}, annotations: {} },
      spec: {
        node: "gpu-1",
        enabled: true,
        target: { kind: "rel", value: "acme/mid.gguf" },
        extraArgs: [],
        workers: [],
        restartPolicy: "OnFailure",
        resources: { expectedMemoryGiB: 18 },
        endpoint: { host: "127.0.0.1", port: 8182 },
        timeoutSeconds: 60,
        gateway: true,
        allowExternalBind: false,
      },
    },
    workloadsDir,
  );
  saveModelHost(
    {
      apiVersion: "llamactl/v1",
      kind: "ModelHost",
      metadata: { name: "alpha-host", labels: {} },
      spec: {
        engine: "omlx",
        node: "local",
        enabled: true,
        binary: "/usr/local/bin/omlx",
        endpoint: { host: "127.0.0.1", port: 8183 },
        hostedModels: [{ rel: "acme/host.gguf" }],
        extraArgs: [],
        restartPolicy: "Always",
        timeoutSeconds: 60,
      },
    },
    workloadsDir,
  );
  saveNodeRun(
    {
      apiVersion: "llamactl/v1",
      kind: "NodeRun",
      metadata: { name: "budget-node", labels: {} },
      spec: { node: "local", budget: { memoryGiB: 24 }, infra: [] },
    },
    workloadsDir,
  );
}

describe("read-control-tools", () => {
  test("llamactl.workload.list merges and sorts ModelRun + ModelHost, excludes NodeRun", async () => {
    seedWorkloads();
    const { client, server } = await connected();
    const result = await client.callTool({
      name: "llamactl.workload.list",
      arguments: {},
    });
    const parsed = JSON.parse(textOf(result)) as { count: number; workloads: unknown[] };
    expect(parsed.count).toBe(3);
    expect(parsed.workloads).toEqual([
      {
        name: "alpha-host",
        kind: "ModelHost",
        node: "local",
        rel: "acme/host.gguf",
        gateway: false,
        restartPolicy: "Always",
        status: null,
      },
      {
        name: "mid-run",
        kind: "ModelRun",
        node: "gpu-1",
        rel: "acme/mid.gguf",
        gateway: true,
        restartPolicy: "OnFailure",
        status: null,
      },
      {
        name: "zeta-run",
        kind: "ModelRun",
        node: "local",
        rel: "acme/zeta.gguf",
        gateway: false,
        restartPolicy: "Always",
        status: null,
      },
    ]);
    await server.close();
    await client.close();
  });

  test("llamactl.workload.list with only a NodeRun returns empty", async () => {
    const workloadsDir = join(runtimeDir, "workloads");
    saveNodeRun(
      {
        apiVersion: "llamactl/v1",
        kind: "NodeRun",
        metadata: { name: "budget-node", labels: {} },
        spec: { node: "local", budget: { memoryGiB: 24 }, infra: [] },
      },
      workloadsDir,
    );
    const { client, server } = await connected();
    const result = await client.callTool({
      name: "llamactl.workload.list",
      arguments: {},
    });
    const parsed = JSON.parse(textOf(result)) as { count: number; workloads: unknown[] };
    expect(parsed.count).toBe(0);
    expect(parsed.workloads).toEqual([]);
    await server.close();
    await client.close();
  });

  test("llamactl.promotions.list with no overrides file returns []", async () => {
    const { client, server } = await connected();
    const result = await client.callTool({
      name: "llamactl.promotions.list",
      arguments: {},
    });
    const parsed = JSON.parse(textOf(result)) as unknown[];
    expect(parsed).toEqual([]);
    await server.close();
    await client.close();
  });

  test("llamactl.promotions.list parses the TSV", async () => {
    const tsvPath = join(runtimeDir, "preset-overrides.tsv");
    writeFileSync(
      tsvPath,
      `# header
macbook-pro-48g\tbest\tacme/best.gguf\t2026-01-01T00:00:00Z
balanced\tfast\tacme/short.gguf
nope-profile\tbest\tacme/x.gguf\t
mac-mini-16g\tfast\tacme/fast.gguf\t`,
      "utf8",
    );
    const { client, server } = await connected();
    const result = await client.callTool({
      name: "llamactl.promotions.list",
      arguments: {},
    });
    const parsed = JSON.parse(textOf(result)) as {
      profile: string;
      preset: string;
      rel: string;
      updated_at: string;
    }[];
    expect(parsed).toEqual([
      {
        profile: "macbook-pro-48g",
        preset: "best",
        rel: "acme/best.gguf",
        updated_at: "2026-01-01T00:00:00Z",
      },
      { profile: "mac-mini-16g", preset: "fast", rel: "acme/fast.gguf", updated_at: "" },
    ]);
    await server.close();
    await client.close();
  });

  test("llamactl.server.stop dryRun with graceSeconds 30", async () => {
    const { client, server } = await connected();
    const result = await client.callTool({
      name: "llamactl.server.stop",
      arguments: { workload: "w1", graceSeconds: 30, dryRun: true },
    });
    const parsed = JSON.parse(textOf(result)) as {
      dryRun: boolean;
      wouldStop: { workload: string; graceSeconds: number | null };
    };
    expect(parsed).toEqual({ dryRun: true, wouldStop: { workload: "w1", graceSeconds: 30 } });
    await server.close();
    await client.close();
  });

  test("llamactl.server.stop dryRun without graceSeconds has null graceSeconds", async () => {
    const { client, server } = await connected();
    const result = await client.callTool({
      name: "llamactl.server.stop",
      arguments: { workload: "w1", dryRun: true },
    });
    const parsed = JSON.parse(textOf(result)) as {
      dryRun: boolean;
      wouldStop: { workload: string; graceSeconds: number | null };
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.wouldStop.graceSeconds).toBeNull();
    expect(parsed.wouldStop.workload).toBe("w1");
    await server.close();
    await client.close();
  });

  test("llamactl.server.stop dryRun audit writes exactly one line", async () => {
    const { client, server } = await connected();
    const result = await client.callTool({
      name: "llamactl.server.stop",
      arguments: { workload: "w1", graceSeconds: 30, dryRun: true },
    });
    const parsed = JSON.parse(textOf(result)) as {
      dryRun: boolean;
      wouldStop: { workload: string; graceSeconds: number | null };
    };
    expect(parsed.dryRun).toBe(true);
    const lines = auditLines("llamactl");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      tool: "llamactl.server.stop",
      dryRun: true,
    });
    expect(lines[0]!["input"]).toEqual({
      dryRun: true,
      workload: "w1",
    });
    await server.close();
    await client.close();
  });

  test("llamactl.server.stop input bounds: graceSeconds 61, 0, 1.5 rejected; 60 accepted", async () => {
    const { client, server } = await connected();

    const result61 = await client.callTool({
      name: "llamactl.server.stop",
      arguments: { workload: "w1", graceSeconds: 61, dryRun: true },
    });
    expect((result61 as { isError?: boolean }).isError).toBe(true);

    const result0 = await client.callTool({
      name: "llamactl.server.stop",
      arguments: { workload: "w1", graceSeconds: 0, dryRun: true },
    });
    expect((result0 as { isError?: boolean }).isError).toBe(true);

    const result1_5 = await client.callTool({
      name: "llamactl.server.stop",
      arguments: { workload: "w1", graceSeconds: 1.5, dryRun: true },
    });
    expect((result1_5 as { isError?: boolean }).isError).toBe(true);

    const result60 = await client.callTool({
      name: "llamactl.server.stop",
      arguments: { workload: "w1", graceSeconds: 60, dryRun: true },
    });
    const parsed60 = JSON.parse(textOf(result60)) as {
      dryRun: boolean;
      wouldStop: { graceSeconds: number };
    };
    expect(parsed60.dryRun).toBe(true);
    expect(parsed60.wouldStop.graceSeconds).toBe(60);

    const lines = auditLines("llamactl");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: "llamactl.server.stop", dryRun: true });
    await server.close();
    await client.close();
  });

  test("llamactl.reconciler.kick dryRun returns intent and writes one audit line", async () => {
    const { client, server } = await connected();
    const result = await client.callTool({
      name: "llamactl.reconciler.kick",
      arguments: { dryRun: true },
    });
    const parsed = JSON.parse(textOf(result)) as { dryRun: boolean; wouldReconcile: boolean };
    expect(parsed).toEqual({ dryRun: true, wouldReconcile: true });
    const lines = auditLines("llamactl");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      tool: "llamactl.reconciler.kick",
      dryRun: true,
    });
    expect(lines[0]!["input"]).toEqual({ dryRun: true });
    await server.close();
    await client.close();
  });
});
