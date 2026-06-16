import type { WorkloadEval } from "../types.js";

import { RELIABILITY_GUARD, runCandidate } from "./code-exec.js";

export { runCandidate } from "./code-exec.js";

interface HumanEvalRow {
  task_id: string;
  prompt: string;
  canonical_solution: string;
  test: string;
  entry_point: string;
}

function definesEntryPoint(code: string, entryPoint: string): boolean {
  const lines = code.split("\n");
  for (const line of lines) {
    const trimmed = line.trimStart();
    const withoutAsync = trimmed.startsWith("async ") ? trimmed.slice(6).trimStart() : trimmed;
    if (withoutAsync.startsWith("def ")) {
      const rest = withoutAsync.slice(4).trimStart();
      if (rest.startsWith(entryPoint)) {
        const afterName = rest.slice(entryPoint.length).trimStart();
        if (afterName.startsWith("(")) {
          return true;
        }
      }
    }
  }
  return false;
}

function extractAllBlocks(completion: string, regex: RegExp): string[] {
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(completion)) !== null) {
    const content = match[1];
    if (content !== undefined) {
      blocks.push(content);
    }
  }
  return blocks;
}

function pickBestBlock(blocks: string[], entryPoint: string): string | null {
  if (blocks.length === 0) return null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block !== undefined && definesEntryPoint(block, entryPoint)) {
      return block;
    }
  }
  return blocks[blocks.length - 1] ?? null;
}

function extractFencedCode(completion: string, entryPoint: string): string | null {
  const pythonBlocks = extractAllBlocks(completion, /```(?:python|py)[^\n]*\n([\s\S]*?)```/gi);
  if (pythonBlocks.length > 0) {
    return pickBestBlock(pythonBlocks, entryPoint);
  }

  const genericBlocks = extractAllBlocks(completion, /```[^\n]*\n([\s\S]*?)```/g);
  if (genericBlocks.length > 0) {
    return pickBestBlock(genericBlocks, entryPoint);
  }

  const unclosedMatch = /```(?:python|py)?[^\n]*\n([\s\S]*)$/i.exec(completion);
  if (unclosedMatch) {
    return unclosedMatch[1] ?? "";
  }

  return null;
}

export function extractCode(completion: string, entryPoint: string, promptSource: string): string {
  const result = extractFencedCode(completion, entryPoint) ?? completion;
  if (definesEntryPoint(result, entryPoint)) {
    return result;
  }
  return `${promptSource}${result}`;
}

export function buildProgram(
  candidateSource: string,
  testSource: string,
  entryPoint: string,
): string {
  return `${RELIABILITY_GUARD}\n${candidateSource}\n\n${testSource}\n\ncheck(${entryPoint})\n`;
}

export const codeHumanevalWorkload: WorkloadEval = {
  name: "code-humaneval",
  corpus_path: "packages/eval/corpora/code-humaneval/v0/test.jsonl",
  primary_metric_name: "mean_pass_at_1",
  maxTokens: 1024,
  temperature: 0,
  prompt_builder: (row) => {
    const r = row as HumanEvalRow;
    return {
      messages: [
        {
          role: "system",
          content:
            "You are an expert Python programmer. Complete the given function. Respond with the complete Python function inside a single ```python code block and nothing else.",
        },
        { role: "user", content: `Complete this Python function:\n\n${r.prompt}` },
      ],
    };
  },
  scorer: async (row, completion) => {
    const r = row as HumanEvalRow;
    const code = extractCode(completion, r.entry_point, r.prompt);
    const program = buildProgram(code, r.test, r.entry_point);
    const result = await runCandidate(program);

    if (result.status === "error") {
      throw new Error(`code-humaneval sandbox error: ${result.detail ?? "unknown"}`);
    }

    return {
      prediction: result.status,
      gold: "pass",
      metrics: { pass: result.passed ? 1 : 0 },
    };
  },
};
