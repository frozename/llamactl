import promptsRaw from '../fixtures/prompts-tool-calling.json' with { type: 'json' };
import toolsRaw from '../fixtures/tools-penumbra.json' with { type: 'json' };
import { buildCompletionRequest, completeChat, type CompletionResponse, type ToolDef } from '../client.js';

export type ArgsPredicate =
  | { kind: 'string_eq'; field: string; value: string }
  | { kind: 'string_contains'; field: string; value: string }
  | { kind: 'int_eq'; field: string; value: number };

export type ToolCallingResponse = {
  content: string | null;
  toolCalls: Array<{ name: string; arguments: string }>;
};

export type ToolCallScore = {
  valid_json: boolean;
  correct_decision: boolean;
  correct_tool: boolean;
  args_match: boolean;
  score: number;
};

export function evaluateArgsPredicate(predicate: ArgsPredicate, args: Record<string, unknown>): boolean {
  const value = args[predicate.field];
  if (predicate.kind === 'int_eq') return typeof value === 'number' && Number.isInteger(value) && value === predicate.value;
  if (typeof value !== 'string') return false;
  return predicate.kind === 'string_eq' ? value === predicate.value : value.includes(predicate.value);
}

function toResponse(resp: CompletionResponse): ToolCallingResponse {
  const message = resp.choices[0]?.message;
  return {
    content: message?.content ?? null,
    toolCalls: message?.tool_calls?.map((call) => ({ name: call.function.name, arguments: call.function.arguments })) ?? [],
  };
}

function parseToolArgs(raw: string): { valid: boolean; args: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(raw);
    return { valid: parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), args: parsed as Record<string, unknown> };
  } catch {
    return { valid: false, args: {} };
  }
}

export function scoreToolCallResponse(input: {
  shouldCall: boolean;
  expectedTool: string | null;
  expectedArgsPredicate: ArgsPredicate | null;
  response: ToolCallingResponse;
}): ToolCallScore {
  const called = input.response.toolCalls.length > 0;
  const valid_json = !input.shouldCall ? true : called && input.response.toolCalls.every((call) => parseToolArgs(call.arguments).valid);
  const correct_decision = input.shouldCall ? called : !called;
  const correct_tool = !input.shouldCall || (input.response.toolCalls[0]?.name === input.expectedTool);
  const args_match =
    !input.shouldCall ||
    (input.expectedArgsPredicate !== null &&
      input.response.toolCalls[0] !== undefined &&
      evaluateArgsPredicate(input.expectedArgsPredicate, parseToolArgs(input.response.toolCalls[0].arguments).args));
  const score = Number(valid_json && correct_decision && correct_tool && args_match);
  return { valid_json, correct_decision, correct_tool, args_match, score };
}

export function scoreToolCallingPrompt(input: {
  shouldCall: boolean;
  expectedTool: string | null;
  expectedArgsPredicate: ArgsPredicate | null;
  response: ToolCallingResponse;
}): ToolCallScore {
  return scoreToolCallResponse(input);
}

export interface ToolCallingPromptFixture {
  name: string;
  prompt: string;
  expected: {
    should_call: boolean;
    tool?: string;
    args_predicate?: ArgsPredicate;
  };
}

export interface ToolCallingResult {
  prompts: Array<ToolCallingPromptFixture & { score: ToolCallScore }>;
  tool_call_score: number;
}

export async function runToolCalling(url: string): Promise<ToolCallingResult> {
  const tools = toolsRaw as ToolDef[];
  const prompts = promptsRaw as ToolCallingPromptFixture[];
  const scored: Array<ToolCallingPromptFixture & { score: ToolCallScore }> = [];
  for (const prompt of prompts) {
    const req = buildCompletionRequest({
      messages: [{ role: 'user', content: prompt.prompt }],
      maxTokens: 128,
      tools,
    });
    const { resp } = await completeChat(url, req);
    const score = scoreToolCallResponse({
      shouldCall: prompt.expected.should_call,
      expectedTool: prompt.expected.tool ?? null,
      expectedArgsPredicate: prompt.expected.args_predicate ?? null,
      response: toResponse(resp),
    });
    scored.push({ ...prompt, score });
  }
  const tool_call_score = scored.reduce((sum, item) => sum + item.score.score, 0) / scored.length;
  return { prompts: scored, tool_call_score };
}
