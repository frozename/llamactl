const PING_INTERVAL_MS = 15_000;

let unknownEventTotal = 0;

function normalizeFinishReason(
  finishReason: string | null | undefined,
): "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" {
  switch (finishReason) {
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
  return `msg_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
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
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      let messageStarted = false;
      let messageId = ctx.requestId ?? generateMessageId();
      let openBlock: OpenBlockState | null = null;
      let textBlockCount = 0;
      const toolIndexMap = new Map<number, number>();

      let lastFinishReason: string | null = null;
      let lastStopSequence: string | null = null;

      let outputTokens = 0;
      let sawUsageCompletionTokens = false;

      const emit = (event: string, payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
      };

      const ensureMessageStart = () => {
        if (messageStarted) return;
        messageStarted = true;
        emit("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            content: [],
            model: ctx.model,
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
            },
          },
        });
      };

      const closeOpenBlock = () => {
        if (!openBlock) return;
        emit("content_block_stop", {
          type: "content_block_stop",
          index: openBlock.index,
        });
        openBlock = null;
      };

      const ensureTextBlock = () => {
        if (openBlock?.kind === "text") return openBlock;
        closeOpenBlock();
        ensureMessageStart();
        const index = textBlockCount;
        textBlockCount += 1;
        openBlock = { kind: "text", index };
        emit("content_block_start", {
          type: "content_block_start",
          index,
          content_block: {
            type: "text",
            text: "",
          },
        });
        return openBlock;
      };

      const toolBlockIndex = (toolIndex: number): number => {
        const existing = toolIndexMap.get(toolIndex);
        if (existing !== undefined) return existing;
        const computed = toolIndex + textBlockCount;
        toolIndexMap.set(toolIndex, computed);
        return computed;
      };

      const ensureToolBlock = (tool: UpstreamToolCall) => {
        const rawToolIndex = typeof tool.index === "number" ? tool.index : 0;
        const index = toolBlockIndex(rawToolIndex);
        const toolId = tool.id ?? `tool_${rawToolIndex}`;
        const toolName = tool.function?.name ?? `tool_${rawToolIndex}`;

        if (
          openBlock?.kind === "tool" &&
          openBlock.toolIndex === rawToolIndex &&
          openBlock.index === index
        ) {
          if (!openBlock.toolId && toolId) openBlock.toolId = toolId;
          if (!openBlock.toolName && toolName) openBlock.toolName = toolName;
          return openBlock;
        }

        closeOpenBlock();
        ensureMessageStart();
        openBlock = {
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
        return openBlock;
      };

      const emitMessageStop = () => {
        emit("message_stop", { type: "message_stop" });
      };

      const emitTerminalDelta = (stopReason: string | null | undefined) => {
        ensureMessageStart();
        closeOpenBlock();
        const normalized = normalizeFinishReason(stopReason);
        emit("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: normalized,
            stop_sequence: normalized === "stop_sequence" ? (lastStopSequence ?? null) : null,
          },
          usage: {
            output_tokens: outputTokens,
          },
        });
      };

      const addOutputEmission = () => {
        if (!sawUsageCompletionTokens) outputTokens += 1;
      };

      const handleChunk = (parsed: UpstreamChunk) => {
        if (parsed.id) messageId = parsed.id;
        const usageTokens = parsed.usage?.completion_tokens;
        if (typeof usageTokens === "number" && Number.isFinite(usageTokens)) {
          sawUsageCompletionTokens = true;
          outputTokens = usageTokens;
        }

        const choice = parsed.choices?.[0];
        if (!choice) return;

        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          lastFinishReason = choice.finish_reason;
        }
        if (choice.stop_sequence !== undefined && choice.stop_sequence !== null) {
          lastStopSequence = choice.stop_sequence;
        }

        const content = choice.delta?.content;
        if (typeof content === "string" && content.length > 0) {
          const block = ensureTextBlock();
          emit("content_block_delta", {
            type: "content_block_delta",
            index: block.index,
            delta: {
              type: "text_delta",
              text: content,
            },
          });
          addOutputEmission();
        }

        const toolCalls = choice.delta?.tool_calls;
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          for (const toolCall of toolCalls) {
            const block = ensureToolBlock(toolCall);
            const partialJson = toolCall.function?.arguments;
            if (typeof partialJson === "string" && partialJson.length > 0) {
              emit("content_block_delta", {
                type: "content_block_delta",
                index: block.index,
                delta: {
                  type: "input_json_delta",
                  partial_json: partialJson,
                },
              });
              addOutputEmission();
            }
          }
        }
      };

      const processEvent = (eventPayload: string): "continue" | "done" => {
        if (eventPayload.trim().length === 0) return "continue";

        const { data, unknownLineCount } = __parseAnthropicSseEventPayloadForTests(eventPayload);
        unknownEventTotal += unknownLineCount;
        if (data === null) return "continue";
        if (data === "[DONE]") {
          emitTerminalDelta(lastFinishReason);
          emitMessageStop();
          controller.close();
          return "done";
        }

        let parsed: UpstreamChunk;
        try {
          parsed = JSON.parse(data) as UpstreamChunk;
        } catch {
          unknownEventTotal += 1;
          return "continue";
        }

        handleChunk(parsed);
        return "continue";
      };

      try {
        let done = false;
        let pendingRead: ReturnType<typeof reader.read> | null = reader.read();

        while (!done && pendingRead) {
          const readResult = await Promise.race([
            pendingRead.then((value) => ({ kind: "read" as const, value })),
            new Promise<{ kind: "ping" }>((resolve) => {
              setTimeout(() => resolve({ kind: "ping" }), PING_INTERVAL_MS);
            }),
          ]);

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

          if (value) {
            buffer += decoder
              .decode(value, { stream: true })
              .replace(/\r\n/g, "\n")
              .replace(/\r/g, "\n");
          }

          pendingRead = reader.read();

          while (true) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary === -1) break;
            const eventPayload = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const status = processEvent(eventPayload);
            if (status === "done") {
              done = true;
              break;
            }
          }
        }

        if (!done) {
          if (buffer.trim().length > 0) {
            processEvent(buffer);
          }
          if (!done) {
            emitTerminalDelta(lastFinishReason);
            emitMessageStop();
            controller.close();
          }
        }
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "anthropic_stream_upstream_error",
            error_class: maybeErrorClass(error),
          }),
        );
        emitTerminalDelta("stop");
        emitMessageStop();
        controller.close();
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    },
  });
}
