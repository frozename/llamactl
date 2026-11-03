import { type LeaderboardRow, upsertRow } from "@llamactl/eval";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "../src/safe-fs.js";
import { registerModelsLeaderboardTool } from "../src/tools/models-leaderboard.js";

const asof = "2026-07-01T00:00:00Z";

const leaderboardRows: LeaderboardRow[] = [
  {
    model: "gemma4-26b-a4b",
    node: "mac-mini",
    ub: 512,
    throughput_tps: 45,
    ttft_ms: 120,
    tool_call_score: 0.82,
    context_8k_score: 0.78,
    context_16k_score: null,
    json_score: 0.91,
    composite: 0.85,
    asof,
  },
  {
    model: "qwen3-35b-mtp",
    node: "macbook-pro",
    ub: 256,
    throughput_tps: 60,
    ttft_ms: 80,
    tool_call_score: 0.91,
    context_8k_score: 0.85,
    context_16k_score: 0.72,
    json_score: 0.88,
    composite: 0.92,
    asof,
  },
  {
    model: "granite4-3b",
    node: "mac-mini",
    ub: 256,
    throughput_tps: 120,
    ttft_ms: 30,
    tool_call_score: 0.95,
    context_8k_score: 0.93,
    context_16k_score: 0.88,
    json_score: 0.94,
    composite: 0.78,
    asof,
  },
];

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text: string }[] }).content ?? [];
  return content[0]?.text ?? "";
}

async function connected(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function seedDb(rows: LeaderboardRow[], asof: string, devStorage: string): void {
  const evalDir = join(devStorage, "eval");
  mkdirSync(evalDir, { recursive: true });
  const dbPath = join(evalDir, "leaderboard.sqlite");
  const db = new Database(dbPath);
  for (const row of rows) {
    upsertRow(db, { ...row, asof });
  }
  db.close();
}

// Seed a per-test temp dir with DEV_STORAGE pointing to it.
function setupTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-ml-"));
  process.env["DEV_STORAGE"] = dir;
  return dir;
}

function cleanupTestDir(dir: string): void {
  delete process.env["DEV_STORAGE"];
  rmSync(dir, { recursive: true, force: true });
}

describe("models-leaderboard: empty store returns []", () => {
  test("no eval/leaderboard.sqlite → empty array, not isError, file not created", async () => {
    const dir = setupTestDir();
    try {
      const server = new McpServer({ name: "test", version: "0.0.0" });
      registerModelsLeaderboardTool(server);
      const client = await connected(server);

      const result = await client.callTool({
        name: "llamactl.models.leaderboard",
        arguments: {},
      });

      const parsed = JSON.parse(textOf(result)) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toEqual([]);

      const dbPath = join(process.env["DEV_STORAGE"]!, "eval", "leaderboard.sqlite");
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      cleanupTestDir(dir);
    }
  });
});

describe("models-leaderboard: seeded rows", () => {
  test("no arguments returns all rows ordered by composite DESC", async () => {
    const dir = setupTestDir();
    try {
      seedDb(leaderboardRows, asof, process.env["DEV_STORAGE"]!);

      const server = new McpServer({ name: "test", version: "0.0.0" });
      registerModelsLeaderboardTool(server);
      const client = await connected(server);

      const result = await client.callTool({
        name: "llamactl.models.leaderboard",
        arguments: {},
      });

      const parsed = JSON.parse(textOf(result)) as LeaderboardRow[];
      expect(parsed.length).toBe(3);
      expect(parsed[0]!.model).toBe("qwen3-35b-mtp");
      expect(parsed[1]!.model).toBe("gemma4-26b-a4b");
      expect(parsed[2]!.model).toBe("granite4-3b");
    } finally {
      cleanupTestDir(dir);
    }
  });
});

describe("models-leaderboard: node filter", () => {
  test("node returns only that node's rows", async () => {
    const dir = setupTestDir();
    try {
      seedDb(leaderboardRows, asof, dir);

      const server = new McpServer({ name: "test", version: "0.0.0" });
      registerModelsLeaderboardTool(server);
      const client = await connected(server);

      const result = await client.callTool({
        name: "llamactl.models.leaderboard",
        arguments: { node: "mac-mini" },
      });

      const parsed = JSON.parse(textOf(result)) as LeaderboardRow[];
      expect(parsed.length).toBe(2);
      expect(parsed.every((r) => r.node === "mac-mini")).toBe(true);
    } finally {
      cleanupTestDir(dir);
    }
  });
});

