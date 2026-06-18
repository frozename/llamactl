import { expect, spyOn, test } from "bun:test";

import {
  __parseAnthropicSseEventPayloadForTests,
  __resetTranslatorUnknownEventTotalForTests,
  translateOpenAIStreamToAnthropic,
  translator_unknown_event_total,
} from "../src/anthropic/translateStream.js";

type ParsedEvent = {
  event: string;
  data: Record<string, unknown>;
};

const encoder = new TextEncoder();

function makeSseStream(events: string[], options?: { crash?: Error }): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      if (options?.crash) {
        controller.error(options.crash);
        return;
      }
      controller.close();
    },
  });
}

async function readStreamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let chunk = await reader.read();
  while (!chunk.done) {
    out += decoder.decode(chunk.value, { stream: true });
    chunk = await reader.read();
  }
  out += decoder.decode();
  return out;
}

function parseAnthropicSse(text: string): ParsedEvent[] {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const frames = normalized.split("\n\n").filter((frame) => frame.trim().length > 0);
  return frames.map((frame) => {
    const lines = frame.split("\n");
    const eventLine = lines.find((line) => line.startsWith("event: "));
    const dataLines = lines
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6));
    if (!eventLine || dataLines.length === 0) {
      throw new Error(`invalid frame: ${frame}`);
    }
    return {
      event: eventLine.slice(7),
      data: JSON.parse(dataLines.join("\n")) as Record<string, unknown>,
    };
  });
}

function numericEventIndex(event: ParsedEvent): number {
  const index = event.data.index;
  if (typeof index !== "number") {
    throw new Error(`${event.event} missing numeric index`);
  }
  return index;
}

function applyContentBlockEvent(open: Map<number, boolean>, event: ParsedEvent): void {
  if (event.event === "content_block_start") {
    const index = numericEventIndex(event);
    if (open.get(index)) throw new Error(`content block index already open: ${String(index)}`);
    open.set(index, true);
    return;
  }

  if (event.event === "content_block_delta") {
    const index = numericEventIndex(event);
    if (!open.get(index)) throw new Error(`delta outside open block: ${String(index)}`);
    return;
  }

  if (event.event === "content_block_stop") {
    const index = numericEventIndex(event);
    if (!open.get(index)) throw new Error(`stop outside open block: ${String(index)}`);
    open.delete(index);
  }
}

function assertContentBlockDeltaInvariant(events: ParsedEvent[]): void {
  const open = new Map<number, boolean>();
  for (const event of events) {
    applyContentBlockEvent(open, event);
  }

  if (open.size > 0) {
    throw new Error(`unterminated content blocks: ${[...open.keys()].join(",")}`);
  }
}

function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomChunkBoundaries(length: number, random: () => number): number[] {
  const maxCuts = Math.min(8, Math.max(1, length - 1));
  const cutCount = Math.max(1, Math.floor(random() * maxCuts));
  const cuts = new Set<number>();
  while (cuts.size < cutCount) {
    const point = 1 + Math.floor(random() * (length - 1));
    cuts.add(point);
  }
  return [...cuts].sort((a, b) => a - b);
}

function chunkString(source: string, boundaries: number[]): string[] {
  const out: string[] = [];
  let start = 0;
  for (const boundary of boundaries) {
    out.push(source.slice(start, boundary));
    start = boundary;
  }
  out.push(source.slice(start));
  return out.filter((part) => part.length > 0);
}

