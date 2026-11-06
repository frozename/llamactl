import { describe, expect, test } from "bun:test";

import {
  askPlanner,
  buildGoal,
  type PlanLike,
  proposalId,
  type RunbookToolClient,
  type ToolCallInput,
} from "../src/index.js";

/** Minimal MCP tool-call envelope shape (matches the source's McpCallResult). */
interface McpCallResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
}

function envelope(payload: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function raw(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}

/* eslint-disable @typescript-eslint/require-await -- Test fixture: synchronous reply wrapped in Promise<unknown> to satisfy the RunbookToolClient interface. */
function fakeClient(reply: (input: ToolCallInput) => unknown): {
  client: RunbookToolClient;
  calls: ToolCallInput[];
} {
  const calls: ToolCallInput[] = [];
  return {
    calls,
    client: {
      callTool(input: ToolCallInput): Promise<unknown> {
        calls.push(input);
        return Promise.resolve(reply(input));
      },
    },
  };
}

describe("askPlanner call shape", () => {
  test("calls callTool exactly once with the correct tool name and goal", async () => {
    const { client, calls } = fakeClient(async (input) =>
      envelope({ ok: true, plan: { steps: [] } }),
    );
    await askPlanner(client, "G");
    expect(calls).toEqual([{ name: "nova.operator.plan", arguments: { goal: "G" } }]);
  });
});

describe("askPlanner transport and envelope failures", () => {
  test("callTool rejects with Error → { ok: false, reason: 'call-failed' }", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("boom");
    });
    const result = await askPlanner(client, "goal");
    expect(result).toStrictEqual({ ok: false, reason: "call-failed", message: "boom" });
  });

  test("callTool rejects with a non-Error value → message is String(err)", async () => {
    const { client } = fakeClient(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the non-Error rejection is the case under test.
      throw "plain";
    });
    const result = await askPlanner(client, "goal");
    expect(result).toStrictEqual({ ok: false, reason: "call-failed", message: "plain" });
  });

  test("isError:true with text content → reason 'call-failed', message sliced to 500", async () => {
    const long = "x".repeat(600);
    const { client } = fakeClient(async () => ({
      isError: true,
      content: [{ type: "text", text: long }],
    }));
    const result = await askPlanner(client, "goal");
    expect(result).toStrictEqual({
      ok: false,
      reason: "call-failed",
      message: long.slice(0, 500),
    });
  });

  test("isError:true with no content → message explains the source", async () => {
    const { client } = fakeClient(async () => ({ isError: true }));
    const result = await askPlanner(client, "goal");
    expect(result).toStrictEqual({
      ok: false,
      reason: "call-failed",
      message: "nova.operator.plan returned isError",
    });
  });

  test.each([
    { label: "empty object", payload: {} },
    { label: "empty content array", payload: { content: [] } },
    { label: "image content", payload: { content: [{ type: "image", text: "{}" }] } },
    { label: "text without text field", payload: { content: [{ type: "text" }] } },
  ])("missing text content block → $label", async ({ payload }) => {
    const { client } = fakeClient(async () => payload);
    const result = await askPlanner(client, "goal");
    expect(result).toStrictEqual({
      ok: false,
      reason: "envelope-error",
      message: "nova.operator.plan: missing text content block",
    });
  });

  test("only the first text block is read", async () => {
    const multiBlock = {
      content: [
        { type: "text", text: "not json" },
        ...envelope({ ok: true, plan: { steps: [] } }).content,
      ],
    };
    const { client } = fakeClient(async () => multiBlock);
    const result = await askPlanner(client, "goal");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("envelope-error");
      expect(result.message).toMatch(/^nova\.operator\.plan: JSON parse failed — /);
    }
  });

  test.each(["null", "42", '"str"'])("non-object JSON primitive → '%s'", async (text) => {
    const { client } = fakeClient(async () => raw(text));
    const result = await askPlanner(client, "goal");
    expect(result).toStrictEqual({
      ok: false,
      reason: "envelope-error",
      message: "nova.operator.plan: envelope is not an object",
    });
  });

  test("array JSON passes the object check but fails planner validation", async () => {
    const { client } = fakeClient(async () => raw("[1]"));
    const result = await askPlanner(client, "goal");
    expect(result).toStrictEqual({
      ok: false,
      reason: "planner-failed",
      message: "planner returned ok:false with no message",
    });
  });
});

describe("askPlanner ok:false narrowing", () => {
  test("ok:false with reason/message passes through", async () => {
    const { client } = fakeClient(async () =>
      envelope({ ok: false, reason: "no-executor", message: "none wired", executor: "x" }),
    );
    const result = await askPlanner(client, "goal");
    expect(result).toStrictEqual({
      ok: false,
      reason: "no-executor",
      message: "none wired",
    });
  });

  test("ok:false with non-string reason/message → planner-failed", async () => {
    const { client } = fakeClient(async () =>
      envelope({ ok: false, reason: 7, message: { a: 1 } }),
    );
    const result = await askPlanner(client, "goal");
    expect(result).toStrictEqual({
      ok: false,
      reason: "planner-failed",
      message: "planner returned ok:false with no message",
    });
  });

  test("truthy non-boolean ok → planner-failed", async () => {
    const { client } = fakeClient(async () => envelope({ ok: "true", plan: { steps: [] } }));
    const result = await askPlanner(client, "goal");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("planner-failed");
    }
  });
});

