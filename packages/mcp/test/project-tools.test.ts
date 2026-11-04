import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "../../remote/src/config/projects.js";

import { loadProjects, saveProjects } from "../../remote/src/config/projects.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "../src/safe-fs.js";
import { registerProjectTools } from "../src/tools/projects.js";

/**
 * Pins for the project tool surface (issue #335): the dry-run
 * short-circuits, the audit redaction (manifest bodies never enter
 * the JSONL journal), and the routing fallback lane. project.get on a
 * missing name is intentionally unpinned — the description says null,
 * the implementation errors; that is an open product decision.
 */

const originalEnv = { ...process.env };

let tmpDir = "";

const projectsPath = (): string => join(tmpDir, "projects.yaml");
const ragPipelinesDir = (): string => join(tmpDir, "rag-pipelines");
const auditDir = (): string => join(tmpDir, "audit");

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "llamactl-project-tools-"));
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: tmpDir,
    LLAMACTL_PROJECTS_FILE: projectsPath(),
    LLAMACTL_RAG_PIPELINES_DIR: ragPipelinesDir(),
    LLAMACTL_MCP_AUDIT_DIR: auditDir(),
    LLAMACTL_CONFIG: join(tmpDir, "config"),
  });
});

afterEach(() => {
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  rmSync(tmpDir, { recursive: true, force: true });
});

async function connected(): Promise<Client> {
  const server = new McpServer({ name: "test-projects", version: "0.0.0" });
  registerProjectTools(server);
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

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
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

function makeProject(name: string, routing: Record<string, string> = {}): Project {
  return {
    apiVersion: "llamactl/v1",
    kind: "Project",
    metadata: { name },
    spec: { path: `/projects/${name}`, stack: [], routing },
  };
}

function seedProjects(...projects: Project[]): void {
  saveProjects(projects, projectsPath());
}

const MANIFEST = [
  "apiVersion: llamactl/v1",
  "kind: Project",
  "metadata:",
  "  name: novaflow",
  "spec:",
  "  path: /Users/me/code/novaflow",
  "  stack: [nestjs]",
  "  routing:",
  "    code: mac-mini.claude-pro",
  "",
].join("\n");

describe("llamactl.project.apply", () => {
  test("dry-run writes nothing", async () => {
    const client = await connected();
    await client.callTool({
      name: "llamactl.project.apply",
      arguments: { manifestYaml: MANIFEST, dryRun: true },
    });
    expect(existsSync(projectsPath())).toBe(false);
  });

  test("dry-run returns exactly the byte preview", async () => {
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.project.apply",
      arguments: { manifestYaml: MANIFEST, dryRun: true },
    });
    expect(textOf(result)).toEqual({ dryRun: true, wouldApply: { bytes: MANIFEST.length } });
  });

  test("dry-run never parses the manifest body", async () => {
    const malformed = ": : :\n\t-";
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.project.apply",
      arguments: { manifestYaml: malformed, dryRun: true },
    });
    expect(isError(result)).toBe(false);
    expect(textOf(result)).toEqual({ dryRun: true, wouldApply: { bytes: malformed.length } });
  });

  test("dry-run audit redacts the manifest body", async () => {
    const client = await connected();
    await client.callTool({
      name: "llamactl.project.apply",
      arguments: { manifestYaml: MANIFEST, dryRun: true },
    });
    const lines = auditLines();
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line["tool"]).toBe("llamactl.project.apply");
    expect(line["dryRun"]).toBe(true);
    const input = line["input"] as Record<string, unknown>;
    expect(input).toEqual({ dryRun: true, bytes: MANIFEST.length });
    expect("manifestYaml" in input).toBe(false);
  });

  test("wet run with dryRun omitted persists the project and audits without the body", async () => {
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.project.apply",
      arguments: { manifestYaml: MANIFEST },
    });
    const parsed = textOf(result);
    expect(parsed["ok"]).toBe(true);
    expect(parsed["name"]).toBe("novaflow");
    expect(parsed["created"]).toBe(true);
    expect(existsSync(projectsPath())).toBe(true);
    expect(loadProjects(projectsPath()).map((p) => p.metadata.name)).toEqual(["novaflow"]);
    const lines = auditLines();
    expect(lines).toHaveLength(1);
    const input = lines[0]!["input"] as Record<string, unknown>;
    expect(input).toEqual({ dryRun: false, bytes: MANIFEST.length });
    expect("manifestYaml" in input).toBe(false);
  });
});