test("basic text streaming translates to anthropic SSE sequence", async () => {
  const upstream = makeSseStream([
    'data: {"id":"msg_1","choices":[{"delta":{"content":"Hello"},"finish_reason":null}],"usage":{"completion_tokens":1}}\n\n',
    'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}],"usage":{"completion_tokens":2}}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":2}}\n\n',
    "data: [DONE]\n\n",
  ]);

  const translated = translateOpenAIStreamToAnthropic(upstream, { model: "claude-3-7-sonnet" });
  const events = parseAnthropicSse(await readStreamText(translated));

  expect(events.map((event) => event.event)).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);

  expect(events[0]!.data.message).toMatchObject({ id: "msg_1", model: "claude-3-7-sonnet" });
  expect(events[1]!.data).toMatchObject({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text" },
  });
  expect(events[2]!.data).toMatchObject({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Hello" },
  });
  expect(events[3]!.data).toMatchObject({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: " world" },
  });
  expect(events[5]!.data).toMatchObject({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
  });
});

test("tool-call streaming emits tool_use block with input_json_delta pieces", async () => {
  const upstream = makeSseStream([
    'data: {"id":"msg_tool","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"foo"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"x\\""}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"completion_tokens":2}}\n\n',
    "data: [DONE]\n\n",
  ]);

  const translated = translateOpenAIStreamToAnthropic(upstream, { model: "claude-3-7-sonnet" });
  const events = parseAnthropicSse(await readStreamText(translated));

  expect(events.map((event) => event.event)).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);

  expect(events[1]!.data).toMatchObject({
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "tool_use",
      id: "call_1",
      name: "foo",
      input: {},
    },
  });

  expect(events[2]!.data).toMatchObject({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"x"' },
  });
  expect(events[3]!.data).toMatchObject({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: ":1}" },
  });
  expect(events[5]!.data).toMatchObject({
    delta: { stop_reason: "tool_use" },
  });
});

test("mixed text and tool streaming closes text block before opening tool block", async () => {
  const upstream = makeSseStream([
    'data: {"id":"msg_mix","choices":[{"delta":{"content":"Prep "},"finish_reason":null}],"usage":{"completion_tokens":1}}\n\n',
    'data: {"choices":[{"delta":{"content":"tool"},"finish_reason":null}],"usage":{"completion_tokens":2}}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_2","function":{"name":"do_it","arguments":"{\\"a\\":1}"}}]},"finish_reason":null}],"usage":{"completion_tokens":3}}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"completion_tokens":3}}\n\n',
    "data: [DONE]\n\n",
  ]);

  const translated = translateOpenAIStreamToAnthropic(upstream, { model: "claude-3-7-sonnet" });
  const events = parseAnthropicSse(await readStreamText(translated));

  expect(events.map((event) => event.event)).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);

  expect(events[1]!.data).toMatchObject({ index: 0, content_block: { type: "text" } });
  expect(events[5]!.data).toMatchObject({
    index: 1,
    content_block: { type: "tool_use", id: "call_2", name: "do_it" },
  });
});

function contentBlockStartIndices(events: ParsedEvent[]): number[] {
  return events
    .filter((event) => event.event === "content_block_start")
    .map((event) => numericEventIndex(event));
}

test("tool-call before text assigns unique monotonic content-block indices", async () => {
  // Upstream emits the tool_call FIRST, then assistant text. The tool must land
  // at content index 0 and the later text at index 1 — they must NOT collide on
  // the same index, which would let an index-keyed client overwrite the
  // tool_use block's input_json with the text.
  const upstream = makeSseStream([
    'data: {"id":"msg_tt","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_first","function":{"name":"do_it","arguments":"{\\"a\\":1}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}],"usage":{"completion_tokens":1}}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"completion_tokens":2}}\n\n',
    "data: [DONE]\n\n",
  ]);

  const translated = translateOpenAIStreamToAnthropic(upstream, { model: "claude-3-7-sonnet" });
  const events = parseAnthropicSse(await readStreamText(translated));

  // No two content_block_start events may share an index, and they must be a
  // contiguous monotonic 0,1,... sequence (positions in the final content[]).
  const startIndices = contentBlockStartIndices(events);
  expect(new Set(startIndices).size).toBe(startIndices.length);
  expect(startIndices).toEqual([0, 1]);

  // The tool opened first → index 0; the text opened second → index 1.
  const toolStart = events.find(
    (event) =>
      event.event === "content_block_start" &&
      (event.data.content_block as { type?: string }).type === "tool_use",
  );
  const textStart = events.find(
    (event) =>
      event.event === "content_block_start" &&
      (event.data.content_block as { type?: string }).type === "text",
  );
  expect(toolStart!.data).toMatchObject({
    index: 0,
    content_block: { type: "tool_use", id: "call_first", name: "do_it" },
  });
  expect(textStart!.data).toMatchObject({ index: 1, content_block: { type: "text" } });

  // The whole stream still satisfies the open/close pairing invariant.
  assertContentBlockDeltaInvariant(events);
});

