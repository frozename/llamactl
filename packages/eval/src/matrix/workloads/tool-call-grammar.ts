import type { WorkloadEval } from "../types.js";

interface CorpusRow {
  messages: Array<Record<string, unknown>>;
  tools?: unknown[];
  tool_choice?: string | object;
}

type ToolCall = {
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
};

export function __signature(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return "__no_tool_call__";
  }
  try {
    const signatures = toolCalls.map((tc) => {
      const call = tc as ToolCall;
      const name = typeof call.function?.name === "string" ? call.function.name : "";
      const parsedArgs =
        typeof call.function?.arguments === "string" && call.function.arguments.trim()
          ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
          : {};
      const argKeys = Object.keys(parsedArgs).sort();
      return [name, argKeys] as [string, string[]];
    });
    signatures.sort((a, b) => {
      const nameCmp = a[0].localeCompare(b[0]);
      if (nameCmp !== 0) return nameCmp;
      return a[1].join(",").localeCompare(b[1].join(","));
    });
    return JSON.stringify(signatures);
  } catch {
    return "__parse_error__";
  }
}

export const toolCallGrammarWorkload: WorkloadEval = {
  name: "tool-call-grammar",
  corpus_path: "packages/eval/corpora/tool-call-grammar/v0/test.jsonl",
  primary_metric_name: "mean_exact_match",
  prompt_builder: (row) => {
    const r = row as CorpusRow;
    return {
      messages: r.messages.slice(0, -1),
      tools: r.tools,
      tool_choice: r.tool_choice ?? "auto",
    };
  },
  scorer: (row, completion, meta) => {
    void completion;
    const r = row as CorpusRow;
    const goldTurn = r.messages[r.messages.length - 1] as Record<string, unknown> | undefined;
    const pred = __signature(meta?.tool_calls);
    const gold =
      goldTurn && "tool_calls" in goldTurn
        ? __signature((goldTurn as { tool_calls?: unknown }).tool_calls)
        : "__no_tool_call__";
    return {
      prediction: pred,
      gold,
      metrics: {
        exact_match: pred === gold ? 1 : 0,
      },
    };
  },
};
