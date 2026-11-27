// #905 — pins the request-capture capture boundary from #890: what the 64 KiB
// prefix cap does to a request body that straddles it, and what redaction does
// to credentials that straddle chunk splits on either leg. Every case runs
// in-process through captureInference; no sockets, no seats, no inference.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureInference } from "../../src/request-capture/record.js";
import {
  type CapturedRequest,
  findCapture,
  listCaptures,
} from "../../src/request-capture/store.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

// Mirrors BYTE_CAP in record.ts:5.
const CAP = 64 * 1024;
const CAPTURE_ENV = "LLAMACTL_REQUEST_CAPTURE_FILE";

let dir = "";
let file = "";
let savedCapture: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llamactl-capture-boundary-"));
  savedCapture = process.env[CAPTURE_ENV];
  file = join(dir, "capture.sqlite");
  process.env[CAPTURE_ENV] = file;
});

afterEach(() => {
  if (savedCapture === undefined) {
    Reflect.deleteProperty(process.env, CAPTURE_ENV);
  } else {
    process.env[CAPTURE_ENV] = savedCapture;
  }
  rmSync(dir, { recursive: true, force: true });
});

interface Captured {
  clientBytes: number;
  record: CapturedRequest;
  raw: string;
}

/** A stream that enqueues each chunk on its own, so chunk boundaries are explicit. */
function streamOf(chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

async function capture(
  reqChunks: readonly (string | Uint8Array)[],
  resChunks: readonly (string | Uint8Array)[],
  contentType = "text/event-stream",
): Promise<Captured> {
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: streamOf(reqChunks),
    duplex: "half",
  };
  const req = new Request("http://127.0.0.1/v1/chat/completions", init);
  const res = await captureInference(req, "/v1/chat/completions", async (): Promise<Response> => {
    await req.arrayBuffer();
    return new Response(streamOf(resChunks), { headers: { "content-type": contentType } });
  });
  const clientBytes = (await res.arrayBuffer()).byteLength;
  let rows = listCaptures(file);
  let tries = 0;
  while (rows.length !== 1 && tries < 200) {
    tries += 1;
    await new Promise((resolve) => setTimeout(resolve, 1));
    rows = listCaptures(file);
  }
  expect(rows.length).toBe(1);
  const record = findCapture(file, rows[0]!.id)!;
  return { clientBytes, record, raw: JSON.stringify(record) };
}

const bodyWith = (filler: string): string =>
  `{"model":"fixture-model","provider_options":{"api_key":"fixture-cap-key-secret"},"messages":[{"role":"user","content":"${filler}"}],"note":"fixture-tail-marker"}`;

/** The fixture body padded with "a" to exactly `bytes`; the filler is ASCII, so bytes are chars. */
function bodyAtBytes(bytes: number): string {
  const empty = bodyWith("");
  return bodyWith("a".repeat(bytes - Buffer.byteLength(empty)));
}

const frame = (text: string): string => `data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`;

const smallRequest = ['{"model":"fixture-model","messages":[{"role":"user","content":"hi"}]}'];

test("a request body of exactly 64 KiB is captured whole and still redacted", async () => {
  const body = bodyAtBytes(CAP);
  expect(Buffer.byteLength(body)).toBe(CAP);
  const { record, raw } = await capture(
    [body.slice(0, 1000), body.slice(1000)],
    [frame("fixture-head-reply")],
  );
  expect(record.truncated).toBe(false);
  expect(record.model).toBe("fixture-model");
  expect(raw).toContain("fixture-tail-marker");
  expect(raw).not.toContain("fixture-cap-key-secret");
  expect(record.request).toMatchObject({ provider_options: { api_key: "[redacted]" } });
}, 10_000);

test("a request body one byte over 64 KiB is truncated and not stored", async () => {
  const body = bodyAtBytes(CAP + 1);
  expect(Buffer.byteLength(body)).toBe(CAP + 1);
  const { record, raw } = await capture([body], [frame("fixture-head-reply")]);
  expect(record.truncated).toBe(true);
  expect(record.request).toBeNull();
  expect(record.model).toBeNull();
  expect(raw).not.toContain("fixture-tail-marker");
  expect(raw).not.toContain("fixture-cap-key-secret");
}, 10_000);

test("a request body split as exactly 64 KiB plus one trailing byte is truncated and not stored", async () => {
  const body = bodyAtBytes(CAP + 1);
  const { record, raw } = await capture(
    [body.slice(0, CAP), body.slice(CAP)],
    [frame("fixture-head-reply")],
  );
  expect(record.truncated).toBe(true);
  expect(record.request).toBeNull();
  expect(record.model).toBeNull();
  expect(raw).not.toContain("fixture-tail-marker");
  expect(raw).not.toContain("fixture-cap-key-secret");
}, 10_000);

test("credentials split across request chunks are redacted", async () => {
  const body =
    '{"model":"fixture-model","provider_options":{"api_key":"fixture-split-key-secret"},"messages":[{"role":"user","content":"Authorization: Bearer fixture-split-bearer-secret"}]}';
  const keySplit = body.indexOf("split-key");
  const bearerSplit = body.indexOf("split-bearer");
  expect(keySplit).toBeGreaterThan(0);
  expect(bearerSplit).toBeGreaterThan(keySplit);
  const { record, raw } = await capture(
    [body.slice(0, keySplit), body.slice(keySplit, bearerSplit), body.slice(bearerSplit)],
    [frame("fixture-head-reply")],
  );
  expect(record.truncated).toBe(false);
  expect(raw).not.toContain("fixture-split-key-secret");
  expect(raw).not.toContain("fixture-split-bearer-secret");
  expect(raw).toContain("Bearer [redacted]");
  expect(record.request).toMatchObject({ provider_options: { api_key: "[redacted]" } });
}, 10_000);

test("credentials split across response chunks are redacted, mid-frame and at frame boundaries", async () => {
  const { record, raw } = await capture(smallRequest, [
    'data: {"choices":[{"delta":{"content":"Bearer fixture-mid',
    'chunk-secret"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" and Bearer "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"fixture-frame-secret"}}]}\n\n',
  ]);
  expect(record.truncated).toBe(false);
  expect(record.response).toMatchObject({ reply: "Bearer [redacted] and Bearer [redacted]" });
  expect(raw).not.toContain("fixture-midchunk-secret");
  expect(raw).not.toContain("fixture-frame-secret");
}, 10_000);

test("a response over 64 KiB passes through whole while the capture stops at the cap", async () => {
  const frames = [
    frame("fixture-visible-head"),
    frame("x".repeat(CAP)),
    frame("fixture-past-cap-marker"),
  ];
  let expected = 0;
  for (const chunk of frames) {
    expected += Buffer.byteLength(chunk);
  }
  const { clientBytes, record, raw } = await capture(smallRequest, frames);
  expect(clientBytes).toBe(expected);
  expect(record.truncated).toBe(true);
  expect(record.response).toMatchObject({ reply: "fixture-visible-head" });
  expect(raw).not.toContain("fixture-past-cap-marker");
}, 10_000);
