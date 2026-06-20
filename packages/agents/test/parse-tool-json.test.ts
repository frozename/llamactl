import { describe, expect, test } from "bun:test";

import { parseToolJson } from "../src/index.js";

describe("parseToolJson", () => {
  test("parses valid JSON tool response", () => {
    const result = parseToolJson({ content: [{ type: "text", text: '{"ok":true}' }] });
    expect(result).toEqual({ ok: true });
  });

  test("surfaces raw text when tool returns non-JSON error content", () => {
    const rawError = "Internal server error: connection refused";
    const toolResult = { content: [{ type: "text", text: rawError }] };
    expect(() => parseToolJson(toolResult)).toThrow(rawError);
  });

  test("non-JSON error message is not a bare SyntaxError", () => {
    const rawError = "tool execution failed";
    const toolResult = { content: [{ type: "text", text: rawError }] };
    let thrown: unknown;
    try {
      parseToolJson(toolResult);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toMatch(/^Unexpected token/);
    expect((thrown as Error).message).toContain(rawError);
  });

  test("returns null sentinel when content is empty", () => {
    const result = parseToolJson({ content: [] });
    expect(result).toBeNull();
  });
});