describe("llamactl.project.list", () => {
  test("audit result is a count summary", async () => {
    seedProjects(makeProject("alpha"), makeProject("beta"));
    const client = await connected();
    const result = await client.callTool({ name: "llamactl.project.list", arguments: {} });
    expect(isError(result)).toBe(false);
    const lines = auditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!["result"]).toEqual({ count: 2 });
  });
});

describe("llamactl.project.get", () => {
  test("returns the seeded project; audit result carries only ok", async () => {
    seedProjects(makeProject("alpha"));
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.project.get",
      arguments: { name: "alpha" },
    });
    const parsed = textOf(result);
    expect(parsed["ok"]).toBe(true);
    expect((parsed["project"] as { metadata: { name: string } }).metadata.name).toBe("alpha");
    const lines = auditLines();
    expect(lines).toHaveLength(1);
    const audited = lines[0]!["result"] as Record<string, unknown>;
    expect(audited).toEqual({ ok: true });
    expect("project" in audited).toBe(false);
  });
});

describe("llamactl.project.remove", () => {
  test("dry-run previews without removing", async () => {
    seedProjects(makeProject("alpha"));
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.project.remove",
      arguments: { name: "alpha", dryRun: true },
    });
    expect(textOf(result)).toEqual({ dryRun: true, wouldRemove: { name: "alpha" } });
    expect(loadProjects(projectsPath()).map((p) => p.metadata.name)).toEqual(["alpha"]);
  });

  test("wet run with dryRun omitted is destructive by default", async () => {
    seedProjects(makeProject("alpha"));
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.project.remove",
      arguments: { name: "alpha" },
    });
    const parsed = textOf(result);
    expect(parsed["ok"]).toBe(true);
    expect(parsed["removed"]).toBe(true);
    expect(loadProjects(projectsPath()).map((p) => p.metadata.name)).toEqual([]);
  });
});

describe("llamactl.project.index", () => {
  test("dry-run previews the pipeline name for an unregistered project and creates nothing", async () => {
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.project.index",
      arguments: { name: "ghost", dryRun: true },
    });
    expect(textOf(result)).toEqual({
      dryRun: true,
      wouldIndex: { project: "ghost", pipelineName: "project-ghost" },
    });
    expect(existsSync(ragPipelinesDir()) ? readdirSync(ragPipelinesDir()) : []).toEqual([]);
  });

  test("wet run on a project without spec.rag fails with has-no-spec.rag", async () => {
    seedProjects(makeProject("norag"));
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.project.index",
      arguments: { name: "norag" },
    });
    expect(isError(result)).toBe(true);
    expect(rawText(result)).toMatch(/has no spec\.rag/);
  });
});

describe("llamactl.project.resolveRouting", () => {
  test("declared task kind resolves to its configured target", async () => {
    seedProjects(makeProject("router", { code: "mac-mini.claude-pro" }));
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.project.resolveRouting",
      arguments: { project: "router", taskKind: "code" },
    });
    const parsed = textOf(result);
    expect(parsed["target"]).toBe("mac-mini.claude-pro");
    expect(parsed["matched"]).toBe(true);
    expect(parsed["reason"]).toBe("matched");
  });

  test("undeclared task kind falls back to private-first", async () => {
    seedProjects(makeProject("router", { code: "mac-mini.claude-pro" }));
    const client = await connected();
    const result = await client.callTool({
      name: "llamactl.project.resolveRouting",
      arguments: { project: "router", taskKind: "embed" },
    });
    const parsed = textOf(result);
    expect(parsed["target"]).toBe("private-first");
    expect(parsed["matched"]).toBe(false);
    expect(parsed["reason"]).toBe("fallback-default");
  });
});
