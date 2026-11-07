import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverPipelineTools, registerPipelineTools } from "../src/pipelines.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

function validPipeline(name: string, overrides?: Record<string, unknown>): object {
  return {
    apiVersion: "llamactl/v1",
    kind: "PipelineTool",
    name,
    title: `T ${name}`,
    inputSchema: { type: "object" },
    stages: [{ node: "local", model: "m0" }],
    ...overrides,
  };
}

let tmp: string;
let envSnapshot: string | undefined;
let dirsToClean: string[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-pipeline-discover-"));
  dirsToClean = [tmp];
  envSnapshot = process.env["LLAMACTL_MCP_PIPELINES_DIR"];
});

afterEach(() => {
  for (const d of dirsToClean) {
    rmSync(d, { recursive: true, force: true });
  }
  dirsToClean = [];
  if (envSnapshot === undefined) {
    delete process.env["LLAMACTL_MCP_PIPELINES_DIR"];
  } else {
    process.env["LLAMACTL_MCP_PIPELINES_DIR"] = envSnapshot;
  }
});

function namesFrom(tools: object[]): string[] {
  return tools.map((t) => (t as { name: string }).name).sort();
}

function stagesFrom(tools: object[]): object[][] {
  return tools.map((t) => (t as { stages: object[] }).stages);
}

function descriptionFrom(tools: object[]): string[] {
  return tools.map((t) => (t as { description: string }).description);
}

function schemaFrom(tools: object[]): object[] {
  return tools.map((t) => (t as { inputSchema: object }).inputSchema);
}

