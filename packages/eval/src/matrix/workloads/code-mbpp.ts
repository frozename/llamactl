import type { WorkloadEval } from "../types.js";

import { RELIABILITY_GUARD, runCandidate } from "./code-exec.js";

interface MbppRow {
  task_id: number;
  prompt: string;
  code: string;
  test_list: string[];
  test_imports: string[];
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

function lastBlock(blocks: string[]): string | null {
  return blocks[blocks.length - 1] ?? null;
}

export function extractMbppCode(completion: string): string {
  const pythonBlock = lastBlock(
    extractAllBlocks(completion, /```(?:python|py)[^\n]*\n([\s\S]*?)```/gi),
  );
  if (pythonBlock !== null) {
    return pythonBlock;
  }

  const genericBlock = lastBlock(extractAllBlocks(completion, /```[^\n]*\n([\s\S]*?)```/g));
  if (genericBlock !== null) {
    return genericBlock;
  }

  const unclosedMatch = /```(?:python|py)[^\n]*\n([\s\S]*)$/i.exec(completion);
  if (unclosedMatch) {
    return unclosedMatch[1] ?? "";
  }

  return completion;
}

export function buildMbppProgram(
  candidate: string,
  testImports: string[],
  testList: string[],
): string {
  return `${RELIABILITY_GUARD}\n${testImports.join("\n")}\n${candidate}\n\n${testList.join("\n")}\n`;
}

export const codeMbppWorkload: WorkloadEval = {
  name: "code-mbpp",
  corpus_path: "packages/eval/corpora/code-mbpp/v0/test.jsonl",
  primary_metric_name: "mean_pass_at_1",
  maxTokens: 1024,
  temperature: 0,
  prompt_builder: (row) => {
    const r = row as MbppRow;
    return {
      messages: [
        {
          role: "system",
          content:
            "You are an expert Python programmer. Complete the task. Respond with the complete Python solution inside a single ```python code block and nothing else.",
        },
        {
          role: "user",
          content: `${r.prompt}\n\nYour solution must pass these tests:\n${r.test_list.join("\n")}`,
        },
      ],
    };
  },
  scorer: async (row, completion) => {
    const r = row as MbppRow;
    const code = extractMbppCode(completion);
    const program = buildMbppProgram(code, r.test_imports, r.test_list);
    const result = await runCandidate(program);

    if (result.status === "error") {
      throw new Error(`code-mbpp sandbox error: ${result.detail ?? "unknown"}`);
    }

    return {
      prediction: result.status,
      gold: "pass",
      metrics: { pass: result.passed ? 1 : 0 },
    };
  },
};
