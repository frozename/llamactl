import { expect, test } from "bun:test";

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
    start(controller) {
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
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
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

function assertContentBlockDeltaInvariant(events: ParsedEvent[]): void {
  const open = new Map<number, boolean>();
  for (const event of events) {
    if (event.event === "content_block_start") {
      const index = event.data.index;
      if (typeof index !== "number") throw new Error("content_block_start missing numeric index");
      if (open.get(index)) throw new Error(`content block index already open: ${index}`);
      open.set(index, true);
      continue;
    }

    if (event.event === "content_block_delta") {
      const index = event.data.index;
      if (typeof index !== "number") throw new Error("content_block_delta missing numeric index");
      if (!open.get(index)) throw new Error(`delta outside open block: ${index}`);
      continue;
    }

    if (event.event === "content_block_stop") {
      const index = event.data.index;
      if (typeof index !== "number") throw new Error("content_block_stop missing numeric index");
      if (!open.get(index)) throw new Error(`stop outside open block: ${index}`);
      open.delete(index);
    }
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
        id: `msg_fuzz_${seed}`,
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
      .map((event) => (event.data.delta as { partial_json?: string })?.partial_json ?? "")
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

test("multiple data lines in one event are concatenated with newlines", async () => {
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
    pull(controller) {
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
