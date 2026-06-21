import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildChatRequestBody, callChat, loadGrammarFile } from "./run-bench";

describe("run-bench grammar wiring", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("buildChatRequestBody omits grammar when not provided", () => {
    const body = buildChatRequestBody("local", "hello");
    expect(body.grammar).toBeUndefined();
    expect(body.model).toBe("local");
  });

  test("buildChatRequestBody includes grammar when provided", () => {
    const body = buildChatRequestBody("local", "hello", 'root ::= "[]"');
    expect(body.grammar).toBe('root ::= "[]"');
  });

  test("loadGrammarFile rejects empty grammar content", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-bench-test-"));
    const emptyFile = join(dir, "empty.gbnf");
    writeFileSync(emptyFile, " \n\n\t  ");
    expect(() => loadGrammarFile(emptyFile)).toThrow(/empty grammar/i);
    rmSync(dir, { recursive: true, force: true });
  });

  test("callChat surfaces grammar unsupported errors clearly", async () => {
    globalThis.fetch = (async () => {
      return new Response("grammar not supported by backend", { status: 400 });
    }) as unknown as typeof fetch;

    await expect(
      callChat("http://127.0.0.1:18090", "local", "hi", 'root ::= "[]"'),
    ).rejects.toThrow(/grammar.*not supported/i);
  });
});
