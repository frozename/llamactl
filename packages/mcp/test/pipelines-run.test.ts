import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

// Mutable slots — each test sets these before calling the tool.
let _responses: string[] = [];
let _callIdx = 0;

// mock.module must be called before the dynamic import of pipelines.ts below.
void mock.module("@llamactl/remote", () => ({
  router: {
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    createCaller: () => ({
      // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
      chatComplete: () => {
        const content = _responses[_callIdx] ?? "";
        _callIdx++;
        return Promise.resolve({ choices: [{ message: { content } }] });
      },
    }),
  },
}));

// Dynamic import so the mock above is in place when pipelines.ts loads
// @llamactl/remote.
const { registerPipelineTools } = await import("../src/pipelines.js");

function makePipeline(stageCount: number): object {
  return {
    apiVersion: "llamactl/v1",
    kind: "PipelineTool",
    name: "pipe",
    title: "Pipe",
    description: "",
    inputSchema: { type: "object", properties: {}, required: [] },
    stages: Array.from({ length: stageCount }, (_, i) => ({
      node: "local",
      model: `m${String(i)}`,
      systemPrompt: "",
      capabilities: [],
    })),
  };
}

async function connectServer(pipelinesDir: string): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerPipelineTools(server, { pipelinesDir });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "tc", version: "0.0.0" });
  await client.connect(ct);
  return client;
}

function textOf(result: unknown): string {
  const c = (result as { content?: { type: string; text: string }[] }).content ?? [];
  return c[0]?.text ?? "";
}

describe("runPipeline — empty stage output detection", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llamactl-pipeline-run-"));
    _responses = [];
    _callIdx = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("single stage returning empty content → ok:false (not silent ok:true with empty finalOutput)", async () => {
    _responses = [""]; // stage 0 returns empty
    writeFileSync(join(dir, "p.json"), JSON.stringify(makePipeline(1)), "utf8");
    const client = await connectServer(dir);

    const raw = await client.callTool({ name: "pipe", arguments: { input: "hello" } });
    const r = JSON.parse(textOf(raw)) as { ok: boolean; finalOutput?: string; error?: string };

    expect(r.ok).toBe(false);
    // Error must identify the failing stage index.
    expect(r.error).toMatch(/stage 0/);
  });

  test("stage 1 of 2 returning empty content → ok:false identifying stage 1", async () => {
    _responses = ["good output", ""]; // stage 0 ok, stage 1 empty
    writeFileSync(join(dir, "p.json"), JSON.stringify(makePipeline(2)), "utf8");
    const client = await connectServer(dir);

    const raw = await client.callTool({ name: "pipe", arguments: { input: "hello" } });
    const r = JSON.parse(textOf(raw)) as { ok: boolean; error?: string };

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stage 1/);
  });

  test("all stages with non-empty content → ok:true with correct finalOutput", async () => {
    _responses = ["first", "second"];
    writeFileSync(join(dir, "p.json"), JSON.stringify(makePipeline(2)), "utf8");
    const client = await connectServer(dir);

    const raw = await client.callTool({ name: "pipe", arguments: { input: "hello" } });
    const r = JSON.parse(textOf(raw)) as { ok: boolean; finalOutput?: string };

    expect(r.ok).toBe(true);
    expect(r.finalOutput).toBe("second");
  });
});
