import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerPipelineTools } from "../src/pipelines.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

function makePipeline(name: string): object {
  return {
    apiVersion: "llamactl/v1",
    kind: "PipelineTool",
    name,
    title: `Title ${name}`,
    description: "test pipeline",
    inputSchema: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
    stages: [{ node: "local", model: "m1", systemPrompt: "", capabilities: [] }],
  };
}

let tmpDir = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "llamactl-pipeline-collision-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("registerPipelineTools — collision resilience", () => {
  test("duplicate pipeline name does not throw — second is skipped with a warning", () => {
    writeFileSync(join(tmpDir, "a.json"), JSON.stringify(makePipeline("my-pipeline")), "utf8");
    writeFileSync(join(tmpDir, "b.json"), JSON.stringify(makePipeline("my-pipeline")), "utf8");

    const server = new McpServer({ name: "test", version: "0.0.0" });
    const warnings: string[] = [];

    expect(() => {
      registerPipelineTools(server, {
        pipelinesDir: tmpDir,
        onWarn: (msg) => warnings.push(msg),
      });
    }).not.toThrow();

    expect(warnings.length).toBeGreaterThan(0);
  });

  test("collision with a pre-registered built-in does not throw", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    server.registerTool("my-pipeline", { description: "built-in" }, () =>
      Promise.resolve({ content: [] }),
    );

    writeFileSync(join(tmpDir, "a.json"), JSON.stringify(makePipeline("my-pipeline")), "utf8");

    const warnings: string[] = [];

    expect(() => {
      registerPipelineTools(server, {
        pipelinesDir: tmpDir,
        onWarn: (msg) => warnings.push(msg),
      });
    }).not.toThrow();

    expect(warnings.length).toBeGreaterThan(0);
  });

  test("non-colliding tools still register when a collision is skipped", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "a.json"), JSON.stringify(makePipeline("dup-pipeline")), "utf8");
    writeFileSync(join(tmpDir, "b.json"), JSON.stringify(makePipeline("dup-pipeline")), "utf8");
    writeFileSync(join(tmpDir, "c.json"), JSON.stringify(makePipeline("unique-pipeline")), "utf8");

    const server = new McpServer({ name: "test", version: "0.0.0" });
    const warnings: string[] = [];

    const registered = registerPipelineTools(server, {
      pipelinesDir: tmpDir,
      onWarn: (msg) => warnings.push(msg),
    });

    expect(registered).toContain("unique-pipeline");
    expect(registered).toContain("dup-pipeline");
    // Only 1 warning — the second dup-pipeline file is skipped.
    expect(warnings).toHaveLength(1);
    // The collision warning names the tool.
    expect(warnings[0]).toContain("dup-pipeline");
  });
});
