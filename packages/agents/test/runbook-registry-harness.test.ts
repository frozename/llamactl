/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Test doubles implement async tool interfaces with synchronous fixtures and Bun's rejects matcher is typed as void. */
import { describe, expect, test } from "bun:test";

import type { RunbookToolClient, ToolCallInput } from "../src/types.js";

import { runRunbook } from "../src/harness.js";
import { listRunbooks, RUNBOOKS } from "../src/runbooks/index.js";

/**
 * Pins the runbook registry shape (key order + the listRunbooks
 * projection) and the runRunbook harness wiring around cost-snapshot:
 * injected toolClient routing, params validation/defaulting, error
 * envelopes, and the ctx.log line. No MCP server boots — every tool
 * call goes through the fake client below.
 */

const VALID_PAYLOAD = JSON.stringify({
  windowSince: "a",
  windowUntil: "b",
  filesScanned: 1,
  malformedLines: 0,
  totalRequests: 2,
  totalTokens: 30,
  byProvider: [],
  byModel: [],
});

function makeClient(reply: Error | string): {
  client: RunbookToolClient;
  calls: ToolCallInput[];
} {
  const calls: ToolCallInput[] = [];
  const client: RunbookToolClient = {
    async callTool(input: ToolCallInput) {
      calls.push(input);
      if (reply instanceof Error) {
        throw reply;
      }
      return { content: [{ type: "text", text: reply }] };
    },
  };
  return { client, calls };
}

describe("runbook registry", () => {
  test("RUNBOOKS is keyed by each runbook's own name in registration order", () => {
    expect(Object.keys(RUNBOOKS)).toEqual([
      "promote-fastest-vision-model",
      "audit-fleet",
      "cost-snapshot",
      "drain-node",
      "onboard-new-gpu-node",
    ]);
    expect(Object.values(RUNBOOKS).map((r) => r.name)).toEqual(Object.keys(RUNBOOKS));
  });

  test("listRunbooks returns only name and description for every registered runbook, in registry order", () => {
    expect(listRunbooks()).toEqual(
      Object.values(RUNBOOKS).map((r) => ({ name: r.name, description: r.description })),
    );
    expect(listRunbooks().map((e) => Object.keys(e).sort())).toEqual(
      Array.from({ length: 5 }, () => ["description", "name"]),
    );
    expect(listRunbooks().map((e) => e.name)).toEqual([
      "promote-fastest-vision-model",
      "audit-fleet",
      "cost-snapshot",
      "drain-node",
      "onboard-new-gpu-node",
    ]);
  });
});

describe("runRunbook harness wiring (cost-snapshot)", () => {
  test("a callTool rejection resolves to ok:false with empty steps and the error message", async () => {
    const { client } = makeClient(new Error("boom"));

    const result = await runRunbook("cost-snapshot", {}, { toolClient: client });

    expect(result).toEqual({ ok: false, steps: [], error: "boom" });
  });

  test("a non-JSON tool reply resolves to ok:false carrying the parse error", async () => {
    const { client } = makeClient("not json");

    const result = await runRunbook("cost-snapshot", {}, { toolClient: client });

    expect(result).toEqual({ ok: false, steps: [], error: "tool returned non-JSON: not json" });
  });

  test("undefined params fall back to the schema default days of 7", async () => {
    const { client, calls } = makeClient(VALID_PAYLOAD);

    const result = await runRunbook("cost-snapshot", undefined, { toolClient: client });

    expect(calls).toEqual([{ name: "nova.ops.cost.snapshot", arguments: { days: 7 } }]);
    expect(result.ok).toBe(true);
  });

  test("invalid params reject with the runbook-prefixed message before any tool call", async () => {
    const { client, calls } = makeClient(VALID_PAYLOAD);

    await expect(runRunbook("cost-snapshot", { days: 0 }, { toolClient: client })).rejects.toThrow(
      /^runbook cost-snapshot: invalid params — /,
    );
    expect(calls).toEqual([]);
  });

  test("opts.log receives the runbook's log line", async () => {
    const { client } = makeClient(VALID_PAYLOAD);
    const logs: string[] = [];

    await runRunbook(
      "cost-snapshot",
      {},
      {
        log: (message) => logs.push(message),
        toolClient: client,
      },
    );

    expect(logs).toEqual([
      "cost-snapshot: 2 requests / 30 tokens across 1 file(s) in window a → b",
    ]);
  });
});