test("text before tool (regression) still yields text@0, tool@1", async () => {
  const upstream = makeSseStream([
    'data: {"id":"msg_rt","choices":[{"delta":{"content":"hello"},"finish_reason":null}],"usage":{"completion_tokens":1}}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_after","function":{"name":"do_it","arguments":"{\\"a\\":1}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"completion_tokens":2}}\n\n',
    "data: [DONE]\n\n",
  ]);

  const translated = translateOpenAIStreamToAnthropic(upstream, { model: "claude-3-7-sonnet" });
  const events = parseAnthropicSse(await readStreamText(translated));

  expect(contentBlockStartIndices(events)).toEqual([0, 1]);

  const textStart = events.find(
    (event) =>
      event.event === "content_block_start" &&
      (event.data.content_block as { type?: string }).type === "text",
  );
  const toolStart = events.find(
    (event) =>
      event.event === "content_block_start" &&
      (event.data.content_block as { type?: string }).type === "tool_use",
  );
  expect(textStart!.data).toMatchObject({ index: 0, content_block: { type: "text" } });
  expect(toolStart!.data).toMatchObject({
    index: 1,
    content_block: { type: "tool_use", id: "call_after", name: "do_it" },
  });
});

test("two tool calls with no text get distinct blocks @0 and @1", async () => {
  const upstream = makeSseStream([
    'data: {"id":"msg_2t","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"alpha","arguments":"{\\"x\\":1}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"beta","arguments":"{\\"y\\":2}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"completion_tokens":2}}\n\n',
    "data: [DONE]\n\n",
  ]);

  const translated = translateOpenAIStreamToAnthropic(upstream, { model: "claude-3-7-sonnet" });
  const events = parseAnthropicSse(await readStreamText(translated));

  const startIndices = contentBlockStartIndices(events);
  expect(new Set(startIndices).size).toBe(startIndices.length);
  expect(startIndices).toEqual([0, 1]);

  const starts = events.filter((event) => event.event === "content_block_start");
  expect(starts[0]!.data).toMatchObject({
    index: 0,
    content_block: { type: "tool_use", id: "call_a", name: "alpha" },
  });
  expect(starts[1]!.data).toMatchObject({
    index: 1,
    content_block: { type: "tool_use", id: "call_b", name: "beta" },
  });
});

