import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordChatUsage } from "../src/router.js";

/**
 * recordChatUsage feeds the previously-empty cost corpus
 * (~/.llamactl/usage/*.jsonl) that computeCostSnapshot reads. The
 * writer is fire-and-forget + deferred via queueMicrotask, so the
 * tests flush a macrotask before asserting the file landed.
 */

let dir = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chat-usage-"));
  process.env.LLAMACTL_USAGE_DIR = dir;
});

afterEach(() => {
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  rmSync(dir, { recursive: true, force: true });
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("recordChatUsage", () => {
  test("writes a UsageRecord for a response that carries usage", async () => {
    recordChatUsage(
      {
        model: "gpt-4o",
        latencyMs: 42,
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      "openai",
    );
    await flush();

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^openai-\d{4}-\d{2}-\d{2}\.jsonl$/);
    const rec = JSON.parse(readFileSync(join(dir, files[0]!), "utf8").trim()) as Record<
      string,
      unknown
    >;
    expect(rec.provider).toBe("openai");
    expect(rec.model).toBe("gpt-4o");
    expect(rec.kind).toBe("chat");
    expect(rec.prompt_tokens).toBe(10);
    expect(rec.completion_tokens).toBe(5);
    expect(rec.total_tokens).toBe(15);
    expect(rec.latency_ms).toBe(42);
    expect(typeof rec.ts).toBe("string");
  });

  test("no-ops when the response carries no usage block", async () => {
    recordChatUsage({ model: "local-model" }, "local");
    await flush();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  test("defaults latency to 0 when the response omits latencyMs", async () => {
    recordChatUsage(
      { model: "m", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      "local",
    );
    await flush();
    const files = readdirSync(dir);
    const rec = JSON.parse(readFileSync(join(dir, files[0]!), "utf8").trim()) as {
      latency_ms: number;
    };
    expect(rec.latency_ms).toBe(0);
  });

  test("attributes the project route when one is supplied", async () => {
    recordChatUsage(
      { model: "gpt-4o", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      "openai",
      "project:novaflow/code_review/mac-mini.claude-pro",
    );
    await flush();
    const files = readdirSync(dir);
    const rec = JSON.parse(readFileSync(join(dir, files[0]!), "utf8").trim()) as { route?: string };
    expect(rec.route).toBe("project:novaflow/code_review/mac-mini.claude-pro");
  });

  test("omits route when the call was not project-scoped", async () => {
    recordChatUsage(
      { model: "m", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      "local",
    );
    await flush();
    const files = readdirSync(dir);
    const rec = JSON.parse(readFileSync(join(dir, files[0]!), "utf8").trim()) as Record<
      string,
      unknown
    >;
    expect("route" in rec).toBe(false);
  });
});
