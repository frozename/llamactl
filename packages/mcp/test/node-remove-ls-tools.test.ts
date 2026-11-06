import { type ClusterNode, type Config, configSchema, config as kubecfg } from "@llamactl/remote";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "../src/safe-fs.js";
import { registerMutationTools } from "../src/tools/mutations.js";
import { registerReadTools } from "../src/tools/reads.js";

type RemoveResult = {
  ok: boolean;
  removed: boolean;
  dryRun: boolean;
  found: boolean;
  node: { name: string } | null;
  message: string;
  error: string;
};

type LsResult = {
  context: string | null;
  cluster: string | null;
  nodes: {
    name: string;
    kind: string;
    hasCloud: boolean;
    hasProvider: boolean;
    endpoint?: string;
  }[];
};

let dir = "";
let envSnapshot: NodeJS.ProcessEnv = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llamactl-mcp-node-remove-"));
  envSnapshot = { ...process.env };
  process.env["LLAMACTL_CONFIG"] = join(dir, "config");
  process.env["LLAMACTL_MCP_AUDIT_DIR"] = join(dir, "audit");
  process.env["DEV_STORAGE"] = dir;
  process.env["LOCAL_AI_RUNTIME_DIR"] = dir;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, envSnapshot);
  rmSync(dir, { recursive: true, force: true });
});

function configPath(): string {
  return process.env["LLAMACTL_CONFIG"]!;
}

function auditDir(): string {
  return process.env["LLAMACTL_MCP_AUDIT_DIR"]!;
}

function textOf(result: unknown): RemoveResult {
  const content = (result as { content?: { type: string; text: string }[] }).content ?? [];
  return JSON.parse(content[0]?.text ?? "") as RemoveResult;
}

function rawText(result: unknown): string {
  const content = (result as { content?: { type: string; text: string }[] }).content ?? [];
  return content[0]?.text ?? "";
}

function seedConfig(cfg: Config = configSchema.freshConfig()): void {
  kubecfg.saveConfig(cfg, configPath());
}

function loadConfig(): Config {
  return kubecfg.loadConfig(configPath());
}

function homeNodes(cfg: Config): ClusterNode[] {
  return cfg.clusters.find((c) => c.name === "home")?.nodes ?? [];
}

function otherClusterNodes(cfg: Config): ClusterNode[] {
  return cfg.clusters.find((c) => c.name === "other")?.nodes ?? [];
}

