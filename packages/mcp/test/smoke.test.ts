import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveModelHost } from "../../remote/src/workload/modelhost-store.js";
import { saveNodeRun } from "../../remote/src/workload/noderun-store.js";
import { saveWorkload } from "../../remote/src/workload/store.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "../src/safe-fs.js";
import { buildMcpServer, type WorkloadDeleteDryRunResult } from "../src/server.js";

/**
 * Smoke tests for the llamactl MCP surface. Every mutation has a
 * dry-run + wet-run case; the audit sink is scoped to a tempdir so
 * tests never touch `~/.llamactl/mcp/audit/*`.
 */

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
    // Scope pipeline-tool pickup into the sandbox runtime dir — any
    // individual test that wants to populate it writes files into
    // `${runtimeDir}/mcp-pipelines/` before calling `connected()`.
    LLAMACTL_MCP_PIPELINES_DIR: join(runtimeDir, "mcp-pipelines"),
  });
});

afterEach(() => {
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  rmSync(runtimeDir, { recursive: true, force: true });
  rmSync(auditDir, { recursive: true, force: true });
});

function seedNodeBudgetFixtures(): void {
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
  saveWorkload(
    {
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: { name: "gemma4-26b-a4b-mtp-local", labels: {}, annotations: {} },
      spec: {
        node: "local",
        enabled: true,
        target: { kind: "rel", value: "fake-org/fake-model.gguf" },
        extraArgs: [],
        workers: [],
        restartPolicy: "Always",
        resources: { expectedMemoryGiB: 18 },
        endpoint: { host: "127.0.0.1", port: 8181 },
        timeoutSeconds: 60,
        gateway: false,
        allowExternalBind: false,
      },
    },
    workloadsDir,
  );
}

function seedModelRunFixture(): void {
  const workloadsDir = join(runtimeDir, "workloads");
  saveWorkload(
    {
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: { name: "gemma4-run-a", labels: {}, annotations: {} },
      spec: {
        node: "local",
        enabled: true,
        target: { kind: "rel", value: "acme/model-run.gguf" },
        extraArgs: [],
        workers: [],
        restartPolicy: "Always",
        resources: { expectedMemoryGiB: 12 },
        endpoint: { host: "127.0.0.1", port: 8183 },
        timeoutSeconds: 60,
        gateway: false,
        allowExternalBind: false,
      },
    },
    workloadsDir,
  );
}

function seedModelHostFixture(): void {
  const workloadsDir = join(runtimeDir, "workloads");
  saveModelHost(
    {
      apiVersion: "llamactl/v1",
      kind: "ModelHost",
      metadata: { name: "mlx-host-a", labels: {} },
      spec: {
        engine: "omlx",
        node: "local",
        enabled: true,
        binary: "/usr/local/bin/omlx",
        endpoint: { host: "127.0.0.1", port: 8182 },
        hostedModels: [{ rel: "acme/model.gguf" }],
        extraArgs: [],
        restartPolicy: "Always",
        timeoutSeconds: 60,
      },
    },
    workloadsDir,
  );
}

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

// MCP tools NOT in ops-chat dispatch (pure external-client surface).
const MCP_ONLY_EXCLUDED = new Set([
  "llamactl.admit.measure",
  "llamactl.embersynth.set-default-profile",
  "llamactl.embersynth.sync",
  "llamactl.fleet.audit",
  "llamactl.fleet.executions",
  "llamactl.fleet.journal.tail",
  "llamactl.fleet.pressure",
  "llamactl.fleet.pressure.status",
  "llamactl.fleet.proposals",
  "llamactl.fleet.snapshot",
  "llamactl.fleet.supervisor.audit",
  "llamactl.fleet.supervisor.status",
  "llamactl.models.leaderboard",
  "llamactl.supervisor.execute",
  "llamactl_admit_measure",
  "llamactl_fleet_audit",
  "llamactl_fleet_executions",
  "llamactl_fleet_journal_tail",
  "llamactl_fleet_pressure",
  "llamactl_fleet_pressure_status",
  "llamactl_fleet_proposals",
  "llamactl_fleet_snapshot",
  "llamactl_fleet_supervisor_audit",
  "llamactl_fleet_supervisor_status",
  "llamactl_models_leaderboard",
  "llamactl_supervisor_execute",
]);

