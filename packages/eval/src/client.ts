export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CompletionRequest {
  body: {
    model: string;
    messages: ChatMessage[];
    temperature: number;
    max_tokens: number;
    seed?: number;
    stream: false;
    tools?: ToolDef[];
    tool_choice?: unknown;
    response_format?: ResponseFormat;
    chat_template_kwargs?: Record<string, unknown>;
  };
}

export type ResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown> } };

export interface CompletionResponse {
  choices: {
    message: {
      content: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  timings?: {
    prompt_per_second?: number;
    predicted_per_second?: number;
    predicted_n?: number;
    prompt_n?: number;
  };
}

export function buildCompletionRequest(opts: {
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  seed?: number;
  tools?: ToolDef[];
  tool_choice?: unknown;
  response_format?: ResponseFormat;
  enableThinking?: boolean;
  /** Model id sent in the OpenAI request body. Defaults to 'local'
   *  (llama-server alias). For multi-model hosts (oMLX), pass the
   *  actual model id (e.g. directory basename). */
  model?: string;
}): CompletionRequest {
  return {
    body: {
      model: opts.model ?? "local",
      messages: opts.messages,
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens,
      seed: opts.seed,
      stream: false,
      ...(opts.tools ? { tools: opts.tools, tool_choice: opts.tool_choice ?? "auto" } : {}),
      ...(opts.response_format ? { response_format: opts.response_format } : {}),
      ...(opts.enableThinking === false
        ? { chat_template_kwargs: { enable_thinking: false } }
        : {}),
    },
  };
}

export async function completeChat(
  url: string,
  req: CompletionRequest,
): Promise<{ resp: CompletionResponse; wallMs: number }> {
  const t0 = performance.now();
  const r = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req.body),
  });
  if (!r.ok) {
    throw new Error(`HTTP ${String(r.status)}: ${await r.text()}`);
  }
  const resp = (await r.json()) as CompletionResponse;
  return { resp, wallMs: performance.now() - t0 };
}
