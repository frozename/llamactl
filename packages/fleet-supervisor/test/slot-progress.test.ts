/* eslint-disable @typescript-eslint/require-await -- Test fetch stubs implement the async fetch contract without artificial scheduling. */
import { describe, expect, it } from "bun:test";

import { parseSlotsResponse, readSlotProgress } from "../src/slot-progress.js";

describe("parseSlotsResponse", () => {
  it("returns [] for a non-array body", () => {
    expect(parseSlotsResponse(null)).toEqual([]);
    expect(parseSlotsResponse({ slots: [] })).toEqual([]);
    expect(parseSlotsResponse("nope")).toEqual([]);
  });

  it("extracts id, state, processing, and token counters", () => {
    const body = [
      { id: 0, state: 1, n_past: 4096, n_decoded: 128 },
      { id: 1, state: 0, n_past: 0, n_decoded: 0 },
    ];
    expect(parseSlotsResponse(body)).toEqual([
      { id: 0, state: 1, processing: true, nPast: 4096, nDecoded: 128 },
      { id: 1, state: 0, processing: false, nPast: 0, nDecoded: 0 },
    ]);
  });

  it("prefers explicit is_processing over state derivation", () => {
    const body = [{ id: 0, state: 0, is_processing: true, n_past: 10, n_decoded: 2 }];
    expect(parseSlotsResponse(body)[0]?.processing).toBe(true);
  });

  it("reads alternate counter key names", () => {
    const body = [{ id: 0, n_prompt_tokens_processed: 512, tokens_predicted: 33 }];
    expect(parseSlotsResponse(body)[0]).toEqual({
      id: 0,
      state: null,
      processing: null,
      nPast: 512,
      nDecoded: 33,
    });
  });

  it("reads decode progress from nested next_token when the top level is absent", () => {
    const body = [{ id: 0, next_token: [{ n_decoded: 42, n_remain: 5 }] }];
    expect(parseSlotsResponse(body)[0]?.nDecoded).toBe(42);
  });

  it("prefers top-level decode progress over nested next_token", () => {
    const body = [{ id: 0, n_decoded: 7, next_token: [{ n_decoded: 42 }] }];
    expect(parseSlotsResponse(body)[0]?.nDecoded).toBe(7);
  });

  it("treats missing or malformed next_token as null decode progress", () => {
    expect(parseSlotsResponse([{ id: 0, next_token: [] }])[0]?.nDecoded).toBeNull();
    expect(parseSlotsResponse([{ id: 0 }])[0]?.nDecoded).toBeNull();
    expect(parseSlotsResponse([{ id: 0, next_token: [null] }])[0]?.nDecoded).toBeNull();
  });

  it("nulls missing or non-numeric fields without throwing", () => {
    const body = [{}, { id: "x", state: "busy", n_past: "lots" }, null];
    expect(parseSlotsResponse(body)).toEqual([
      { id: null, state: null, processing: null, nPast: null, nDecoded: null },
      { id: null, state: null, processing: null, nPast: null, nDecoded: null },
      { id: null, state: null, processing: null, nPast: null, nDecoded: null },
    ]);
  });
});

const ENDPOINT = "http://127.0.0.1:8086";

function fetchReturning(status: number, body: string): typeof globalThis.fetch {
  return (async () => new Response(body, { status })) as unknown as typeof globalThis.fetch;
}

describe("readSlotProgress", () => {
  it("returns available + parsed slots on a 200 array", async () => {
    const fetchFn = fetchReturning(200, JSON.stringify([{ id: 0, state: 1, n_decoded: 5 }]));
    const reading = await readSlotProgress(ENDPOINT, { fetch: fetchFn });
    expect(reading.available).toBe(true);
    expect(reading.slots).toEqual([
      { id: 0, state: 1, processing: true, nPast: null, nDecoded: 5 },
    ]);
  });

  it("marks unavailable with the status on a non-200", async () => {
    const reading = await readSlotProgress(ENDPOINT, { fetch: fetchReturning(404, "not found") });
    expect(reading.available).toBe(false);
    expect(reading.reason).toBe("HTTP 404");
    expect(reading.slots).toEqual([]);
  });

  it("marks unavailable when the body is not an array", async () => {
    const reading = await readSlotProgress(ENDPOINT, {
      fetch: fetchReturning(200, JSON.stringify({ error: "no slots" })),
    });
    expect(reading.available).toBe(false);
    expect(reading.slots).toEqual([]);
  });

  it("marks unavailable on a network error", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const reading = await readSlotProgress(ENDPOINT, { fetch: fetchFn });
    expect(reading.available).toBe(false);
    expect(reading.slots).toEqual([]);
  });

  it("rejects an invalid endpoint without fetching", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response("[]", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const reading = await readSlotProgress("not-a-url", { fetch: fetchFn });
    expect(reading.available).toBe(false);
    expect(called).toBe(false);
  });
});