// Ops-chat tools NOT yet exposed as MCP server tools.
const OPS_CHAT_ONLY_EXCLUDED = new Set<string>();

async function listMcpToolNames(): Promise<string[]> {
  const { client } = await connected();
  const list = await client.listTools();
  return list.tools.map((t) => t.name).sort();
}

describe("@llamactl/mcp read surface", () => {
  test("listTools advertises the full read + mutation surface", async () => {
    const names = await listMcpToolNames();
    // Also assert that every llamactl.* tool (minus the two we
    // intentionally skip today) is wired into the Ops Chat dispatch.
    // Drift here = N.4 UI 404s on a tool the MCP server advertises.
    const { KNOWN_OPS_CHAT_TOOLS } = await import("../../remote/src/index.js");
    const mcpEligible = names.filter((n) => !MCP_ONLY_EXCLUDED.has(n)).sort();
    const opsChatEligible = [...KNOWN_OPS_CHAT_TOOLS]
      .filter((n) => !OPS_CHAT_ONLY_EXCLUDED.has(n))
      .sort();
    expect(mcpEligible).toEqual(opsChatEligible);

    expect(names).toEqual([
      "llamactl.admit.measure",
      "llamactl.bench.compare",
      "llamactl.bench.history",
      "llamactl.catalog.list",
      "llamactl.catalog.promote",
      "llamactl.catalog.promoteDelete",
      "llamactl.composite.apply",
      "llamactl.composite.destroy",
      "llamactl.composite.get",
      "llamactl.composite.list",
      "llamactl.cost.snapshot",
      "llamactl.embersynth.set-default-profile",
      "llamactl.embersynth.sync",
      "llamactl.env",
      "llamactl.fleet.audit",
      "llamactl.fleet.executions",
      "llamactl.fleet.journal.tail",
      "llamactl.fleet.pressure",
      "llamactl.fleet.pressure.status",
      "llamactl.fleet.proposals",
      "llamactl.fleet.snapshot",
      "llamactl.fleet.supervisor.audit",
      "llamactl.fleet.supervisor.status",
      "llamactl.models.leaderboard",
      "llamactl.node.add",
      "llamactl.node.budget",
      "llamactl.node.facts",
      "llamactl.node.ls",
      "llamactl.node.remove",
      "llamactl.operator.plan",
      "llamactl.project.apply",
      "llamactl.project.get",
      "llamactl.project.index",
      "llamactl.project.list",
      "llamactl.project.remove",
      "llamactl.project.resolveRouting",
      "llamactl.promotions.list",
      "llamactl.rag.bench",
      "llamactl.rag.delete",
      "llamactl.rag.listCollections",
      "llamactl.rag.pipeline.apply",
      "llamactl.rag.pipeline.draft",
      "llamactl.rag.pipeline.get",
      "llamactl.rag.pipeline.list",
      "llamactl.rag.pipeline.remove",
      "llamactl.rag.pipeline.run",
      "llamactl.rag.search",
      "llamactl.rag.store",
      "llamactl.reconciler.kick",
      "llamactl.server.status",
      "llamactl.server.stop",
      "llamactl.supervisor.execute",
      "llamactl.workload.apply",
      "llamactl.workload.delete",
      "llamactl.workload.list",
      "llamactl_admit_measure",
      "llamactl_fleet_audit",
      "llamactl_fleet_executions",
      "llamactl_fleet_journal_tail",
      "llamactl_fleet_pressure",
      "llamactl_fleet_pressure_status",
      "llamactl_fleet_proposals",
      "llamactl_fleet_snapshot",
      "llamactl_fleet_supervisor_audit",
      "llamactl_fleet_supervisor_status",
      "llamactl_models_leaderboard",
      "llamactl_supervisor_execute",
    ]);
  });

  test("opsChatToolCoverage surface claims match the live MCP registry", async () => {
    const names = await listMcpToolNames();
    const mcpNameSet = new Set(names);
    const { OPS_CHAT_TOOLS, toolSurfaces } = await import("../../remote/src/index.js");

    for (const entry of OPS_CHAT_TOOLS) {
      if (toolSurfaces(entry.name).includes("mcp")) {
        expect(mcpNameSet.has(entry.name)).toBe(true);
      }
    }

    const mcpEligible = names.filter((n) => !MCP_ONLY_EXCLUDED.has(n)).sort();
    for (const name of mcpEligible) {
      const entry = OPS_CHAT_TOOLS.find((candidate) => candidate.name === name);
      expect(entry).toBeDefined();
      expect(entry ? toolSurfaces(entry.name).includes("mcp") : false).toBe(true);
    }
  });

  test("llamactl.env returns a resolved environment snapshot", async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.env",
      arguments: {},
    });
    const parsed = JSON.parse(textOf(result)) as { LOCAL_AI_RUNTIME_DIR: string };
    expect(parsed.LOCAL_AI_RUNTIME_DIR).toBe(runtimeDir);
  });

  test("llamactl.bench.history returns an empty history in a fresh runtime", async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.bench.history",
      arguments: { limit: 10 },
    });
    const parsed = JSON.parse(textOf(result)) as {
      count: number;
      total: number;
      legacyCount: number;
      rows: unknown[];
    };
    expect(parsed.count).toBe(0);
    expect(parsed.rows).toEqual([]);
  });

  test("llamactl.cost.snapshot returns zero totals with no usage corpus", async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.cost.snapshot",
      arguments: { days: 7 },
    });
    const parsed = JSON.parse(textOf(result)) as { totals?: { requestCount?: number } };
    expect(parsed.totals?.requestCount ?? 0).toBe(0);
  });

  test("llamactl.operator.plan stub mode returns a plan", async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.operator.plan",
      arguments: {
        goal: "promote the fastest vision model on macbook-pro-48g",
        mode: "stub",
        // Stub refuses to emit a plan whose tools aren't in the catalog.
        // Supply the one the stub happens to use.
        tools: [
          {
            name: "nova.ops.overview",
            description: "fleet overview",
            tier: "read" as const,
          },
        ],
      },
    });
    const parsed = JSON.parse(textOf(result)) as {
      ok: boolean;
      plan?: { steps: unknown[] };
      executor?: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.executor).toBe("stub");
    expect(Array.isArray(parsed.plan?.steps)).toBe(true);
  });

  test("llamactl.operator.plan llm mode reports config error without API key", async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.operator.plan",
      arguments: {
        goal: "list catalog",
        mode: "llm",
        model: "gpt-4o-mini",
        apiKeyEnv: "__DEFINITELY_NOT_SET__",
      },
    });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; reason?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("config");
  });

  test("llamactl.catalog.list returns curated entries", async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.catalog.list",
      arguments: { scope: "builtin" },
    });
    const parsed = JSON.parse(textOf(result)) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  test("llamactl.server.status serializes the resolved status, not a pending promise", async () => {
    // Regression: the handler must await the async serverStatus()
    // before handing it to toTextContent — JSON.stringify on a
    // pending Promise silently yields "{}" on the wire.
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.server.status",
      arguments: { workload: "gemma4-run-a" },
    });
    const parsed = JSON.parse(textOf(result)) as {
      state: "up" | "down";
      endpoint: string;
      health: { httpCode: number | null; reachable: boolean };
    };
    expect(["up", "down"]).toContain(parsed.state);
    expect(typeof parsed.endpoint).toBe("string");
    expect(typeof parsed.health.reachable).toBe("boolean");
  });

  test("llamactl.workload.list returns the empty shape when no manifests exist", async () => {
    // runtime dir is a freshly-created tempdir with no workloads/.
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.workload.list",
      arguments: {},
    });
    const parsed = JSON.parse(textOf(result)) as { count: number; workloads: unknown[] };
    expect(parsed.count).toBe(0);
    expect(parsed.workloads).toEqual([]);
  });

  test("llamactl.node.budget returns the seeded workload rollup", async () => {
    seedNodeBudgetFixtures();
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.node.budget",
      arguments: { node: "local" },
    });
    const parsed = JSON.parse(textOf(result)) as {
      budget: number;
      reserved: number;
      workloads: {
        name: string;
        endpoint: string | null;
        phase: string;
        expectedMemoryGiB: number | null;
      }[];
    };
    expect(parsed.budget).toBeGreaterThan(0);
    expect(parsed.reserved).toBe(18);
    const row = parsed.workloads.find((w) => w.name === "gemma4-26b-a4b-mtp-local");
    expect(row).toBeDefined();
    expect(row?.endpoint).toBe("127.0.0.1:8181");
    expect(row?.phase).toBe("Pending");
  });

  test("llamactl.workload.apply dry-run previews kind/name/node without applying", async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.workload.apply",
      arguments: {
        yaml: [
          "apiVersion: llamactl/v1",
          "kind: ModelRun",
          "metadata:",
          "  name: wl-apply-preview",
          "spec:",
          "  node: local",
          "  target:",
          "    kind: rel",
          "    value: fake-org/fake-model.gguf",
          "",
        ].join("\n"),
        dryRun: true,
      },
    });
    const parsed = JSON.parse(textOf(result)) as {
      dryRun: boolean;
      would: { kind: string; name: string; node: string };
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.would.kind).toBe("ModelRun");
    expect(parsed.would.name).toBe("wl-apply-preview");
    expect(parsed.would.node).toBe("local");
  });

  test("llamactl.workload.apply dry-run rejects an invalid manifest", async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.workload.apply",
      arguments: { yaml: "kind: Nonsense\nfoo: bar", dryRun: true },
    });
    const parsed = JSON.parse(textOf(result)) as { ok?: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/invalid workload manifest/);
  });

  test("llamactl.project.list returns the registered projects", async () => {
    const { client } = await connected();
    const result = await client.callTool({ name: "llamactl.project.list", arguments: {} });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; projects: unknown[] };
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.projects)).toBe(true);
  });

  test("llamactl.project.apply dry-run reports bytes without writing", async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.project.apply",
      arguments: { manifestYaml: "apiVersion: llamactl/v1\nkind: Project\n", dryRun: true },
    });
    const parsed = JSON.parse(textOf(result)) as {
      dryRun: boolean;
      wouldApply: { bytes: number };
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.wouldApply.bytes).toBeGreaterThan(0);
  });

  test("llamactl.reconciler.kick dry-run reports intent without reconciling", async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.reconciler.kick",
      arguments: { dryRun: true },
    });
    const parsed = JSON.parse(textOf(result)) as { dryRun: boolean; wouldReconcile: boolean };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.wouldReconcile).toBe(true);
  });

  test("llamactl.server.stop dry-run reports the target without stopping", async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.server.stop",
      arguments: { workload: "ghost", dryRun: true },
    });
    const parsed = JSON.parse(textOf(result)) as {
      dryRun: boolean;
      wouldStop: { workload: string };
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.wouldStop.workload).toBe("ghost");
  });

  test('llamactl.workload.delete dry-run reports "no manifest" when absent', async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.workload.delete",
      arguments: { name: "does-not-exist", dryRun: true },
    });
    const parsed = JSON.parse(textOf(result)) as WorkloadDeleteDryRunResult;
    expect(parsed.dryRun).toBe(true);
    expect(parsed.found).toBe(false);
    expect(parsed.message).toMatch(/no manifest named/);
  });

  test("llamactl.workload.delete dry-run resolves a ModelHost manifest", async () => {
    seedModelHostFixture();
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.workload.delete",
      arguments: { name: "mlx-host-a", dryRun: true },
    });
    const parsed = JSON.parse(textOf(result)) as WorkloadDeleteDryRunResult;
    expect(parsed.dryRun).toBe(true);
    expect(parsed.found).toBe(true);
    expect(parsed.node).toBe("local");
    expect(parsed.rel).toBe("acme/model.gguf");
    expect(parsed.kind).toBe("ModelHost");
    expect(parsed.message).toContain("mlx-host-a");
  });

  test("llamactl.workload.delete dry-run resolves a ModelRun manifest", async () => {
    seedModelRunFixture();
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.workload.delete",
      arguments: { name: "gemma4-run-a", dryRun: true },
    });
    const parsed = JSON.parse(textOf(result)) as WorkloadDeleteDryRunResult;
    expect(parsed.dryRun).toBe(true);
    expect(parsed.found).toBe(true);
    expect(parsed.kind).toBe("ModelRun");
    expect(parsed.node).toBe("local");
    expect(parsed.rel).toBe("acme/model-run.gguf");
    expect(parsed.message).toContain("gemma4-run-a");
  });

  test("llamactl.workload.delete rejects path-traversal names (dry-run)", async () => {
    const { client } = await connected();
    for (const name of ["../escape", "../../etc/passwd", "../etc/x"]) {
      const result = await client.callTool({
        name: "llamactl.workload.delete",
        arguments: { name, dryRun: true },
      });
      const parsed = JSON.parse(textOf(result)) as { ok: boolean; error?: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toMatch(/invalid workload name/i);
    }
  });

  test("llamactl.workload.delete rejects path-traversal names (wet-run)", async () => {
    const { client } = await connected();
    for (const name of ["../escape", "../../etc/passwd", "../etc/x"]) {
      const result = await client.callTool({
        name: "llamactl.workload.delete",
        arguments: { name, dryRun: false },
      });
      const parsed = JSON.parse(textOf(result)) as { ok: boolean; error?: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toMatch(/invalid workload name/i);
    }
  });

  test("llamactl.workload.delete wet-run reports the deleted manifest kind", async () => {
    seedModelHostFixture();
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.workload.delete",
      arguments: { name: "mlx-host-a", dryRun: false },
    });
    const parsed = JSON.parse(textOf(result)) as {
      ok: boolean;
      removed: boolean;
      manifest: { kind: "ModelRun" | "ModelHost" } | null;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.removed).toBe(true);
    expect(parsed.manifest?.kind).toBe("ModelHost");
  });
});