describe("discoverPipelineTools", () => {
  test("non-existent dir returns [] with no warnings", () => {
    const warnings: string[] = [];
    const result = discoverPipelineTools({
      pipelinesDir: join(tmp, "missing"),
      onWarn: (msg) => warnings.push(msg),
    });
    expect(result).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("path that exists but is a regular file returns []", () => {
    writeFileSync(join(tmp, "f.json"), "{}");
    const warnings: string[] = [];
    const result = discoverPipelineTools({
      pipelinesDir: join(tmp, "f.json"),
      onWarn: (msg) => warnings.push(msg),
    });
    expect(result).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("only *.json files are read", () => {
    writeFileSync(join(tmp, "a.json"), JSON.stringify(validPipeline("a")));
    writeFileSync(join(tmp, "b.json.bak"), JSON.stringify(validPipeline("b")));
    writeFileSync(join(tmp, "c.txt"), JSON.stringify(validPipeline("c")));

    const result = discoverPipelineTools({ pipelinesDir: tmp });
    expect(namesFrom(result)).toEqual(["a"]);
  });

  test("defaults applied by the schema", () => {
    writeFileSync(join(tmp, "defaults.json"), JSON.stringify(validPipeline("defaults")));

    const result = discoverPipelineTools({ pipelinesDir: tmp });
    expect(result).toHaveLength(1);
    const tool = result[0] as Record<string, unknown>;
    expect(tool["description"]).toEqual("");
    expect(tool["inputSchema"]).toEqual({
      type: "object",
      properties: {},
      required: [],
    });
    expect(stagesFrom(result)).toEqual([
      [
        {
          node: "local",
          model: "m0",
          systemPrompt: "",
          capabilities: [],
        },
      ],
    ]);
    expect((tool as { apiVersion: string }).apiVersion).toEqual("llamactl/v1");
    expect((tool as { kind: string }).kind).toEqual("PipelineTool");
    expect((tool as { name: string }).name).toEqual("defaults");
    expect((tool as { title: string }).title).toEqual("T defaults");
  });

  test("invalid JSON is skipped with one warning", () => {
    writeFileSync(join(tmp, "bad.json"), "{not json");
    writeFileSync(join(tmp, "ok.json"), JSON.stringify(validPipeline("ok")));

    const warnings: string[] = [];
    const result = discoverPipelineTools({
      pipelinesDir: tmp,
      onWarn: (msg) => warnings.push(msg),
    });
    expect(namesFrom(result)).toEqual(["ok"]);
    expect(warnings).toHaveLength(1);
    const prefix = `pipeline-tool: skipped ${join(tmp, "bad.json")} — invalid JSON: `;
    const w = warnings[0]!;
    expect(w.startsWith(prefix)).toBe(true);
  });

  test("schema failure is skipped with one warning", () => {
    writeFileSync(
      join(tmp, "wrong.json"),
      JSON.stringify(validPipeline("wrong", { kind: "Other" })),
    );

    const warnings: string[] = [];
    const result = discoverPipelineTools({
      pipelinesDir: tmp,
      onWarn: (msg) => warnings.push(msg),
    });
    expect(result).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("pipeline-tool: skipped");
    expect(warnings[0]).not.toContain("invalid JSON");

    // Separate test: stages: [] is also rejected
    const tmp2 = mkdtempSync(join(tmpdir(), "llamactl-pipeline-discover-nostages-"));
    dirsToClean.push(tmp2);
    writeFileSync(
      join(tmp2, "nostages.json"),
      JSON.stringify(validPipeline("nostages", { stages: [] })),
    );

    const warnings2: string[] = [];
    const result2 = discoverPipelineTools({
      pipelinesDir: tmp2,
      onWarn: (msg) => warnings2.push(msg),
    });
    expect(result2).toEqual([]);
    expect(warnings2).toHaveLength(1);
    expect(warnings2[0]).toContain("pipeline-tool: skipped");
    expect(warnings2[0]).not.toContain("invalid JSON");
  });

  test("env override: LLAMACTL_MCP_PIPELINES_DIR", () => {
    const envDir = mkdtempSync(join(tmpdir(), "llamactl-pipeline-discover-env-"));
    dirsToClean.push(envDir);
    writeFileSync(join(envDir, "envpipe.json"), JSON.stringify(validPipeline("envpipe")));

    process.env["LLAMACTL_MCP_PIPELINES_DIR"] = envDir;
    const result = discoverPipelineTools();
    expect(namesFrom(result)).toEqual(["envpipe"]);
  });

  test("explicit pipelinesDir wins over env", () => {
    const envDir = mkdtempSync(join(tmpdir(), "llamactl-pipeline-discover-env2-"));
    dirsToClean.push(envDir);
    writeFileSync(join(envDir, "fromenv.json"), JSON.stringify(validPipeline("fromenv")));

    process.env["LLAMACTL_MCP_PIPELINES_DIR"] = envDir;
    const result = discoverPipelineTools({ pipelinesDir: tmp });
    writeFileSync(join(tmp, "explicit.json"), JSON.stringify(validPipeline("explicit")));
    expect(namesFrom(discoverPipelineTools({ pipelinesDir: tmp }))).toEqual(["explicit"]);
  });
});

describe("registerPipelineTools listing", () => {
  test("1-stage and 2-stage defaults + custom description", async () => {
    const one = validPipeline("one", {
      stages: [{ node: "local", model: "m0" }],
    });
    const two = validPipeline("two", {
      stages: [
        { node: "local", model: "m0" },
        { node: "local", model: "m1" },
      ],
    });
    const custom = validPipeline("custom", {
      description: "custom",
      stages: [{ node: "local", model: "m0" }],
    });

    writeFileSync(join(tmp, "one.json"), JSON.stringify(one));
    writeFileSync(join(tmp, "two.json"), JSON.stringify(two));
    writeFileSync(join(tmp, "custom.json"), JSON.stringify(custom));

    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerPipelineTools(server, { pipelinesDir: tmp });

    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });

    await server.connect(st);
    await client.connect(ct);

    try {
      const tools = await client.listTools();
      const byName: Record<string, (typeof tools.tools)[number]> = Object.fromEntries(
        tools.tools.map((t) => [t.name, t]),
      );

      expect(byName["one"]!.description).toEqual("Multi-stage pipeline with 1 stage.");
      expect(byName["one"]!.title).toEqual("T one");

      expect(byName["two"]!.description).toEqual("Multi-stage pipeline with 2 stages.");

      expect(byName["custom"]!.description).toEqual("custom");

      expect(byName["one"]!.inputSchema.properties).toHaveProperty("input");
      expect(
        (byName["one"]!.inputSchema.properties as { input: { type: string } }).input.type,
      ).toEqual("string");
      expect(byName["one"]!.inputSchema.required).toEqual(["input"]);

      expect(byName["two"]!.inputSchema.required).toEqual(["input"]);

      expect(byName["custom"]!.inputSchema.required).toEqual(["input"]);
    } finally {
      await client.close();
    }
  });

  test("registerPipelineTools returns sorted names", () => {
    const a = validPipeline("alpha");
    const b = validPipeline("beta");

    writeFileSync(join(tmp, "a.json"), JSON.stringify(a));
    writeFileSync(join(tmp, "b.json"), JSON.stringify(b));

    const server = new McpServer({ name: "test", version: "0.0.0" });
    const registered = registerPipelineTools(server, { pipelinesDir: tmp });
    expect(registered.sort()).toEqual(["alpha", "beta"]);
  });
});
