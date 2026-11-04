/* eslint-disable @typescript-eslint/require-await -- Test tool-client fakes implement Promise-returning interfaces with synchronous fixtures. */
import { describe, expect, test } from "bun:test";

import {
  executePlan,
  executePlanStep,
  type PlanLike,
  type RunbookToolClient,
  type ToolCallInput,
} from "../src/index.js";

/**
 * Tests for `executePlanStep` and `executePlan` — the pure execution
 * layer that dispatches plan steps to either a runbook (when the step
 * tool matches a registered runbook name) or a raw MCP tool via the
 * supplied tool client. Every error is caught internally and surfaced
 * as an `{ok: false, error}` envelope so the caller always gets a
 * complete step record for the journal.
 *
 * Pattern: a local fake client records each call as `{ input, result }`
 * (all three callTool arguments) and returns a handler result per test.
 * No mock.module, no spyOn, no timers, no filesystem, no network.
 */

function envelope(payload: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

interface RecordedCall {
  input: ToolCallInput;
  resultSchema: unknown;
  options: unknown;
  result: unknown;
}

function makeFakeClient(handler: (input: ToolCallInput) => Promise<unknown>): {
  calls: RecordedCall[];
  client: RunbookToolClient;
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    client: {
      async callTool(
        input: ToolCallInput,
        resultSchema?: unknown,
        options?: unknown,
      ): Promise<unknown> {
        calls.push({ input, resultSchema, options, result: await handler(input) });
        return await handler(input);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// executePlanStep — raw MCP tool path
// ---------------------------------------------------------------------------

describe("executePlanStep — raw MCP tool path", () => {
  test("1. Forwards name/args and the 5-minute budget", async () => {
    const { calls, client } = makeFakeClient(async () => ({}));
    const step = { tool: "llamactl.catalog.promote", args: { model: "m1" } };
    const outcome = await executePlanStep(step, { toolClient: client });
    expect(calls).toHaveLength(1);
    const c0 = calls[0]!;
    expect(c0.input).toEqual({ name: "llamactl.catalog.promote", arguments: { model: "m1" } });
    expect(c0.resultSchema).toBeUndefined();
    expect(c0.options).toEqual({ timeout: 300_000, resetTimeoutOnProgress: true });
    expect(outcome).toEqual({ ok: true, result: {} });
  });

  test("2. Missing step.args -> arguments is {}", async () => {
    const { calls, client } = makeFakeClient(async () => ({}));
    const step = { tool: "llamactl.server.reload" };
    const outcome = await executePlanStep(step, { toolClient: client });
    expect(calls).toHaveLength(1);
    const c0 = calls[0]!;
    expect(c0.input.arguments).toEqual({});
    expect(outcome.ok).toBe(true);
  });

  test("3. Success returns the raw envelope as-is", async () => {
    const raw = { specific: "object" };
    const { calls, client } = makeFakeClient(async () => raw);
    const outcome = await executePlanStep(
      { tool: "llamactl.catalog.list" },
      { toolClient: client },
    );
    expect(outcome).toEqual({ ok: true, result: raw });
    expect((outcome as { result: unknown }).result).toBe(raw);
  });

  test("4. Only isError === true counts as an error", async () => {
    const { client } = makeFakeClient(async () => ({
      isError: "true",
      content: [{ type: "text", text: "x" }],
    }));
    const outcome = await executePlanStep(
      { tool: "llamactl.catalog.list" },
      { toolClient: client },
    );
    expect(outcome.ok).toBe(true);
  });

  test("5. isError text becomes the error", async () => {
    const { client } = makeFakeClient(async () => ({
      isError: true,
      content: [{ type: "text", text: "boom" }],
    }));
    const outcome = await executePlanStep(
      { tool: "llamactl.catalog.list" },
      { toolClient: client },
    );
    expect(outcome).toEqual({ ok: false, error: "boom" });
  });

  test("6. isError text is cut to 500 chars", async () => {
    const text = "e".repeat(600);
    const { client } = makeFakeClient(async () => ({
      isError: true,
      content: [{ type: "text", text }],
    }));
    const outcome = await executePlanStep(
      { tool: "llamactl.catalog.list" },
      { toolClient: client },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.length).toBe(500);
      expect(outcome.error).toBe("e".repeat(500));
    }
  });

  test("7. isError with no content -> fallback message", async () => {
    const { client } = makeFakeClient(async () => ({
      isError: true,
      content: undefined,
    }));
    const outcome = await executePlanStep(
      { tool: "llamactl.catalog.promote" },
      { toolClient: client },
    );
    expect(outcome).toEqual({
      ok: false,
      error: "llamactl.catalog.promote: tool returned isError",
    });
  });

  test("8. isError whose first block is not text -> fallback", async () => {
    const { client } = makeFakeClient(async () => ({
      isError: true,
      content: [{ type: "image", data: "base64" }],
    }));
    const outcome = await executePlanStep(
      { tool: "llamactl.catalog.promote" },
      { toolClient: client },
    );
    expect(outcome).toEqual({
      ok: false,
      error: "llamactl.catalog.promote: tool returned isError",
    });
  });

  test("9. callTool rejects with Error -> outcome captures message, no throw", async () => {
    const { client } = makeFakeClient(async () => {
      throw new Error("socket closed");
    });
    const outcome = await executePlanStep(
      { tool: "llamactl.catalog.list" },
      { toolClient: client },
    );
    expect(outcome).toEqual({ ok: false, error: "socket closed" });
  });

  test("10. callTool rejects with non-Error value -> stringified", async () => {
    const { client } = makeFakeClient(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the non-Error rejection is the case under test.
      throw "plain-string";
    });
    const outcome = await executePlanStep(
      { tool: "llamactl.catalog.list" },
      { toolClient: client },
    );
    expect(outcome).toEqual({ ok: false, error: "plain-string" });
  });
});

// ---------------------------------------------------------------------------
// executePlanStep — runbook path
// ---------------------------------------------------------------------------

describe("executePlanStep — runbook path", () => {
  test("11. A runbook name goes through runRunbook, not callTool", async () => {
    const log: string[] = [];
    const { calls, client } = makeFakeClient(async (input) => {
      if (input.name === "llamactl.workload.list") return envelope({ count: 0, workloads: [] });
      if (input.name === "llamactl.node.remove") return envelope({ ok: true });
      throw new Error(`unexpected: ${input.name}`);
    });
    const outcome = await executePlanStep(
      { tool: "drain-node", args: { node: "n1" } },
      { toolClient: client, log: (m) => log.push(m) },
    );
    const callNames = calls.map((c) => c.input.name);
    expect(callNames).toEqual(["llamactl.workload.list", "llamactl.node.remove"]);
    expect(callNames).not.toContain("drain-node");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect((outcome.result as { ok: boolean }).ok).toBe(true);
    }
  });

  test("12. dryRun defaults to false", async () => {
    const { calls, client } = makeFakeClient(async (input) => {
      if (input.name === "llamactl.workload.list") return envelope({ count: 0, workloads: [] });
      if (input.name === "llamactl.node.remove") return envelope({ ok: true });
      throw new Error(`unexpected: ${input.name}`);
    });
    await executePlanStep({ tool: "drain-node", args: { node: "n1" } }, { toolClient: client });
    const removeCall = calls.find((c) => c.input.name === "llamactl.node.remove");
    expect(removeCall).toBeDefined();
    expect((removeCall!.input.arguments as { dryRun?: boolean }).dryRun).toBe(false);
  });

  test("13. opts.dryRun: true is passed on", async () => {
    const { calls, client } = makeFakeClient(async (input) => {
      if (input.name === "llamactl.workload.list") return envelope({ count: 0, workloads: [] });
      if (input.name === "llamactl.node.remove") return envelope({ ok: true });
      throw new Error(`unexpected: ${input.name}`);
    });
    await executePlanStep(
      { tool: "drain-node", args: { node: "n1" } },
      { toolClient: client, dryRun: true },
    );
    const removeCall = calls.find((c) => c.input.name === "llamactl.node.remove");
    expect(removeCall).toBeDefined();
    expect((removeCall!.input.arguments as { dryRun?: boolean }).dryRun).toBe(true);
  });

  test("14. opts.log reaches the runbook", async () => {
    const log: string[] = [];
    const { client } = makeFakeClient(async (input) => {
      if (input.name === "llamactl.workload.list") return envelope({ count: 0, workloads: [] });
      if (input.name === "llamactl.node.remove") return envelope({ ok: true });
      throw new Error(`unexpected: ${input.name}`);
    });
    await executePlanStep(
      { tool: "drain-node", args: { node: "n1" } },
      { toolClient: client, log: (m) => log.push(m) },
    );
    expect(log).toContain("drain-node: removed 0 manifest(s) on n1 + node");
  });

  test("15. Invalid runbook params become an envelope, not a throw", async () => {
    const { client } = makeFakeClient(async () => envelope({ ok: true }));
    const outcome = await executePlanStep({ tool: "drain-node", args: {} }, { toolClient: client });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatch(/^runbook drain-node: invalid params/);
    }
  });

  test("16. A runbook failure surfaces its error", async () => {
    const { client } = makeFakeClient(async (input) => {
      if (input.name === "llamactl.workload.list") {
        return { content: [{ type: "text", text: "not-json" }] };
      }
      if (input.name === "llamactl.node.remove") return envelope({ ok: true });
      throw new Error(`unexpected: ${input.name}`);
    });
    const outcome = await executePlanStep(
      { tool: "drain-node", args: { node: "n1" } },
      { toolClient: client },
    );
    expect(outcome).toEqual({ ok: false, error: "tool returned non-JSON: not-json" });
  });
});

