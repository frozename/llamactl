import {
  agentConfig,
  type ClusterNode,
  type Config,
  configSchema,
  config as kubecfg,
} from "@llamactl/remote";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "../src/safe-fs.js";
import { registerMutationTools } from "../src/tools/mutations.js";

const NODE_URL = "https://10.0.0.5:7443";
const FINGERPRINT = "sha256:AB:CD";
const TOKEN = "tok-abc123";
const CERTIFICATE = "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n";

type AddResult = {
  ok?: boolean;
  error?: string;
  dryRun?: boolean;
  node?: { name: string; endpoint: string; fingerprint: string };
  message?: string;
  name?: string;
  endpoint?: string;
  fingerprint?: string;
};

let dir = "";
let envSnapshot: NodeJS.ProcessEnv = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llamactl-mcp-node-add-"));
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

function blobFor(overrides: { url?: string; certificate?: string } = {}): string {
  return agentConfig.encodeBootstrap({
    url: NODE_URL,
    fingerprint: FINGERPRINT,
    token: TOKEN,
    certificate: CERTIFICATE,
    ...overrides,
  });
}

async function connected(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerMutationTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: unknown): AddResult {
  const content = (result as { content?: { type: string; text: string }[] }).content ?? [];
  return JSON.parse(content[0]?.text ?? "") as AddResult;
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

describe("llamactl.node.add", () => {
  test("non-JSON bootstrap blob returns ok:false with the decode prefix", async () => {
    const client = await connected();
    const result = textOf(
      await client.callTool({
        name: "llamactl.node.add",
        arguments: { name: "gpu1", bootstrap: "not-a-blob!!" },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.startsWith("invalid bootstrap blob: ")).toBe(true);
  });

  test("blob without token reports bootstrap: missing token", async () => {
    const noToken = Buffer.from(
      JSON.stringify({ url: NODE_URL, fingerprint: FINGERPRINT, certificate: CERTIFICATE }),
    ).toString("base64url");
    const client = await connected();
    const result = textOf(
      await client.callTool({
        name: "llamactl.node.add",
        arguments: { name: "gpu1", bootstrap: noToken },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("bootstrap: missing token");
  });

  test("invalid bootstrap writes no kubeconfig file", async () => {
    const client = await connected();
    await client.callTool({
      name: "llamactl.node.add",
      arguments: { name: "gpu1", bootstrap: "not-a-blob!!" },
    });
    expect(existsSync(configPath())).toBe(false);
  });

  test("dry-run previews exactly name/endpoint/fingerprint", async () => {
    const client = await connected();
    const result = textOf(
      await client.callTool({
        name: "llamactl.node.add",
        arguments: { name: "gpu1", bootstrap: blobFor(), dryRun: true },
      }),
    );
    expect(result).toEqual({
      dryRun: true,
      node: { name: "gpu1", endpoint: NODE_URL, fingerprint: FINGERPRINT },
      message: `would add node gpu1 pointing at ${NODE_URL}`,
    });
  });

  test("dry-run creates no kubeconfig file", async () => {
    const client = await connected();
    await client.callTool({
      name: "llamactl.node.add",
      arguments: { name: "gpu1", bootstrap: blobFor(), dryRun: true },
    });
    expect(existsSync(configPath())).toBe(false);
  });

  test("wet run with dryRun omitted returns exactly the ok envelope", async () => {
    seedConfig();
    const client = await connected();
    const result = textOf(
      await client.callTool({
        name: "llamactl.node.add",
        arguments: { name: "gpu1", bootstrap: blobFor() },
      }),
    );
    expect(result).toEqual({
      ok: true,
      name: "gpu1",
      endpoint: NODE_URL,
      fingerprint: FINGERPRINT,
    });
  });

  test("wet run stores endpoint, fingerprint and certificate PEM on the home node", async () => {
    seedConfig();
    const client = await connected();
    await client.callTool({
      name: "llamactl.node.add",
      arguments: { name: "gpu1", bootstrap: blobFor(), dryRun: false },
    });
    const node = homeNodes(loadConfig()).find((n) => n.name === "gpu1");
    expect(node?.endpoint).toBe(NODE_URL);
    expect(node?.certificateFingerprint).toBe(FINGERPRINT);
    expect(node?.certificate).toBe(CERTIFICATE);
  });

  test("wet run rewrites the current context user's token", async () => {
    seedConfig();
    const client = await connected();
    await client.callTool({
      name: "llamactl.node.add",
      arguments: { name: "gpu1", bootstrap: blobFor(), dryRun: false },
    });
    const cfg = loadConfig();
    const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
    const user = cfg.users.find((u) => u.name === ctx?.user);
    expect(user?.token).toBe(TOKEN);
  });

  test("wet run with empty certificate stores no certificate key", async () => {
    seedConfig();
    const client = await connected();
    await client.callTool({
      name: "llamactl.node.add",
      arguments: { name: "gpu1", bootstrap: blobFor({ certificate: "" }), dryRun: false },
    });
    const node = homeNodes(loadConfig()).find((n) => n.name === "gpu1");
    expect(node).toBeDefined();
    expect("certificate" in node!).toBe(false);
  });

  test("adding the same name twice upserts to the second url", async () => {
    seedConfig();
    const client = await connected();
    await client.callTool({
      name: "llamactl.node.add",
      arguments: { name: "gpu1", bootstrap: blobFor(), dryRun: false },
    });
    await client.callTool({
      name: "llamactl.node.add",
      arguments: {
        name: "gpu1",
        bootstrap: blobFor({ url: "https://10.0.0.9:7443" }),
        dryRun: false,
      },
    });
    const matches = homeNodes(loadConfig()).filter((n) => n.name === "gpu1");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.endpoint).toBe("https://10.0.0.9:7443");
  });

  test("wet run keeps the pre-existing local node", async () => {
    seedConfig();
    const client = await connected();
    await client.callTool({
      name: "llamactl.node.add",
      arguments: { name: "gpu1", bootstrap: blobFor(), dryRun: false },
    });
    const nodes = homeNodes(loadConfig());
    expect(nodes.some((n) => n.name === "local")).toBe(true);
    expect(nodes.some((n) => n.name === "gpu1")).toBe(true);
  });

  test("unmatched currentContext refuses with no current context", async () => {
    seedConfig({ ...configSchema.freshConfig(), currentContext: "missing" });
    const client = await connected();
    const result = textOf(
      await client.callTool({
        name: "llamactl.node.add",
        arguments: { name: "gpu1", bootstrap: blobFor(), dryRun: false },
      }),
    );
    expect(result).toEqual({ ok: false, error: "no current context in kubeconfig" });
  });

  test("refused wet run leaves the kubeconfig byte-for-byte unchanged", async () => {
    seedConfig({ ...configSchema.freshConfig(), currentContext: "missing" });
    const before = readFileSync(configPath());
    const client = await connected();
    await client.callTool({
      name: "llamactl.node.add",
      arguments: { name: "gpu1", bootstrap: blobFor(), dryRun: false },
    });
    const after = readFileSync(configPath());
    expect(after.equals(before)).toBe(true);
  });

  test("wet run audits name+dryRun only and never the token", async () => {
    seedConfig();
    const client = await connected();
    await client.callTool({
      name: "llamactl.node.add",
      arguments: { name: "gpu1", bootstrap: blobFor(), dryRun: false },
    });
    const files = readdirSync(auditDir()).filter((f) => f.startsWith("llamactl-"));
    const text = files.map((f) => readFileSync(join(auditDir(), f), "utf8")).join("\n");
    const lines = text
      .split("\n")
      .flatMap((line) => (line ? [JSON.parse(line) as Record<string, unknown>] : []));
    const audit = lines.find((entry) => entry["tool"] === "llamactl.node.add");
    expect(audit).toBeDefined();
    expect(audit!["input"]).toEqual({ name: "gpu1", dryRun: false });
    expect(text).not.toContain("tok-abc123");
  });
});
