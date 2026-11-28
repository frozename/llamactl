import type {
  CallToolResult,
  CompatibilityCallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { registerOperatorTools } from "../src/tools/operator.js";

/**
 * Pins for `llamactl.bench.history`: sort direction, rel filter, the
 * limit contract (default 50, integer, 1..500) and the row projection
 * that keeps `ctx` / `launch_args` off the wire. Rows are seeded
 * straight into `$LOCAL_AI_RUNTIME_DIR/llama-bench-history.tsv` — the
 * path `bench.benchHistoryFile` resolves — so the tool reads fixtures
 * through the same TSV parser production uses.
 */

type ProjectedRow = {
  updated_at: string;
  machine: string;
  rel: string;
  mode: string;
  profile: string;
  gen_ts: string;
  prompt_ts: string;
  build: string;
};

type HistoryPayload = {
  count: number;
  total: number;
  legacyCount: number;
  rows: ProjectedRow[];
};

type Seed = {
  updated_at: string;
  rel: string;
  machine?: string;
  mode?: string;
  ctx?: string;
  build?: string;
  profile?: string;
  gen_ts?: string;
  prompt_ts?: string;
  launch_args?: string;
};

const PROJECTED_KEYS = [
  "build",
  "gen_ts",
  "machine",
  "mode",
  "profile",
  "prompt_ts",
  "rel",
  "updated_at",
];

const savedEnv = {
  DEV_STORAGE: process.env["DEV_STORAGE"],
  LOCAL_AI_RUNTIME_DIR: process.env["LOCAL_AI_RUNTIME_DIR"],
  LLAMA_CPP_MACHINE_PROFILE: process.env["LLAMA_CPP_MACHINE_PROFILE"],
};

let runtimeDir = "";

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-bench-history-tool-"));
  process.env["DEV_STORAGE"] = runtimeDir;
  process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
  // Pin the profile so resolveEnv() never probes host memory.
  process.env["LLAMA_CPP_MACHINE_PROFILE"] = "macbook-pro-48g";
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  rmSync(runtimeDir, { recursive: true, force: true });
});

function historyFile(): string {
  return join(runtimeDir, "llama-bench-history.tsv");
}

/** Current-schema row: the 10 canonical bench-history columns. */
function currentRow(seed: Seed): string {
  return [
    seed.updated_at,
    seed.machine ?? "macbook-pro-48g",
    seed.rel,
    seed.mode ?? "text",
    seed.ctx ?? "8192",
    seed.build ?? "b4900",
    seed.profile ?? "gen=41.7 prompt=288.4",
    seed.gen_ts ?? "41.7",
    seed.prompt_ts ?? "288.4",
    seed.launch_args ?? "--np 1",
  ].join("\t");
}

/** Legacy-schema row: exactly 6 columns, no machine/mode/ctx/build. */
function legacyRow(seed: { updated_at: string; rel: string }): string {
  return [seed.updated_at, seed.rel, "gen=9.9 prompt=50.0", "9.9", "50.0", "--np 1"].join("\t");
}

function seedHistory(rows: string[]): void {
  writeFileSync(historyFile(), rows.map((row) => `${row}\n`).join(""), "utf8");
}

function isoHour(index: number): string {
  return new Date(Date.UTC(2026, 5, 1) + index * 3_600_000).toISOString();
}

/** Ascending-by-index fixture rows, newest last in the file. */
function generatedRows(count: number): string[] {
  return Array.from({ length: count }, (_unused: unknown, index: number) =>
    currentRow({
      updated_at: isoHour(index),
      rel: `org/model-${String(index + 1).padStart(2, "0")}.gguf`,
    }),
  );
}

async function connected(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerOperatorTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text: string }[] }).content ?? [];
  return content[0]?.text ?? "";
}

function errorFlagOf(result: unknown): boolean | undefined {
  return (result as { isError?: boolean }).isError;
}

function payloadOf(result: unknown): HistoryPayload {
  return JSON.parse(textOf(result)) as HistoryPayload;
}

async function callHistory(
  client: Client,
  args: Record<string, unknown>,
): Promise<CallToolResult | CompatibilityCallToolResult> {
  return await client.callTool({ name: "llamactl.bench.history", arguments: args });
}

async function historyOf(args: Record<string, unknown>): Promise<HistoryPayload> {
  const client = await connected();
  const result = await callHistory(client, args);
  expect(errorFlagOf(result)).toBeFalsy();
  return payloadOf(result);
}