describe("askPlanner ok:true narrowing", () => {
  test.each([
    { label: "null plan", payload: null },
    { label: "object without steps array", payload: { steps: {} } },
    { label: "string plan", payload: "plan" },
  ])("ok:true with $label → envelope-error", async ({ payload }) => {
    const { client } = fakeClient(async () => envelope({ ok: true, plan: payload }));
    const result = await askPlanner(client, "goal");
    expect(result).toStrictEqual({
      ok: false,
      reason: "envelope-error",
      message: "nova.operator.plan: missing plan.steps in ok response",
    });
  });

  test("valid plan passes through with no extra keys", async () => {
    const P: PlanLike = {
      steps: [{ tool: "llamactl.catalog.list" }],
      reasoning: "r",
      requiresConfirmation: false,
    };
    const { client } = fakeClient(async () => envelope({ ok: true, plan: P }));
    const result = await askPlanner(client, "goal");
    expect(result).toStrictEqual({ ok: true, plan: P });
  });

  test("valid plan with executor string → result.executor is set", async () => {
    const P: PlanLike = {
      steps: [],
      reasoning: "",
      requiresConfirmation: false,
    };
    const { client } = fakeClient(async () => envelope({ ok: true, plan: P, executor: "stub" }));
    const result = await askPlanner(client, "goal");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.executor).toBe("stub");
    }
  });

  test("executor '' (empty string) → executor key absent", async () => {
    const P: PlanLike = {
      steps: [],
      reasoning: "",
      requiresConfirmation: false,
    };
    const { client } = fakeClient(async () => envelope({ ok: true, plan: P, executor: "" }));
    const result = await askPlanner(client, "goal");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("executor" in result).toBe(false);
    }
  });

  test("executor 5 (non-string) → executor key absent", async () => {
    const P: PlanLike = {
      steps: [],
      reasoning: "",
      requiresConfirmation: false,
    };
    const { client } = fakeClient(async () => envelope({ ok: true, plan: P, executor: 5 }));
    const result = await askPlanner(client, "goal");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("executor" in result).toBe(false);
    }
  });

  test("toolsAvailable filters to strings only", async () => {
    const P: PlanLike = {
      steps: [],
      reasoning: "",
      requiresConfirmation: false,
    };
    const { client } = fakeClient(async () =>
      envelope({ ok: true, plan: P, toolsAvailable: ["a", 1, null, "b", { x: 1 }] }),
    );
    const result = await askPlanner(client, "goal");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.toolsAvailable).toEqual(["a", "b"]);
    }
  });

  test("toolsAvailable [] → key present and equals []", async () => {
    const P: PlanLike = {
      steps: [],
      reasoning: "",
      requiresConfirmation: false,
    };
    const { client } = fakeClient(async () => envelope({ ok: true, plan: P, toolsAvailable: [] }));
    const result = await askPlanner(client, "goal");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.toolsAvailable).toEqual([]);
    }
  });

  test("toolsAvailable 'a' (non-array) → key absent", async () => {
    const P: PlanLike = {
      steps: [],
      reasoning: "",
      requiresConfirmation: false,
    };
    const { client } = fakeClient(async () => envelope({ ok: true, plan: P, toolsAvailable: "a" }));
    const result = await askPlanner(client, "goal");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("toolsAvailable" in result).toBe(false);
    }
  });
});

describe("buildGoal wording", () => {
  test("unhealthy gateway", () => {
    const goal = buildGoal({
      name: "g1",
      kind: "gateway",
      from: "healthy",
      to: "unhealthy",
    });
    expect(goal).toBe("gateway 'g1' is unhealthy — restore availability or drain gracefully.");
  });

  test("unhealthy provider", () => {
    const goal = buildGoal({
      name: "openai",
      kind: "provider",
      from: "unknown",
      to: "unhealthy",
    });
    expect(goal).toBe("provider 'openai' is unhealthy — restore availability or drain gracefully.");
  });

  test("recovered gateway", () => {
    const goal = buildGoal({
      name: "g1",
      kind: "gateway",
      from: "unhealthy",
      to: "healthy",
    });
    expect(goal).toBe(
      "gateway 'g1' recovered to healthy — confirm stable and close any outstanding remediation.",
    );
  });

  test("recovered provider", () => {
    const goal = buildGoal({
      name: "g1",
      kind: "provider",
      from: "unhealthy",
      to: "healthy",
    });
    expect(goal.startsWith("provider 'g1' recovered to healthy")).toBe(true);
  });
});

describe("proposalId canonical form", () => {
  test("first 12 hex chars of sha256 of {steps, reasoning}", () => {
    const plan: PlanLike = {
      steps: [{ tool: "llamactl.catalog.list", annotation: "x" }],
      reasoning: "r",
      requiresConfirmation: false,
    };
    const id = proposalId(plan);
    expect(id).toBe("c72fef1e9e7c");
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  test("empty plan id", () => {
    const plan: PlanLike = {
      steps: [],
      reasoning: "",
      requiresConfirmation: true,
    };
    const id = proposalId(plan);
    expect(id).toBe("3d4e02cf4f25");
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  test("flipping requiresConfirmation leaves id unchanged", () => {
    const planA: PlanLike = {
      steps: [{ tool: "a" }],
      reasoning: "r",
      requiresConfirmation: false,
    };
    const planB: PlanLike = {
      steps: [{ tool: "a" }],
      reasoning: "r",
      requiresConfirmation: true,
    };
    expect(proposalId(planA)).toBe(proposalId(planB));
  });

  test("changing reasoning changes the id", () => {
    const a = proposalId({ steps: [], reasoning: "r1", requiresConfirmation: false });
    const b = proposalId({ steps: [], reasoning: "r2", requiresConfirmation: false });
    expect(a).not.toBe(b);
  });
});