test("state invariant: content_block_delta always appears inside a matching open/close pair", async () => {
  const fixtures = [
    [
      'data: {"id":"msg_i1","choices":[{"delta":{"content":"a"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"b"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ],
    [
      'data: {"id":"msg_i2","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"f","arguments":"{\\"x\\""}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ],
    [
      'data: {"id":"msg_i3","choices":[{"delta":{"content":"text"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"g","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ],
  ];

  for (const fixture of fixtures) {
    const translated = translateOpenAIStreamToAnthropic(makeSseStream(fixture), {
      model: "claude-3-7-sonnet",
    });
    const events = parseAnthropicSse(await readStreamText(translated));
    assertContentBlockDeltaInvariant(events);
  }
});

test("fuzz: fragmented tool argument JSON reconstructs exactly for 20 seeds", async () => {
  const sourceJson = JSON.stringify({
    city: "Sao Paulo",
    count: 1,
    nested: { key: "value", ok: true },
  });

  for (let seed = 1; seed <= 20; seed += 1) {
    const random = seededRng(seed);
    const boundaries = randomChunkBoundaries(sourceJson.length, random);
    const parts = chunkString(sourceJson, boundaries);

    const sseEvents = [
      `data: ${JSON.stringify({
        id: `msg_fuzz_${String(seed)}`,
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_fuzz",
                  function: { name: "fuzz_tool", arguments: parts[0] ?? "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`,
      ...parts.slice(1).map(
        (part) =>
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { arguments: part },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
      ),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n",
    ];

    const translated = translateOpenAIStreamToAnthropic(makeSseStream(sseEvents), {
      model: "claude-3-7-sonnet",
    });
    const events = parseAnthropicSse(await readStreamText(translated));

    const partials = events
      .filter((event) => event.event === "content_block_delta")
      .map((event) => (event.data.delta as { partial_json?: string }).partial_json ?? "")
      .join("");

    expect(JSON.parse(partials)).toEqual(JSON.parse(sourceJson));
  }
});

test("unknown upstream SSE data increments counter but stream still terminates cleanly", async () => {
  __resetTranslatorUnknownEventTotalForTests();
  const upstream = makeSseStream([
    'data: {"id":"msg_u","choices":[{"delta":{"content":"hi"},"finish_reason":null}],"usage":{"completion_tokens":1}}\n\n',
    "data: this is not json\n\n",
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":1}}\n\n',
    "data: [DONE]\n\n",
  ]);

  const translated = translateOpenAIStreamToAnthropic(upstream, { model: "claude-3-7-sonnet" });
  const events = parseAnthropicSse(await readStreamText(translated));

  expect(translator_unknown_event_total()).toBe(1);
  expect(events.at(-2)?.event).toBe("message_delta");
  expect(events.at(-1)?.event).toBe("message_stop");
});

test("named event with valid data is translated and does not increment unknown counter", async () => {
  __resetTranslatorUnknownEventTotalForTests();
  const upstream = makeSseStream([
    'event: message\ndata: {"id":"msg_named","choices":[{"delta":{"content":"hi"},"finish_reason":null}],"usage":{"completion_tokens":1}}\n\n',
    "data: [DONE]\n\n",
  ]);

  const translated = translateOpenAIStreamToAnthropic(upstream, { model: "claude-3-7-sonnet" });
  const events = parseAnthropicSse(await readStreamText(translated));

  expect(translator_unknown_event_total()).toBe(0);
  expect(events.map((event) => event.event)).toContain("content_block_delta");
  expect(events.at(-1)?.event).toBe("message_stop");
});

test("multiple data lines in one event are concatenated with newlines", () => {
  const parsed = __parseAnthropicSseEventPayloadForTests("data: line1\ndata: line2\n\n");

  expect(parsed.unknownLineCount).toBe(0);
  expect(parsed.data).toBe("line1\nline2");
});

test("id and retry lines are ignored while translating valid data", async () => {
  __resetTranslatorUnknownEventTotalForTests();
  const upstream = makeSseStream([
    'event: foo\nid: abc\nretry: 5000\ndata: {"id":"msg_meta","choices":[{"delta":{"content":"hi"},"finish_reason":null}],"usage":{"completion_tokens":1}}\n\n',
    "data: [DONE]\n\n",
  ]);

  const translated = translateOpenAIStreamToAnthropic(upstream, { model: "claude-3-7-sonnet" });
  const events = parseAnthropicSse(await readStreamText(translated));

  expect(translator_unknown_event_total()).toBe(0);
  expect(events.map((event) => event.event)).toContain("content_block_delta");
});

test("comment lines are ignored while translating valid data", async () => {
  __resetTranslatorUnknownEventTotalForTests();
  const upstream = makeSseStream([
    ': this is a comment\ndata: {"id":"msg_comment","choices":[{"delta":{"content":"hi"},"finish_reason":null}],"usage":{"completion_tokens":1}}\n\n',
    "data: [DONE]\n\n",
  ]);

  const translated = translateOpenAIStreamToAnthropic(upstream, { model: "claude-3-7-sonnet" });
  const events = parseAnthropicSse(await readStreamText(translated));

  expect(translator_unknown_event_total()).toBe(0);
  expect(events.map((event) => event.event)).toContain("content_block_delta");
});

test("unknown line increments counter but does not suppress valid data", async () => {
  __resetTranslatorUnknownEventTotalForTests();
  const upstream = makeSseStream([
    'garbage: x\ndata: {"id":"msg_unknown_line","choices":[{"delta":{"content":"hi"},"finish_reason":null}],"usage":{"completion_tokens":1}}\n\n',
    "data: [DONE]\n\n",
  ]);

  const translated = translateOpenAIStreamToAnthropic(upstream, { model: "claude-3-7-sonnet" });
  const events = parseAnthropicSse(await readStreamText(translated));

  expect(translator_unknown_event_total()).toBe(1);
  expect(events.map((event) => event.event)).toContain("content_block_delta");
});

test("upstream mid-stream error emits clean terminal message_delta + message_stop", async () => {
  let emitted = false;
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller): void {
      if (!emitted) {
        emitted = true;
        controller.enqueue(
          encoder.encode(
            'data: {"id":"msg_err","choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
          ),
        );
        return;
      }
      controller.error(new Error("stream exploded"));
    },
  });

  const translated = translateOpenAIStreamToAnthropic(upstream, { model: "claude-3-7-sonnet" });
  const events = parseAnthropicSse(await readStreamText(translated));

  expect(events.map((event) => event.event)).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);

  expect(events[4]!.data).toMatchObject({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 1 },
  });
});

