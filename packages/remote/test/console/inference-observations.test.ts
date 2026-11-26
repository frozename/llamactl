import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONSOLE_ALLOWLIST } from "../../src/console/allowlist.js";
import { mkdirSync, mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { parseInferenceRuns } from "../../src/workload/inference-observations.js";
import {
  parseKapitsaCompletion,
  parseKapitsaStatus,
  readKapitsaObservation,
} from "../../src/workload/kapitsa-observations.js";

test("projects Gufo and Kapitsa completions newest first with explicit missing metrics", () => {
  const lines = [
    "2026-11-25 15:29:29 [INFO] [http] request=r12 event=completed method=POST path=/v1/chat/completions status=200 duration_ms=1000 outcome=completed prompt_tokens=100 prefill_tokens=25 generated_tokens=50 ttft_ms=50 prefill_tps=150 decode_tps=100 queue_ms=20 cached_tokens=75 ignored=secret",
    "[kapitsa] chat: prompt 200 (cached 100) in 500 ms (+1 ms template/tokenize), 31 tokens in 620 ms (50 tok/s), stop, thinking: on",
    "[kapitsa] chat: this line contains request content",
  ];
  const runs = parseInferenceRuns(lines);
  expect(runs).toMatchObject([
    {
      id: null,
      at: null,
      state: "completed",
      prefillTps: 200,
      decodeTps: 50,
      ttftMs: null,
      queueMs: null,
      durationMs: null,
      promptN: 200,
      cachedN: 100,
      generatedN: 31,
    },
    {
      id: "r12",
      at: "2026-11-25 15:29:29",
      state: "completed",
      prefillTps: 150,
      decodeTps: 100,
      ttftMs: 50,
      queueMs: 20,
      durationMs: 1000,
      promptN: 100,
      cachedN: 75,
      generatedN: 50,
    },
  ]);
  expect(JSON.stringify(runs)).not.toContain("secret");
});

test("only includes terminal inference requests and caps retained records", () => {
  const prefix = "2026-11-25 15:29:29 [INFO] [http]";
  const line = `${prefix} request=r7 event=completed method=POST path=/v1/chat/completions status=503 outcome=overloaded`;
  expect(
    parseInferenceRuns([
      `${prefix} request=r1 event=admitted method=POST path=/v1/chat/completions`,
      `${prefix} request=r2 event=completed method=GET path=/health status=200`,
      ...Array<string>(100).fill(line),
    ]),
  ).toHaveLength(50);
  expect(parseInferenceRuns([line])[0]).toMatchObject({
    id: "r7",
    state: "failed",
    decodeTps: null,
  });
});

test("reports actual Kapitsa completion timings without treating engine time as TTFT", () => {
  const json =
    '{"request_id":"req-12","finish_reason":"tool_calls","prompt_tokens":100,"cached_tokens":75,"completion_tokens":40,"queue_ms":23,"prefill_ms":47,"decode_ms":400,"tokens_per_second":97.5,"prefill_tokens_per_second":531.9,"error":"secret"}';
  const run = parseKapitsaCompletion(json);
  expect(run).toMatchObject({
    id: "req-12",
    state: "completed",
    engineFirstMs: 70,
    queueMs: 23,
    ttftMs: null,
    decodeTps: 97.5,
    generatedN: 40,
    cachedN: 75,
  });
  expect(JSON.stringify(run)).not.toContain("secret");
  const projected = CONSOLE_ALLOWLIST["inferenceObservations"]?.project(run);
  expect(projected).toMatchObject({ engineFirstMs: 70 });
});

test("projects Kapitsa slot ownership, token progress and memory only for the selected server", () => {
  const nativeStatus = {
    protocol: 1,
    config: { port: 18200, api_key: "secret" },
    model: { id: "kapitsa-production", slots: 2, context_length: 131072 },
    run_id: "a496bb2cb631c8d4",
    last_event_id: "a496bb2cb631c8d4.982",
    requests: [
      { request_id: "req-4", phase: "writing", completion_tokens: 17, client: "private" },
      { request_id: "req-5", phase: "waiting", completion_tokens: 0 },
    ],
    engine: {
      memory: { allocated_bytes: 23969464320, kv_bytes: 1568669696 },
      slots: [
        { index: 0, busy: false, tokens: 11 },
        { index: 1, busy: true, tokens: 120, request_id: "req-4" },
      ],
    },
  };
  const metrics = parseKapitsaStatus(nativeStatus, 18200, "kapitsa-production");
  expect(metrics).toMatchObject({
    waiting: 1,
    allocatedBytes: 23969464320,
    kvBytes: 1568669696,
    capacity: { slots: 2, context: 131072 },
    slots: [
      { id: 0, processing: false, nDecoded: null },
      { id: 1, processing: true, nPast: 120, nDecoded: 17 },
    ],
  });
  expect(JSON.stringify(metrics)).not.toMatch(/private|secret/);
  expect(parseKapitsaStatus(nativeStatus, 11111, "kapitsa-production")).toBeNull();
});

test("reads completion frames across chunks and stops replay at the observed run boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "k-"));
  const run = join(directory, ".kapitsa", "run");
  mkdirSync(run, { recursive: true });
  const runId = "a496bb2cb631c8d4";
  const completed = {
    request_id: "req-2",
    finish_reason: "stop",
    prompt_tokens: 100,
    cached_tokens: 3,
    completion_tokens: 10,
    queue_ms: 2,
    prefill_ms: 3,
    decode_ms: 4,
    tokens_per_second: 78,
    prefill_tokens_per_second: 98,
  };
  const encoder = new TextEncoder();
  let reset = false;
  const server = Bun.serve({
    unix: join(run, "default.sock"),
    fetch(request) {
      const path = new URL(request.url).pathname;
      expect(request.method).toBe("GET");
      if (path === "/status") {
        return Response.json({
          protocol: 1,
          config: { port: 18200 },
          model: { id: "kapitsa-production", slots: 2, context_length: 131072 },
          requests: [],
          run_id: runId,
          last_event_id: `${runId}.3`,
        });
      }
      expect(path).toBe("/events");
      expect(request.headers.get("last-event-id")).toBe(`${runId}.1`);
      const chunks = reset
        ? [`id: ${runId}.3\nevent: reset\ndata: {"reason":"run_changed"}\n\n`]
        : [
            `id: ${runId}.2\nevent: request_finished\nda`,
            `ta: ${JSON.stringify(completed)}\n\nid: ${runId}.3\nevent: request_finished\ndata: malformed\n\n`,
          ];
      const stream = new ReadableStream<Uint8Array>({
        pull(controller): void {
          const chunk = chunks.shift();
          if (chunk === undefined) controller.close();
          else controller.enqueue(encoder.encode(chunk));
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const activity = await readKapitsaObservation(directory, 18200, "kapitsa-production");
    expect(activity?.runs).toMatchObject([{ id: "req-2", engineFirstMs: 5 }]);
    reset = true;
    expect((await readKapitsaObservation(directory, 18200, "kapitsa-production"))?.runs).toEqual(
      [],
    );
    expect(await readKapitsaObservation(directory, 18201, "kapitsa-production")).toBeNull();
  } finally {
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});