describe("@llamactl/mcp mutations", () => {
  test("catalog.promote dry-run previews without writing or emitting a wet audit", async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.catalog.promote",
      arguments: {
        profile: "macbook-pro-48g",
        preset: "best",
        rel: "acme/model-Q4.gguf",
        dryRun: true,
      },
    });
    const parsed = JSON.parse(textOf(result)) as { dryRun: boolean; message: string };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.message).toContain("acme/model-Q4.gguf");

    // No file written.
    expect(existsSync(join(runtimeDir, "preset-overrides.tsv"))).toBe(false);

    // Audit captures the dry-run.
    const audits = auditLines("llamactl");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.tool).toBe("llamactl.catalog.promote");
    expect(audits[0]!.dryRun).toBe(true);
  });

  test("catalog.promote wet-run writes TSV and audits the action", async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.catalog.promote",
      arguments: {
        profile: "macbook-pro-48g",
        preset: "best",
        rel: "acme/model-Q4.gguf",
        dryRun: false,
      },
    });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; promotions: unknown[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.promotions).toHaveLength(1);

    const tsv = readFileSync(join(runtimeDir, "preset-overrides.tsv"), "utf8");
    expect(tsv).toContain("acme/model-Q4.gguf");

    const audits = auditLines("llamactl");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.dryRun).toBe(false);
    expect((audits[0]!.result as { ok: boolean }).ok).toBe(true);
  });

  test("catalog.promoteDelete round-trips", async () => {
    const { client } = await connected();
    await client.callTool({
      name: "llamactl.catalog.promote",
      arguments: {
        profile: "macbook-pro-48g",
        preset: "best",
        rel: "acme/model-Q4.gguf",
        dryRun: false,
      },
    });

    // Dry-run delete — still there.
    const dry = await client.callTool({
      name: "llamactl.catalog.promoteDelete",
      arguments: { profile: "macbook-pro-48g", preset: "best", dryRun: true },
    });
    const dryParsed = JSON.parse(textOf(dry)) as { dryRun: boolean; prior: { rel: string } | null };
    expect(dryParsed.dryRun).toBe(true);
    expect(dryParsed.prior?.rel).toBe("acme/model-Q4.gguf");

    // Wet-run delete — gone.
    const wet = await client.callTool({
      name: "llamactl.catalog.promoteDelete",
      arguments: { profile: "macbook-pro-48g", preset: "best", dryRun: false },
    });
    const wetParsed = JSON.parse(textOf(wet)) as { ok: boolean; removed: boolean };
    expect(wetParsed.ok).toBe(true);
    expect(wetParsed.removed).toBe(true);
  });

  test("embersynth.sync dry-run reports would-be config without writing", async () => {
    const yamlPath = join(runtimeDir, "embersynth.yaml");
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.embersynth.sync",
      arguments: { path: yamlPath, dryRun: true },
    });
    const parsed = JSON.parse(textOf(result)) as {
      dryRun: boolean;
      profiles: string[];
      syntheticModels: string[];
    };
    expect(parsed.dryRun).toBe(true);
    // Default profiles include `private-first` from K.4.
    expect(parsed.profiles).toContain("private-first");
    expect(parsed.syntheticModels).toContain("fusion-private-first");
    expect(existsSync(yamlPath)).toBe(false);
  });

  test("embersynth.sync wet-run writes the YAML", async () => {
    const yamlPath = join(runtimeDir, "embersynth.yaml");
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.embersynth.sync",
      arguments: { path: yamlPath, dryRun: false },
    });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(existsSync(yamlPath)).toBe(true);
    const body = readFileSync(yamlPath, "utf8");
    expect(body).toContain("private-first");
  });

  test("embersynth.set-default-profile missing config → config-missing", async () => {
    const yamlPath = join(runtimeDir, "does-not-exist.yaml");
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.embersynth.set-default-profile",
      arguments: { profile: "private-first", path: yamlPath },
    });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; reason?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("config-missing");
  });

  test("embersynth.set-default-profile unknown profile → rejected with availableProfiles", async () => {
    const yamlPath = join(runtimeDir, "embersynth.yaml");
    const { client } = await connected();
    // Seed a real config first via sync.
    await client.callTool({
      name: "llamactl.embersynth.sync",
      arguments: { path: yamlPath, dryRun: false },
    });
    const result = await client.callTool({
      name: "llamactl.embersynth.set-default-profile",
      arguments: { profile: "does-not-exist", path: yamlPath },
    });
    const parsed = JSON.parse(textOf(result)) as {
      ok: boolean;
      reason?: string;
      availableProfiles?: string[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("unknown-profile");
    expect(parsed.availableProfiles?.length ?? 0).toBeGreaterThan(0);
  });

  test("embersynth.set-default-profile dry-run reports diff without writing", async () => {
    const yamlPath = join(runtimeDir, "embersynth.yaml");
    const { client } = await connected();
    await client.callTool({
      name: "llamactl.embersynth.sync",
      arguments: { path: yamlPath, dryRun: false },
    });
    const before = readFileSync(yamlPath, "utf8");
    const result = await client.callTool({
      name: "llamactl.embersynth.set-default-profile",
      arguments: { profile: "private-first", path: yamlPath }, // dryRun defaults true
    });
    const parsed = JSON.parse(textOf(result)) as {
      ok: boolean;
      mode: string;
      syntheticModel: string;
      previous: string | null;
      next: string;
      unchanged: boolean;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe("dry-run");
    expect(parsed.syntheticModel).toBe("fusion-auto");
    expect(parsed.next).toBe("private-first");
    expect(readFileSync(yamlPath, "utf8")).toBe(before);
  });

  test("embersynth.set-default-profile wet-run rewrites syntheticModels mapping", async () => {
    const yamlPath = join(runtimeDir, "embersynth.yaml");
    const { client } = await connected();
    await client.callTool({
      name: "llamactl.embersynth.sync",
      arguments: { path: yamlPath, dryRun: false },
    });
    const result = await client.callTool({
      name: "llamactl.embersynth.set-default-profile",
      arguments: {
        profile: "private-first",
        path: yamlPath,
        dryRun: false,
      },
    });
    const parsed = JSON.parse(textOf(result)) as {
      ok: boolean;
      mode: string;
      previous: string | null;
      next: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe("wet");
    expect(parsed.next).toBe("private-first");
    const body = readFileSync(yamlPath, "utf8");
    // fusion-auto now maps to private-first in the rewritten file.
    expect(body).toMatch(/fusion-auto:\s*private-first/);
  });

  test("embersynth.set-default-profile wet-run is idempotent (unchanged flag set)", async () => {
    const yamlPath = join(runtimeDir, "embersynth.yaml");
    const { client } = await connected();
    await client.callTool({
      name: "llamactl.embersynth.sync",
      arguments: { path: yamlPath, dryRun: false },
    });
    await client.callTool({
      name: "llamactl.embersynth.set-default-profile",
      arguments: { profile: "private-first", path: yamlPath, dryRun: false },
    });
    const result = await client.callTool({
      name: "llamactl.embersynth.set-default-profile",
      arguments: { profile: "private-first", path: yamlPath, dryRun: false },
    });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; unchanged: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.unchanged).toBe(true);
  });

  test("embersynth.set-default-profile remaps a non-default synthetic model", async () => {
    const yamlPath = join(runtimeDir, "embersynth.yaml");
    const { client } = await connected();
    await client.callTool({
      name: "llamactl.embersynth.sync",
      arguments: { path: yamlPath, dryRun: false },
    });
    const result = await client.callTool({
      name: "llamactl.embersynth.set-default-profile",
      arguments: {
        profile: "private-first",
        syntheticModel: "fusion-fast",
        path: yamlPath,
        dryRun: false,
      },
    });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; syntheticModel: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.syntheticModel).toBe("fusion-fast");
    const body = readFileSync(yamlPath, "utf8");
    expect(body).toMatch(/fusion-fast:\s*private-first/);
  });
});

