import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmbersynthConfig } from "../../remote/src/config/embersynth.js";

import {
  DEFAULT_EMBERSYNTH_PROFILES,
  EmbersynthConfigSchema,
  loadEmbersynthConfig,
  saveEmbersynthConfig,
} from "../../remote/src/config/embersynth.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "../src/safe-fs.js";
import { registerEmbersynthTools } from "../src/tools/embersynth.js";

/**
 * Pins for the embersynth tool surface (issue #335): the dry-run
 * notes (unchanged vs. not modified), the audit trail for both
 * dry-run and wet-run of `set-default-profile`, and the
 * config-missing + unknown-profile error paths.  Also pins the
 * sync tool's dry-run when no prior file exists.
 */

const originalEnv = { ...process.env };

let tmpDir = "";

const configPath = (): string => join(tmpDir, "embersynth.yaml");
const auditDir = (): string => join(tmpDir, "audit");

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "llamactl-embersynth-tools-"));
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: tmpDir,
    LLAMACTL_EMBERSYNTH_CONFIG: configPath(),
    LLAMACTL_MCP_AUDIT_DIR: auditDir(),
  });
});

afterEach(() => {
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  rmSync(tmpDir, { recursive: true, force: true });
});

async function connected(): Promise<Client> {
  const server = new McpServer({ name: "test-embersynth", version: "0.0.0" });
  registerEmbersynthTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function rawText(result: unknown): string {
  const content = (result as { content?: { type: string; text: string }[] }).content ?? [];
  return content[0]?.text ?? "";
}

function textOf(result: unknown): Record<string, unknown> {
  return JSON.parse(rawText(result)) as Record<string, unknown>;
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

function seedConfig(): void {
  const seed: EmbersynthConfig = EmbersynthConfigSchema.parse({
    nodes: [
      {
        id: "agent-local",
        label: "local agent",
        endpoint: "http://127.0.0.1:8080/v1",
        capabilities: ["reasoning"],
        tags: ["llamactl", "agent", "local", "private"],
        providerType: "openai-compatible",
        priority: 2,
        auth: { type: "none" },
      },
    ],
    profiles: DEFAULT_EMBERSYNTH_PROFILES,
    syntheticModels: Object.fromEntries(
      DEFAULT_EMBERSYNTH_PROFILES.map((p) => [`fusion-${p.id}`, p.id]),
    ),
  });
  saveEmbersynthConfig(seed, configPath());
}

function seededConfig(): EmbersynthConfig {
  const cfg = loadEmbersynthConfig(configPath());
  if (!cfg) throw new Error("expected seeded config");
  return cfg;
}

describe("llamactl.embersynth.sync", () => {
  test("dry-run returns would-be profiles/syntheticModels when config is absent", async () => {
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.embersynth.sync",
      arguments: { path: configPath(), dryRun: true },
    });
    const parsed = textOf(result);
    expect(parsed["dryRun"]).toBe(true);
    expect(Array.isArray(parsed["profiles"])).toBe(true);
    expect((parsed["profiles"] as string[]).length).toBeGreaterThan(0);
    expect(Array.isArray(parsed["syntheticModels"])).toBe(true);
    expect((parsed["syntheticModels"] as string[]).length).toBeGreaterThan(0);
    // Config file was NOT written.
    expect(existsSync(configPath())).toBe(false);
  });

  test("dry-run returns would-be profiles/syntheticModels when config exists", async () => {
    seedConfig();
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.embersynth.sync",
      arguments: { path: configPath(), dryRun: true },
    });
    const parsed = textOf(result);
    expect(parsed["dryRun"]).toBe(true);
    expect(Array.isArray(parsed["profiles"])).toBe(true);
    expect(Array.isArray(parsed["syntheticModels"])).toBe(true);
    // Existing file is untouched.
    const before = readFileSync(configPath(), "utf8");
    expect(before).toContain("private-first");
  });
});