test("ping timer is cleared each read iteration (no per-chunk setTimeout leak)", async () => {
  // Drive several chunks that resolve immediately so the READ arm of the
  // Promise.race wins every loop iteration and the 15s ping never fires.
  // Each iteration creates a ping setTimeout(15000); the leak is that the
  // handle is never cleared when the read arm wins. Pin it: every ping timer
  // id returned by setTimeout must be passed to clearTimeout.
  const PING_DELAY_MS = 15_000;

  const pingTimerIds: unknown[] = [];
  const clearedIds = new Set<unknown>();

  const realSetTimeout = globalThis.setTimeout.bind(globalThis);
  const realClearTimeout = globalThis.clearTimeout.bind(globalThis);

  const setTimeoutSpy = spyOn(globalThis, "setTimeout");
  setTimeoutSpy.mockImplementation(((handler: () => void, timeout?: number, ...args: unknown[]) => {
    const id = realSetTimeout(handler, timeout, ...args);
    if (timeout === PING_DELAY_MS) {
      pingTimerIds.push(id);
    }
    return id;
  }) as unknown as typeof setTimeout);

  const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
  clearTimeoutSpy.mockImplementation(((id?: Parameters<typeof clearTimeout>[0]) => {
    clearedIds.add(id);
    realClearTimeout(id);
  }) as unknown as typeof clearTimeout);

  try {
    const upstream = makeSseStream([
      'data: {"id":"msg_p","choices":[{"delta":{"content":"a"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"b"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"c"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":3}}\n\n',
      "data: [DONE]\n\n",
    ]);

    const translated = translateOpenAIStreamToAnthropic(upstream, { model: "claude-3-7-sonnet" });
    await readStreamText(translated);
  } finally {
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  }

  // At least one ping timer was created per read iteration.
  expect(pingTimerIds.length).toBeGreaterThan(0);
  // Every ping timer must have been cleared — pre-fix none are, so this is RED.
  const leaked = pingTimerIds.filter((id) => !clearedIds.has(id));
  expect(leaked).toEqual([]);
});