describe("@llamactl/mcp M.1 pipeline-tool pickup", () => {
  test("registers a PipelineTool stub from the pipelines dir", async () => {
    // Write the stub the K.6 exporter produces directly into the
    // sandbox pipelines dir, then boot the MCP server and list tools.
    const { writeFileSync, mkdirSync: mk } = await import("node:fs");
    const dir = join(runtimeDir, "mcp-pipelines");
    mk(dir, { recursive: true });
    const stub = {
      apiVersion: "llamactl/v1",
      kind: "PipelineTool",
      name: "llamactl.pipeline.demo-pickup",
      title: "Demo pickup",
      description: "Pipeline for pickup test",
      inputSchema: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      },
      stages: [
        { node: "local", model: "m1", systemPrompt: "", capabilities: [] },
        {
          node: "local",
          model: "m2",
          systemPrompt: "You are a reviewer.",
          capabilities: ["reasoning"],
        },
      ],
    };
    writeFileSync(join(dir, "demo-pickup.json"), JSON.stringify(stub, null, 2) + "\n", "utf8");

    const { client } = await connected();
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).toContain("llamactl.pipeline.demo-pickup");
    const picked = list.tools.find((t) => t.name === "llamactl.pipeline.demo-pickup")!;
    expect(picked.description).toBe("Pipeline for pickup test");
    // The registered input schema carries the single `input` field.
    const schema = picked.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty("input");
    expect(schema.required).toContain("input");
  });

  test("malformed pipeline files are skipped silently", async () => {
    const { writeFileSync, mkdirSync: mk } = await import("node:fs");
    const dir = join(runtimeDir, "mcp-pipelines");
    mk(dir, { recursive: true });
    // One valid + one malformed.
    const good = {
      apiVersion: "llamactl/v1",
      kind: "PipelineTool",
      name: "llamactl.pipeline.good",
      title: "Good",
      description: "valid pipeline",
      inputSchema: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      },
      stages: [{ node: "local", model: "m1", systemPrompt: "", capabilities: [] }],
    };
    writeFileSync(join(dir, "good.json"), JSON.stringify(good), "utf8");
    writeFileSync(join(dir, "bad.json"), "{not valid json", "utf8");
    writeFileSync(
      join(dir, "missing-kind.json"),
      JSON.stringify({ apiVersion: "llamactl/v1", name: "x" }),
      "utf8",
    );

    const { client } = await connected();
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).toContain("llamactl.pipeline.good");
    expect(names).not.toContain("llamactl.pipeline.x");
  });

  test("empty pipelines dir does not break tool registration", async () => {
    // No LLAMACTL_MCP_PIPELINES_DIR content; MCP server boots cleanly
    // and the baseline llamactl.* tools remain advertised (22 from
    // before + 4 from the Phase 5 composite surface + 5 from the R1
    // rag-pipeline surface + 1 from the R3.a draft tool + 1 from
    // the Aliveness-Slice-3 rag-bench tool + 1 from the workload.apply
    // surface-parity tool + 6 from the project surface-parity tools +
    // 2 from the server/reconciler control tools + 12 from the dotted
    // fleet/admit/supervisor/models surface; the retained underscore
    // aliases use the `llamactl_` prefix and are not counted here).
    const { client } = await connected();
    const list = await client.listTools();
    const llamactlTools = list.tools
      .map((t) => t.name)
      .filter((n) => n.startsWith("llamactl.") && !n.startsWith("llamactl.pipeline."));
    expect(llamactlTools.length).toBe(55);
  });
});
