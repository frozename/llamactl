const PING_INTERVAL_MS = 15_000;

let unknownEventTotal = 0;

function normalizeFinishReason(
  finishReason: string | null | undefined,
): "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" {
  switch (finishReason) {
    case undefined:
    case null:
      return "end_turn";
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

function maybeErrorClass(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  if (typeof error === "object" && error !== null && "constructor" in error) {
    const ctor = (error as { constructor?: { name?: string } }).constructor;
    if (ctor?.name) return ctor.name;
  }
  return typeof error;
}

function generateMessageId(): string {
  if ("randomUUID" in crypto && typeof crypto.randomUUID === "function") {
    return `msg_${crypto.randomUUID()}`;
  }
  return `msg_${String(Date.now())}_${String(Math.floor(Math.random() * 1_000_000))}`;
}

type UpstreamToolCall = {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type UpstreamChoice = {
  finish_reason?: string | null;
  stop_sequence?: string | null;
  delta?: {
    content?: string;
    tool_calls?: UpstreamToolCall[];
  };
};

type UpstreamChunk = {
  id?: string;
  usage?: {
    completion_tokens?: number;
  };
  choices?: UpstreamChoice[];
};

type TranslatorContext = {
  model: string;
  requestId?: string;
};

type OpenBlockState =
  | {
      kind: "text";
      index: number;
    }
  | {
      kind: "tool";
      index: number;
      toolIndex: number;
      toolId: string;
      toolName: string;
    };

type StreamState = {
  messageStarted: boolean;
  messageId: string;
  model: string;
  openBlock: OpenBlockState | null;
  textBlockCount: number;
  toolIndexMap: Map<number, number>;
  lastFinishReason: string | null;
  lastStopSequence: string | null;
  outputTokens: number;
  sawUsageCompletionTokens: boolean;
};

type StreamEmit = (event: string, payload: Record<string, unknown>) => void;

function createStreamState(ctx: TranslatorContext): StreamState {
  return {
    messageStarted: false,
    messageId: ctx.requestId ?? generateMessageId(),
    model: ctx.model,
    openBlock: null,
    textBlockCount: 0,
    toolIndexMap: new Map(),
    lastFinishReason: null,
    lastStopSequence: null,
    outputTokens: 0,
    sawUsageCompletionTokens: false,
  };
}

function ensureMessageStart(state: StreamState, emit: StreamEmit): void {
  if (state.messageStarted) return;
  state.messageStarted = true;
  emit("message_start", {
    type: "message_start",
    message: {
      id: state.messageId,
      type: "message",
      role: "assistant",
      content: [],
      model: state.model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  });
}

function closeOpenBlock(state: StreamState, emit: StreamEmit): void {
  if (!state.openBlock) return;
  emit("content_block_stop", {
    type: "content_block_stop",
    index: state.openBlock.index,
  });
  state.openBlock = null;
}

function ensureTextBlock(
  state: StreamState,
  emit: StreamEmit,
): Extract<OpenBlockState, { kind: "text" }> {
  if (state.openBlock?.kind === "text") return state.openBlock;
  closeOpenBlock(state, emit);
  ensureMessageStart(state, emit);
  const index = state.textBlockCount;
  state.textBlockCount += 1;
  state.openBlock = { kind: "text", index };
  emit("content_block_start", {
    type: "content_block_start",
    index,
    content_block: {
      type: "text",
      text: "",
    },
  });
  return state.openBlock;
}

function computeToolBlockIndex(state: StreamState, toolIndex: number): number {
  const existing = state.toolIndexMap.get(toolIndex);
  if (existing !== undefined) return existing;
  const computed = toolIndex + state.textBlockCount;
  state.toolIndexMap.set(toolIndex, computed);
  return computed;
}

function ensureToolBlock(
  state: StreamState,
  tool: UpstreamToolCall,
  emit: StreamEmit,
): Extract<OpenBlockState, { kind: "tool" }> {
  const rawToolIndex = typeof tool.index === "number" ? tool.index : 0;
  const index = computeToolBlockIndex(state, rawToolIndex);
  const toolId = tool.id ?? `tool_${String(rawToolIndex)}`;
  const toolName = tool.function?.name ?? `tool_${String(rawToolIndex)}`;

  if (
    state.openBlock?.kind === "tool" &&
    state.openBlock.toolIndex === rawToolIndex &&
    state.openBlock.index === index
  ) {
    if (!state.openBlock.toolId && toolId) state.openBlock.toolId = toolId;
    if (!state.openBlock.toolName && toolName) state.openBlock.toolName = toolName;
    return state.openBlock;
  }

  closeOpenBlock(state, emit);
  ensureMessageStart(state, emit);
  state.openBlock = {
    kind: "tool",
    index,
    toolIndex: rawToolIndex,
    toolId,
    toolName,
  };
  emit("content_block_start", {
    type: "content_block_start",
    index,
    content_block: {
      type: "tool_use",
      id: toolId,
      name: toolName,
      input: {},
    },
  });
  return state.openBlock;
}

function addOutputEmission(state: StreamState): void {
  if (!state.sawUsageCompletionTokens) state.outputTokens += 1;
}

function applyUsage(state: StreamState, parsed: UpstreamChunk): void {
  const usageTokens = parsed.usage?.completion_tokens;
  if (typeof usageTokens === "number" && Number.isFinite(usageTokens)) {
    state.sawUsageCompletionTokens = true;
    state.outputTokens = usageTokens;
  }
}

function recordStopMetadata(state: StreamState, choice: UpstreamChoice): void {
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    state.lastFinishReason = choice.finish_reason;
  }
  if (choice.stop_sequence !== undefined && choice.stop_sequence !== null) {
    state.lastStopSequence = choice.stop_sequence;
  }
}

function emitTextDelta(state: StreamState, content: string | undefined, emit: StreamEmit): void {
  if (typeof content !== "string" || content.length === 0) return;
  const block = ensureTextBlock(state, emit);
  emit("content_block_delta", {
    type: "content_block_delta",
    index: block.index,
    delta: {
      type: "text_delta",
      text: content,
    },
  });
  addOutputEmission(state);
}

function emitToolCallDeltas(
  state: StreamState,
  toolCalls: UpstreamToolCall[] | undefined,
  emit: StreamEmit,
): void {
  if (!Array.isArray(toolCalls)) return;
  for (const toolCall of toolCalls) {
    const block = ensureToolBlock(state, toolCall, emit);
    const partialJson = toolCall.function?.arguments;
    if (typeof partialJson !== "string" || partialJson.length === 0) continue;
    emit("content_block_delta", {
      type: "content_block_delta",
      index: block.index,
      delta: {
        type: "input_json_delta",
        partial_json: partialJson,
      },
    });
    addOutputEmission(state);
  }
}

function handleChunk(state: StreamState, parsed: UpstreamChunk, emit: StreamEmit): void {
  if (parsed.id) state.messageId = parsed.id;
  applyUsage(state, parsed);

  const choice = parsed.choices?.[0];
  if (!choice) return;

  recordStopMetadata(state, choice);
  emitTextDelta(state, choice.delta?.content, emit);
  emitToolCallDeltas(state, choice.delta?.tool_calls, emit);
}

function processEvent(
  state: StreamState,
  eventPayload: string,
  emit: StreamEmit,
): "continue" | "done" {
  if (eventPayload.trim().length === 0) return "continue";

  const { data, unknownLineCount } = __parseAnthropicSseEventPayloadForTests(eventPayload);
  unknownEventTotal += unknownLineCount;
  if (data === null) return "continue";
  if (data === "[DONE]") {
    return "done";
  }

  let parsed: UpstreamChunk;
  try {
    parsed = JSON.parse(data) as UpstreamChunk;
  } catch {
    unknownEventTotal += 1;
    return "continue";
  }

  handleChunk(state, parsed, emit);
  return "continue";
}

function emitTerminalDelta(
  state: StreamState,
  emit: StreamEmit,
  stopReason: string | null | undefined,
): void {
  ensureMessageStart(state, emit);
  closeOpenBlock(state, emit);
  const normalized = normalizeFinishReason(stopReason);
  emit("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: normalized,
      stop_sequence: normalized === "stop_sequence" ? (state.lastStopSequence ?? null) : null,
    },
    usage: {
      output_tokens: state.outputTokens,
    },
  });
}

function emitMessageStop(emit: StreamEmit): void {
  emit("message_stop", { type: "message_stop" });
}

async function processUpstreamStream(
  upstream: ReadableStream<Uint8Array>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  ctx: TranslatorContext,
): Promise<void> {
  const encoder = new TextEncoder();
  const emit: StreamEmit = (event, payload) => {
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
  };

  const state = createStreamState(ctx);
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    let done = false;
    let pendingRead: ReturnType<typeof reader.read> | null = reader.read();

    while (!done) {
      let pingTimer: ReturnType<typeof setTimeout> | undefined;
      const pingPromise = new Promise<{ kind: "ping" }>((resolve) => {
        pingTimer = setTimeout(() => {
          resolve({ kind: "ping" });
        }, PING_INTERVAL_MS);
      });
      const readResult = await Promise.race([
        pendingRead.then((value) => ({ kind: "read" as const, value })),
        pingPromise,
      ]);
      clearTimeout(pingTimer);

      if (readResult.kind === "ping") {
        emit("ping", { type: "ping" });
        continue;
      }

      pendingRead = null;
      const { value, done: upstreamDone } = readResult.value;
      if (upstreamDone) {
        done = true;
        break;
      }

      buffer += decoder
        .decode(value, { stream: true })
        .replaceAll("\r\n", "\n")
        .replaceAll("\r", "\n");

      pendingRead = reader.read();

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const eventPayload = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const status = processEvent(state, eventPayload, emit);
        if (status === "done") {
          done = true;
          break;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }

    if (buffer.trim().length > 0) {
      processEvent(state, buffer, emit);
    }
    emitTerminalDelta(state, emit, state.lastFinishReason);
    emitMessageStop(emit);
    controller.close();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "anthropic_stream_upstream_error",
        error_class: maybeErrorClass(error),
      }),
    );
    emitTerminalDelta(state, emit, "stop");
    emitMessageStop(emit);
    controller.close();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function translator_unknown_event_total(): number {
  return unknownEventTotal;
}

export function __resetTranslatorUnknownEventTotalForTests(): void {
  unknownEventTotal = 0;
}

export function __parseAnthropicSseEventPayloadForTests(eventPayload: string): {
  data: string | null;
  unknownLineCount: number;
} {
  const lines = eventPayload.split("\n");
  const dataLines: string[] = [];
  let unknownLineCount = 0;

  for (const line of lines) {
    if (line.length === 0 || line.startsWith(":")) continue;

    if (line.startsWith("data:")) {
      const maybeSpace = line.slice(5);
      dataLines.push(maybeSpace.startsWith(" ") ? maybeSpace.slice(1) : maybeSpace);
      continue;
    }

    if (line.startsWith("event:") || line.startsWith("id:") || line.startsWith("retry:")) {
      continue;
    }

    unknownLineCount += 1;
  }

  return {
    data: dataLines.length > 0 ? dataLines.join("\n") : null,
    unknownLineCount,
  };
}

export function translateOpenAIStreamToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  ctx: TranslatorContext,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      await processUpstreamStream(upstream, controller, ctx);
    },
  });
}