describe("models-leaderboard: threshold filters", () => {
  test("min_throughput drops rows below threshold (boundary included)", async () => {
    const dir = setupTestDir();
    try {
      seedDb(leaderboardRows, asof, dir);

      const server = new McpServer({ name: "test", version: "0.0.0" });
      registerModelsLeaderboardTool(server);
      const client = await connected(server);

      const result = await client.callTool({
        name: "llamactl.models.leaderboard",
        arguments: { min_throughput: 60 },
      });

      const parsed = JSON.parse(textOf(result)) as LeaderboardRow[];
      expect(parsed.length).toBe(2);
      expect(parsed.every((r) => r.throughput_tps >= 60)).toBe(true);
    } finally {
      cleanupTestDir(dir);
    }
  });

  test("min_tool_call_score drops rows below threshold (boundary included)", async () => {
    const dir = setupTestDir();
    try {
      seedDb(leaderboardRows, asof, dir);

      const server = new McpServer({ name: "test", version: "0.0.0" });
      registerModelsLeaderboardTool(server);
      const client = await connected(server);

      const result = await client.callTool({
        name: "llamactl.models.leaderboard",
        arguments: { min_tool_call_score: 0.91 },
      });

      const parsed = JSON.parse(textOf(result)) as LeaderboardRow[];
      expect(parsed.length).toBe(2);
      expect(parsed.every((r) => r.tool_call_score >= 0.91)).toBe(true);
    } finally {
      cleanupTestDir(dir);
    }
  });
});

describe("models-leaderboard: sort_by", () => {
  test("sort_by: throughput_tps changes order to throughput DESC", async () => {
    const dir = setupTestDir();
    try {
      seedDb(leaderboardRows, asof, dir);

      const server = new McpServer({ name: "test", version: "0.0.0" });
      registerModelsLeaderboardTool(server);
      const client = await connected(server);

      const result = await client.callTool({
        name: "llamactl.models.leaderboard",
        arguments: { sort_by: "throughput_tps" },
      });

      const parsed = JSON.parse(textOf(result)) as LeaderboardRow[];
      expect(parsed.length).toBe(3);
      expect(parsed[0]!.model).toBe("granite4-3b");
      expect(parsed[1]!.model).toBe("qwen3-35b-mtp");
      expect(parsed[2]!.model).toBe("gemma4-26b-a4b");
    } finally {
      cleanupTestDir(dir);
    }
  });
});

describe("models-leaderboard: alias dedup", () => {
  test("calling the underscore alias logs exactly one deprecation warning", async () => {
    const dir = setupTestDir();
    try {
      seedDb(leaderboardRows, asof, dir);

      const server = new McpServer({ name: "test", version: "0.0.0" });
      registerModelsLeaderboardTool(server);
      const client = await connected(server);

      const messages: string[] = [];
      const consoleErrorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        messages.push(args.map(String).join(" "));
      });

      try {
        await client.callTool({
          name: "llamactl_models_leaderboard",
          arguments: {},
        });
        await client.callTool({
          name: "llamactl_models_leaderboard",
          arguments: {},
        });
      } finally {
        consoleErrorSpy.mockRestore();
      }

      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("llamactl_models_leaderboard");
      expect(messages[0]).toContain("llamactl.models.leaderboard");
    } finally {
      cleanupTestDir(dir);
    }
  });
});

describe("models-leaderboard: listTools enum guard", () => {
  test("sort_by enum equals the 11 column names", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerModelsLeaderboardTool(server);
    const client = await connected(server);

    const list = await client.listTools();
    const leaderboardTool = list.tools.find((t) => t.name === "llamactl.models.leaderboard");
    expect(leaderboardTool).toBeDefined();

    const schema = leaderboardTool!.inputSchema as Record<string, unknown>;
    const properties = schema as { properties: Record<string, unknown> };
    const sortByProp = properties.properties["sort_by"] as { enum?: string[] };
    const enumVal = sortByProp.enum!;
    expect(enumVal).toBeDefined();

    const columnNames = [
      "model",
      "node",
      "ub",
      "throughput_tps",
      "ttft_ms",
      "tool_call_score",
      "context_8k_score",
      "context_16k_score",
      "json_score",
      "composite",
      "asof",
    ];
    const actualEnum = enumVal.sort();
    const expectedEnum = [...columnNames].sort();
    expect(actualEnum).toEqual(expectedEnum);
    // This enum is the only guard on queryRows' interpolated ORDER BY.
  });
});

describe("models-leaderboard: regression — node filter survives refactors", () => {
  test("node filter: removing the WHERE clause returns all nodes", async () => {
    const dir = setupTestDir();
    try {
      seedDb(leaderboardRows, asof, dir);

      const server = new McpServer({ name: "test", version: "0.0.0" });
      registerModelsLeaderboardTool(server);
      const client = await connected(server);

      const result = await client.callTool({
        name: "llamactl.models.leaderboard",
        arguments: { node: "mac-mini" },
      });

      const parsed = JSON.parse(textOf(result)) as LeaderboardRow[];
      // If the node filter were removed, all 3 rows would be returned.
      expect(parsed.length).toBe(2);
      expect(parsed.every((r) => r.node === "mac-mini")).toBe(true);
    } finally {
      cleanupTestDir(dir);
    }
  });
});