// ---------------------------------------------------------------------------
// executePlan
// ---------------------------------------------------------------------------

describe("executePlan", () => {
  test("17. A thrown step stops the run", async () => {
    const { client } = makeFakeClient(async (input) => {
      if (input.name === "llamactl.catalog.list") return envelope({ ok: true });
      if (input.name === "llamactl.catalog.promote") {
        throw new Error("down");
      }
      if (input.name === "llamactl.server.reload") {
        throw new Error("should not be called");
      }
      return envelope({ ok: true });
    });
    const plan: PlanLike = {
      steps: [
        { tool: "llamactl.catalog.list" },
        { tool: "llamactl.catalog.promote" },
        { tool: "llamactl.server.reload" },
      ],
      reasoning: "r",
      requiresConfirmation: false,
    };
    const result = await executePlan(plan, { toolClient: client });
    expect(result.stoppedAt).toBe(1);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toEqual({
      index: 0,
      tool: "llamactl.catalog.list",
      outcome: { ok: true, result: { content: [{ type: "text", text: '{"ok":true}' }] } },
    });
    expect(result.steps[1]).toEqual({
      index: 1,
      tool: "llamactl.catalog.promote",
      outcome: { ok: false, error: "down" },
    });
  });

  test("18. A failing first step reports stoppedAt 0", async () => {
    const { client } = makeFakeClient(async () => ({
      isError: true,
      content: [{ type: "text", text: "boom" }],
    }));
    const plan: PlanLike = {
      steps: [{ tool: "llamactl.catalog.list" }],
      reasoning: "r",
      requiresConfirmation: false,
    };
    const result = await executePlan(plan, { toolClient: client });
    expect(result.stoppedAt).toBe(0);
    expect(result.steps).toHaveLength(1);
  });

  test("19. opts are passed to every step", async () => {
    const { calls, client } = makeFakeClient(async (input) => {
      if (input.name === "llamactl.workload.list") return envelope({ count: 0, workloads: [] });
      if (input.name === "llamactl.node.remove") return envelope({ ok: true });
      throw new Error(`unexpected: ${input.name}`);
    });
    const plan: PlanLike = {
      steps: [
        { tool: "drain-node", args: { node: "n1" } },
        { tool: "drain-node", args: { node: "n2" } },
      ],
      reasoning: "r",
      requiresConfirmation: false,
    };
    const result = await executePlan(plan, { toolClient: client, dryRun: true });
    expect(result.stoppedAt).toBeUndefined();
    const removeCalls = calls.filter((c) => c.input.name === "llamactl.node.remove");
    expect(removeCalls).toHaveLength(2);
    const r0 = removeCalls[0]!;
    const r1 = removeCalls[1]!;
    expect((r0.input.arguments as { dryRun?: boolean }).dryRun).toBe(true);
    expect((r1.input.arguments as { dryRun?: boolean }).dryRun).toBe(true);
  });
});