describe("llamactl.embersynth.set-default-profile", () => {
  test("dry-run reports previous + next + unchanged when synthetic model maps to target", async () => {
    seedConfig();
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.embersynth.set-default-profile",
      arguments: {
        profile: "private-first",
        syntheticModel: "fusion-private-first",
        path: configPath(),
      },
    });
    const parsed = textOf(result);
    expect(parsed["ok"]).toBe(true);
    expect(parsed["mode"]).toBe("dry-run");
    expect(parsed["previous"]).toBe("private-first");
    expect(parsed["next"]).toBe("private-first");
    expect(parsed["unchanged"]).toBe(true);
    // Config file was NOT written.
    expect(readFileSync(configPath(), "utf8")).toMatch(/fusion-private-first:\s*private-first/);
  });

  test("dry-run notes unchanged when synthetic model already maps to target", async () => {
    seedConfig();
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.embersynth.set-default-profile",
      arguments: {
        profile: "private-first",
        syntheticModel: "fusion-private-first",
        path: configPath(),
      },
    });
    const parsed = textOf(result);
    expect(parsed["ok"]).toBe(true);
    expect((parsed["note"] as string).toLowerCase()).toContain("already routes");
  });

  test("dry-run notes not modified when synthetic model maps to a different profile", async () => {
    seedConfig();
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.embersynth.set-default-profile",
      arguments: { profile: "private-first", syntheticModel: "fusion-auto", path: configPath() },
    });
    const parsed = textOf(result);
    expect(parsed["ok"]).toBe(true);
    expect(parsed["previous"]).toBe("auto");
    expect(parsed["next"]).toBe("private-first");
    expect(parsed["unchanged"]).toBe(false);
    expect((parsed["note"] as string).toLowerCase()).toContain("not modified");
  });

  test("dry-run audit captures the call with unchanged + previous + next", async () => {
    seedConfig();
    const client = await connected();
    await client.callTool({
      name: "llamactl.embersynth.set-default-profile",
      arguments: {
        profile: "private-first",
        syntheticModel: "fusion-private-first",
        path: configPath(),
      },
    });
    const lines = auditLines();
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line["tool"]).toBe("llamactl.embersynth.set-default-profile");
    expect(line["dryRun"]).toBe(true);
    const result = line["result"] as Record<string, unknown>;
    expect(result["previous"]).toBe("private-first");
    expect(result["next"]).toBe("private-first");
    expect(result["unchanged"]).toBe(true);
  });

  test("wet-run audit captures the call with previous + next", async () => {
    seedConfig();
    const client = await connected();
    await client.callTool({
      name: "llamactl.embersynth.set-default-profile",
      arguments: {
        profile: "private-first",
        syntheticModel: "fusion-private-first",
        path: configPath(),
        dryRun: false,
      },
    });
    const lines = auditLines();
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line["tool"]).toBe("llamactl.embersynth.set-default-profile");
    expect(line["dryRun"]).toBe(false);
    const result = line["result"] as Record<string, unknown>;
    expect(result["previous"]).toBe("private-first");
    expect(result["next"]).toBe("private-first");
    expect("unchanged" in result).toBe(false);
  });

  test("wet-run preserves existing syntheticModels keys not touched by the call", async () => {
    seedConfig();
    const client = await connected();
    const before = seededConfig();
    const priorKeys = Object.keys(before.syntheticModels);
    expect(priorKeys).toContain("fusion-auto");
    expect(priorKeys).toContain("fusion-private-first");
    await client.callTool({
      name: "llamactl.embersynth.set-default-profile",
      arguments: {
        profile: "private-first",
        syntheticModel: "fusion-private-first",
        path: configPath(),
        dryRun: false,
      },
    });
    const after = seededConfig();
    const afterKeys = Object.keys(after.syntheticModels);
    // fusion-auto should still be present (untouched).
    expect(afterKeys).toContain("fusion-auto");
    expect(afterKeys).toContain("fusion-private-first");
  });

  test("wet-run returns the old + new mapping in the response", async () => {
    seedConfig();
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.embersynth.set-default-profile",
      arguments: {
        profile: "private-first",
        syntheticModel: "fusion-auto",
        path: configPath(),
        dryRun: false,
      },
    });
    const parsed = textOf(result);
    expect(parsed["ok"]).toBe(true);
    expect(parsed["mode"]).toBe("wet");
    expect(parsed["previous"]).toBe("auto");
    expect(parsed["next"]).toBe("private-first");
  });

  test("wet-run rewrites the file and the mapping persists on reload", async () => {
    seedConfig();
    const client = await connected();
    await client.callTool({
      name: "llamactl.embersynth.set-default-profile",
      arguments: {
        profile: "private-first",
        syntheticModel: "fusion-auto",
        path: configPath(),
        dryRun: false,
      },
    });
    const body = readFileSync(configPath(), "utf8");
    expect(body).toMatch(/fusion-auto:\s*private-first/);
  });

  test("missing config returns config-missing", async () => {
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.embersynth.set-default-profile",
      arguments: { profile: "private-first", path: "/does/not/exist.yaml" },
    });
    const parsed = textOf(result);
    expect(parsed["ok"]).toBe(false);
    expect(parsed["reason"]).toBe("config-missing");
  });

  test("unknown profile returns rejected with availableProfiles", async () => {
    seedConfig();
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.embersynth.set-default-profile",
      arguments: { profile: "does-not-exist", path: configPath() },
    });
    const parsed = textOf(result);
    expect(parsed["ok"]).toBe(false);
    expect(parsed["reason"]).toBe("unknown-profile");
    expect(Array.isArray(parsed["availableProfiles"])).toBe(true);
    expect((parsed["availableProfiles"] as string[]).length).toBeGreaterThan(0);
  });
});