function auditLines(): Record<string, unknown>[] {
  if (!existsSync(auditDir())) return [];
  const out: Record<string, unknown>[] = [];
  for (const file of readdirSync(auditDir()).filter((f) => f.startsWith("llamactl-"))) {
    for (const line of readFileSync(join(auditDir(), file), "utf8").trim().split("\n")) {
      if (line) out.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return out;
}

type AuditEntry = Record<string, unknown> & {
  tool?: string;
  input?: Record<string, unknown>;
  dryRun?: boolean;
  result?: Record<string, unknown>;
};

function nodeRemoveAuditLines(dryRunValue?: boolean): AuditEntry[] {
  return (auditLines() as AuditEntry[]).filter(
    (entry) =>
      entry.tool === "llamactl.node.remove" &&
      (dryRunValue === undefined || entry.input?.["dryRun"] === dryRunValue),
  );
}

async function connected(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerMutationTools(server);
  registerReadTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function seedFixture(): Config {
  const cfg = configSchema.freshConfig();
  cfg.clusters[0]!.nodes.push(
    { name: "gpu1", endpoint: "https://10.0.0.5:7443" },
    {
      name: "gw1",
      endpoint: "https://10.0.0.1:7443",
      cloud: { provider: "embersynth", baseUrl: "http://localhost:7777/v1" },
    },
    {
      name: "oai1",
      endpoint: "",
      cloud: {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKeyRef: "env:OPENAI_API_KEY",
      },
    },
    { name: "prov1", endpoint: "", provider: { gateway: "gw1", providerName: "openai" } },
  );
  cfg.clusters.push({
    name: "other",
    nodes: [
      { name: "gpu1", endpoint: "https://10.0.0.6:7443" },
      { name: "elsewhere", endpoint: "https://10.0.0.7:7443" },
    ],
  });
  return cfg;
}

describe("llamactl.node.remove", () => {
  test("dry-run of gpu1 previews removal, leaves config unchanged", async () => {
    const cfg = seedFixture();
    seedConfig(cfg);
    const client = await connected();
    const result = textOf(
      await client.callTool({
        name: "llamactl.node.remove",
        arguments: { name: "gpu1", dryRun: true },
      }),
    );
    expect(result.dryRun).toBe(true);
    expect(result.found).toBe(true);
    expect(result.node?.name).toBe("gpu1");
    expect(result.message).toBe("would remove node gpu1 from cluster home");
    // config unchanged — home still has gpu1
    const afterCfg = loadConfig();
    expect(homeNodes(afterCfg).some((n) => n.name === "gpu1")).toBe(true);
    // exactly one audit line, dryRun true, no result key
    const lines = nodeRemoveAuditLines(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.dryRun).toBe(true);
    expect("result" in lines[0]!).toBe(false);
  });

  test("dry-run of node in non-current cluster returns found:false", async () => {
    const cfg = seedFixture();
    seedConfig(cfg);
    const client = await connected();
    const result = textOf(
      await client.callTool({
        name: "llamactl.node.remove",
        arguments: { name: "elsewhere", dryRun: true },
      }),
    );
    expect(result.found).toBe(false);
    expect(result.node).toBe(null);
    expect(result.message).toBe("no node named elsewhere in the current cluster");
  });

  test("wet run of gpu1 removes it from home, preserves other cluster", async () => {
    const cfg = seedFixture();
    seedConfig(cfg);
    const client = await connected();
    const result = textOf(
      await client.callTool({
        name: "llamactl.node.remove",
        arguments: { name: "gpu1" },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);
    expect(result.node?.name).toBe("gpu1");
    // home no longer has gpu1
    const afterCfg = loadConfig();
    expect(homeNodes(afterCfg).some((n) => n.name === "gpu1")).toBe(false);
    // other cluster still has its gpu1 and elsewhere
    const other = otherClusterNodes(afterCfg);
    expect(other.some((n) => n.name === "gpu1")).toBe(true);
    expect(other.some((n) => n.name === "elsewhere")).toBe(true);
    // audit line has dryRun:false and result { removed: true }
    const lines = nodeRemoveAuditLines(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.dryRun).toBe(false);
    expect(lines[0]!.result).toEqual({ removed: true });
  });

  test("wet run of absent node is a no-op", async () => {
    const cfg = seedFixture();
    seedConfig(cfg);
    const before = readFileSync(configPath());
    const client = await connected();
    const result = textOf(
      await client.callTool({
        name: "llamactl.node.remove",
        arguments: { name: "elsewhere" },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(false);
    expect(result.node).toBe(null);
    // config file unchanged
    const after = readFileSync(configPath());
    expect(after.equals(before)).toBe(true);
    // audit result is { removed: false }
    const lines = nodeRemoveAuditLines(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.result).toEqual({ removed: false });
  });

  test("wet run of local refuses, dry-run of local returns found:true", async () => {
    const cfg = seedFixture();
    seedConfig(cfg);
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.node.remove",
      arguments: { name: "local" },
    });
    expect(result).toHaveProperty("isError", true);
    expect(rawText(result)).toContain("refusing to remove the local node");
    // home still contains local
    const afterCfg = loadConfig();
    expect(homeNodes(afterCfg).some((n) => n.name === "local")).toBe(true);
    // no wet (dryRun:false) node.remove audit line exists
    expect(nodeRemoveAuditLines(false)).toHaveLength(0);
    // asymmetry: dry-run of local still reports found:true
    const preview = textOf(
      await client.callTool({
        name: "llamactl.node.remove",
        arguments: { name: "local", dryRun: true },
      }),
    );
    expect(preview.found).toBe(true);
  });

  test("omitting dryRun defaults to wet path", async () => {
    const cfg = seedFixture();
    seedConfig(cfg);
    const client = await connected();
    const result = textOf(
      await client.callTool({
        name: "llamactl.node.remove",
        arguments: { name: "gw1" },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);
  });
});

describe("llamactl.node.ls", () => {
  test("lists home nodes with correct kinds and flags", async () => {
    const cfg = seedFixture();
    seedConfig(cfg);
    const client = await connected();
    const result = textOf(
      await client.callTool({
        name: "llamactl.node.ls",
      }),
    ) as unknown as LsResult;
    expect(result.context).toBe("default");
    expect(result.cluster).toBe("home");
    expect(result.nodes.map((n) => n.name)).toEqual(["local", "gpu1", "gw1", "oai1", "prov1"]);
    const nodeMap = new Map(result.nodes.map((n) => [n.name, n]));
    // local: agent, false, false
    const local = nodeMap.get("local");
    expect(local?.kind).toBe("agent");
    expect(local?.hasCloud).toBe(false);
    expect(local?.hasProvider).toBe(false);
    // gpu1: agent with endpoint
    const gpu1 = nodeMap.get("gpu1");
    expect(gpu1?.kind).toBe("agent");
    expect(gpu1?.endpoint).toBe("https://10.0.0.5:7443");
    // gw1: gateway, hasCloud true
    const gw1 = nodeMap.get("gw1");
    expect(gw1?.kind).toBe("gateway");
    expect(gw1?.hasCloud).toBe(true);
    // oai1: cloud, hasCloud true
    const oai1 = nodeMap.get("oai1");
    expect(oai1?.kind).toBe("cloud");
    expect(oai1?.hasCloud).toBe(true);
    // prov1: provider, hasProvider true
    const prov1 = nodeMap.get("prov1");
    expect(prov1?.kind).toBe("provider");
    expect(prov1?.hasProvider).toBe(true);
    // no node from "other" cluster
    expect(nodeMap.has("elsewhere")).toBe(false);
  });

  test("after wet node.remove, ls no longer lists the removed node", async () => {
    const cfg = seedFixture();
    seedConfig(cfg);
    const client = await connected();
    // remove gpu1
    await client.callTool({
      name: "llamactl.node.remove",
      arguments: { name: "gpu1" },
    });
    // ls should no longer list gpu1
    const result = textOf(
      await client.callTool({
        name: "llamactl.node.ls",
      }),
    ) as unknown as LsResult;
    const names = result.nodes.map((n) => n.name);
    expect(names).not.toContain("gpu1");
    expect(names).toContain("local");
    expect(names).toContain("gw1");
  });
});