describe("bench.history: ordering", () => {
  test("returns rows newest-first by updated_at, not in file order", async () => {
    seedHistory([
      currentRow({ updated_at: "2026-01-05T00:00:00.000Z", rel: "org/slow.gguf" }),
      currentRow({ updated_at: "2025-12-31T23:59:59.000Z", rel: "org/oldest.gguf" }),
      currentRow({ updated_at: "2026-03-01T00:00:00.000Z", rel: "org/fastest.gguf" }),
      currentRow({ updated_at: "2026-02-10T00:00:00.000Z", rel: "org/mid.gguf" }),
    ]);

    const parsed = await historyOf({});

    expect(parsed.rows.map((row) => row.rel)).toEqual([
      "org/fastest.gguf",
      "org/mid.gguf",
      "org/slow.gguf",
      "org/oldest.gguf",
    ]);
    expect(parsed.rows[0]!.updated_at).toBe("2026-03-01T00:00:00.000Z");
    expect(parsed.count).toBe(4);
    expect(parsed.total).toBe(4);
  });
});

describe("bench.history: rel filter", () => {
  test("rel narrows the rows and total counts the filtered set, not the file", async () => {
    seedHistory([
      currentRow({ updated_at: "2026-03-01T00:00:00.000Z", rel: "org/fastest.gguf" }),
      currentRow({ updated_at: "2026-02-10T00:00:00.000Z", rel: "org/mid.gguf" }),
      currentRow({ updated_at: "2026-01-05T00:00:00.000Z", rel: "org/fastest.gguf" }),
      legacyRow({ updated_at: "2025-11-01T00:00:00.000Z", rel: "org/fastest.gguf" }),
      legacyRow({ updated_at: "2025-10-01T00:00:00.000Z", rel: "org/mid.gguf" }),
    ]);

    const parsed = await historyOf({ rel: "org/fastest.gguf" });

    expect(parsed.rows.map((row) => row.rel)).toEqual(["org/fastest.gguf", "org/fastest.gguf"]);
    expect(parsed.count).toBe(2);
    // total is the filtered count — the file holds 3 current rows.
    expect(parsed.total).toBe(2);
    // legacyCount is a corpus-wide count; the rel filter does not touch it.
    expect(parsed.legacyCount).toBe(2);
  });

  test("an unknown rel returns an empty page without error", async () => {
    seedHistory([currentRow({ updated_at: "2026-03-01T00:00:00.000Z", rel: "org/here.gguf" })]);

    const parsed = await historyOf({ rel: "org/absent.gguf" });

    expect(parsed.rows).toEqual([]);
    expect(parsed.count).toBe(0);
    expect(parsed.total).toBe(0);
  });

  test("the rel filter runs before the limit, so the page is all matches", async () => {
    seedHistory([
      currentRow({ updated_at: "2026-03-01T00:00:00.000Z", rel: "org/other.gguf" }),
      currentRow({ updated_at: "2026-02-20T00:00:00.000Z", rel: "org/target.gguf" }),
      currentRow({ updated_at: "2026-02-10T00:00:00.000Z", rel: "org/other.gguf" }),
      currentRow({ updated_at: "2026-01-30T00:00:00.000Z", rel: "org/target.gguf" }),
      currentRow({ updated_at: "2026-01-05T00:00:00.000Z", rel: "org/target.gguf" }),
    ]);

    const parsed = await historyOf({ rel: "org/target.gguf", limit: 2 });

    expect(parsed.count).toBe(2);
    expect(parsed.total).toBe(3);
    expect(parsed.rows.map((row) => row.rel)).toEqual(["org/target.gguf", "org/target.gguf"]);
    expect(parsed.rows[0]!.updated_at).toBe("2026-02-20T00:00:00.000Z");
  });
});

describe("bench.history: limit default", () => {
  test("omitting limit returns the 50 newest rows of a 60-row file", async () => {
    seedHistory(generatedRows(60));

    const parsed = await historyOf({});

    expect(parsed.count).toBe(50);
    expect(parsed.total).toBe(60);
    expect(parsed.rows).toHaveLength(50);
    expect(parsed.rows[0]!.rel).toBe("org/model-60.gguf");
    expect(parsed.rows[49]!.rel).toBe("org/model-11.gguf");
  });

  test("a limit larger than the corpus returns every row", async () => {
    seedHistory(generatedRows(3));

    const parsed = await historyOf({ limit: 100 });

    expect(parsed.count).toBe(3);
    expect(parsed.total).toBe(3);
    expect(parsed.rows[0]!.rel).toBe("org/model-03.gguf");
  });
});

