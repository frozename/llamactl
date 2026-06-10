import { describe, expect, test } from "bun:test";
import {
  evaluateArgsPredicate,
  scoreToolCallingPrompt,
  scoreToolCallResponse,
} from "../src/runners/tool-calling.js";

describe("evaluateArgsPredicate", () => {
  test("matches string_eq", () => {
    expect(
      evaluateArgsPredicate({ kind: "string_eq", field: "task_id", value: "5" }, { task_id: "5" }),
    ).toBe(true);
  });

  test("matches string_contains", () => {
    expect(
      evaluateArgsPredicate(
        { kind: "string_contains", field: "pattern", value: "LLAMA_CPP_BIN_MTP" },
        { pattern: "grep LLAMA_CPP_BIN_MTP here" },
      ),
    ).toBe(true);
  });

  test("matches int_eq", () => {
    expect(evaluateArgsPredicate({ kind: "int_eq", field: "limit", value: 3 }, { limit: 3 })).toBe(
      true,
    );
  });

  test("fails when a required field is missing", () => {
    expect(evaluateArgsPredicate({ kind: "string_eq", field: "message", value: "hello" }, {})).toBe(
      false,
    );
  });
});

describe("scoreToolCallResponse", () => {
  test("scores should_call false as correct when the model does not call a tool", () => {
    const result = scoreToolCallResponse({
      shouldCall: false,
      expectedTool: null,
      expectedArgsPredicate: null,
      response: { content: "plain answer", toolCalls: [] },
    });

    expect(result).toEqual({
      valid_json: true,
      correct_decision: true,
      correct_tool: true,
      args_match: true,
      score: 1,
    });
  });

  test("scores should_call true with matching tool and args as all ones", () => {
    const result = scoreToolCallResponse({
      shouldCall: true,
      expectedTool: "fs_grep",
      expectedArgsPredicate: {
        kind: "string_contains",
        field: "pattern",
        value: "LLAMA_CPP_BIN_MTP",
      },
      response: {
        content: null,
        toolCalls: [
          {
            name: "fs_grep",
            arguments: '{"pattern":"grep LLAMA_CPP_BIN_MTP"}',
          },
        ],
      },
    });

    expect(result).toEqual({
      valid_json: true,
      correct_decision: true,
      correct_tool: true,
      args_match: true,
      score: 1,
    });
  });

  test("scores invalid json as zero", () => {
    const result = scoreToolCallResponse({
      shouldCall: true,
      expectedTool: "task_get",
      expectedArgsPredicate: { kind: "string_eq", field: "task_id", value: "5" },
      response: {
        content: null,
        toolCalls: [
          {
            name: "task_get",
            arguments: "{not-json",
          },
        ],
      },
    });

    expect(result.valid_json).toBe(false);
    expect(result.score).toBe(0);
  });
});

describe("scoreToolCallingPrompt", () => {
  test("aggregates the four binary fields across a prompt", () => {
    const result = scoreToolCallingPrompt({
      shouldCall: true,
      expectedTool: "memory_search",
      expectedArgsPredicate: { kind: "string_contains", field: "query", value: "gate criteria" },
      response: {
        content: null,
        toolCalls: [
          {
            name: "memory_search",
            arguments: '{"query":"What did we decide about MTP gate criteria?"}',
          },
        ],
      },
    });

    expect(result.score).toBe(1);
    expect(result.correct_tool).toBe(true);
  });
});