describe("bench.history: limit bounds", () => {
  test("limit 500 is accepted (max bound is inclusive)", async () => {
    seedHistory(generatedRows(3));

    const parsed = await historyOf({ limit: 500 });

    expect(parsed.count).toBe(3);
  });

  test("limit 501 is rejected", async () => {
    seedHistory(generatedRows(3));
    const client = await connected();

    const result = await callHistory(client, { limit: 501 });

    expect(errorFlagOf(result)).toBe(true);
  });

  test("limit 0 is rejected", async () => {
    seedHistory(generatedRows(3));
    const client = await connected();

    const result = await callHistory(client, { limit: 0 });

    expect(errorFlagOf(result)).toBe(true);
  });

  test("a negative limit is rejected", async () => {
    seedHistory(generatedRows(3));
    const client = await connected();

    const result = await callHistory(client, { limit: -1 });

    expect(errorFlagOf(result)).toBe(true);
  });

  test("a fractional limit is rejected", async () => {
    seedHistory(generatedRows(3));
    const client = await connected();

    const result = await callHistory(client, { limit: 2.5 });

    expect(errorFlagOf(result)).toBe(true);
  });
});

describe("bench.history: row projection", () => {
  test("rows expose exactly the projected columns; ctx and launch_args never leak", async () => {
    seedHistory([
      currentRow({
        updated_at: "2026-03-01T00:00:00.000Z",
        rel: "org/fastest.gguf",
        machine: "mac-mini-16g",
        mode: "vision",
        ctx: "sentinel-ctx-131072",
        build: "b4912",
        profile: "gen=11.1 prompt=99.9",
        gen_ts: "11.1",
        prompt_ts: "99.9",
        launch_args: "sentinel-launch-args --np 8",
      }),
    ]);
    const client = await connected();

    const result = await callHistory(client, {});
    const parsed = payloadOf(result);
    const row = parsed.rows[0]!;

    expect([...Object.keys(row)].sort()).toEqual(PROJECTED_KEYS);
    expect(row).toEqual({
      updated_at: "2026-03-01T00:00:00.000Z",
      machine: "mac-mini-16g",
      rel: "org/fastest.gguf",
      mode: "vision",
      profile: "gen=11.1 prompt=99.9",
      gen_ts: "11.1",
      prompt_ts: "99.9",
      build: "b4912",
    });
    const text = textOf(result);
    expect(text.includes("sentinel-ctx-131072")).toBe(false);
    expect(text.includes("sentinel-launch-args")).toBe(false);
  });
});

describe("bench.history: legacy rows and malformed lines", () => {
  test("six-column legacy rows are counted in legacyCount only", async () => {
    seedHistory([
      currentRow({ updated_at: "2026-03-01T00:00:00.000Z", rel: "org/current.gguf" }),
      legacyRow({ updated_at: "2025-11-01T00:00:00.000Z", rel: "org/legacy.gguf" }),
      legacyRow({ updated_at: "2025-10-01T00:00:00.000Z", rel: "org/legacy2.gguf" }),
    ]);

    const parsed = await historyOf({});

    expect(parsed.legacyCount).toBe(2);
    expect(parsed.count).toBe(1);
    expect(parsed.total).toBe(1);
    expect(parsed.rows.map((row) => row.rel)).toEqual(["org/current.gguf"]);
  });

  test("lines between the legacy and current column counts are dropped silently", async () => {
    seedHistory([
      currentRow({ updated_at: "2026-03-01T00:00:00.000Z", rel: "org/current.gguf" }),
      // 7 columns: too wide for legacy (6) and too narrow for current (10).
      ["2025-11-01T00:00:00.000Z", "org/ragged.gguf", "gen=1.0", "1.0", "2.0", "--np 1", "x"].join(
        "\t",
      ),
      "",
    ]);

    const parsed = await historyOf({});

    expect(parsed.count).toBe(1);
    expect(parsed.total).toBe(1);
    expect(parsed.legacyCount).toBe(0);
    expect(parsed.rows.map((row) => row.rel)).toEqual(["org/current.gguf"]);
  });
});

describe("bench.history: machine scope", () => {
  test("rows from every machine come back — there is no machine filter today", async () => {
    // The tool description promises "rows for the local machine", but the
    // handler filters on rel only. Pinning today's behavior so a machine
    // filter (or a description fix) has to be a deliberate change.
    seedHistory([
      currentRow({
        updated_at: "2026-03-01T00:00:00.000Z",
        rel: "org/a.gguf",
        machine: "mac-mini",
      }),
      currentRow({
        updated_at: "2026-02-01T00:00:00.000Z",
        rel: "org/b.gguf",
        machine: "macbook-pro-48g",
      }),
    ]);

    const parsed = await historyOf({});

    expect(parsed.count).toBe(2);
    expect(parsed.rows.map((row) => row.machine)).toEqual(["mac-mini", "macbook-pro-48g"]);
  });
});
