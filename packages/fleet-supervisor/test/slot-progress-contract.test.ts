/* eslint-disable @typescript-eslint/require-await -- Test fetch stubs implement the async fetch contract without artificial scheduling. */
import { describe, expect, it } from "bun:test";

import { parseSlotsResponse, readSlotProgress } from "../src/slot-progress.js";

describe("parseSlotsResponse key precedence and coercion", () => {
  // Mutation: reorder PAST_KEYS so a later key wins.
  it("prefers n_past over the other prompt counters", () => {
    const [slot] = parseSlotsResponse([{ n_past: 1, n_prompt_tokens_processed: 2, n_prompt: 3 }]);
    expect(slot?.nPast).toBe(1);
  });

  // Mutation: drop "n_prompt" from PAST_KEYS.
  it("reads n_prompt when it is the only prompt counter", () => {
    const [slot] = parseSlotsResponse([{ n_prompt: 9 }]);
    expect(slot?.nPast).toBe(9);
  });

  // Mutation: reorder DECODED_KEYS so a later key wins.
  it("prefers n_decoded over the other decode counters", () => {
    const [slot] = parseSlotsResponse([{ n_decoded: 1, tokens_predicted: 2, n_predicted: 3 }]);
    expect(slot?.nDecoded).toBe(1);
  });

  // Mutation: drop "n_predicted" from DECODED_KEYS.
  it("reads n_predicted when it is the only decode counter", () => {
    const [slot] = parseSlotsResponse([{ n_predicted: 4 }]);
    expect(slot?.nDecoded).toBe(4);
  });

  // Mutation: remove the Number.isFinite check in numField.
  it("skips a non-finite counter in favour of the next key", () => {
    const [past] = parseSlotsResponse([{ n_past: Infinity, n_prompt_tokens_processed: 7 }]);
    expect(past?.nPast).toBe(7);
    const [decoded] = parseSlotsResponse([{ n_decoded: NaN, tokens_predicted: 5 }]);
    expect(decoded?.nDecoded).toBe(5);
  });

  // Mutation: remove Number.isFinite from the id/state guards.
  it("nulls a non-finite id or state", () => {
    const [slot] = parseSlotsResponse([{ id: NaN, state: Infinity }]);
    expect(slot?.id).toBeNull();
    expect(slot?.state).toBeNull();
    expect(slot?.processing).toBeNull();
  });

  // Mutation: `if (obj["is_processing"] !== undefined) return Boolean(obj["is_processing"])`.
  it("ignores a non-boolean is_processing and derives processing from state", () => {
    const [idle] = parseSlotsResponse([{ state: 0, is_processing: 1 }]);
    expect(idle?.processing).toBe(false);
    const [busy] = parseSlotsResponse([{ state: 2, is_processing: "yes" }]);
    expect(busy?.processing).toBe(true);
  });

  // Mutation: `if (obj["is_processing"] === true) return true`.
  it("lets is_processing=false override a non-zero state", () => {
    const [slot] = parseSlotsResponse([{ state: 1, is_processing: false }]);
    expect(slot?.processing).toBe(false);
  });

  // Mutation: `return state === 1` in deriveProcessing.
  it("counts any non-zero state as processing", () => {
    const [slot] = parseSlotsResponse([{ state: 2 }]);
    expect(slot?.processing).toBe(true);
  });

  // Mutation: read only "n_decoded" in nestedDecoded.
  it("reads nested next_token decode progress from alternate key names", () => {
    const [slot] = parseSlotsResponse([{ next_token: [{ tokens_predicted: 11 }] }]);
    expect(slot?.nDecoded).toBe(11);
  });

  // Mutation: search next_token for the first element carrying a counter.
  it("reads only the first next_token element", () => {
    const [slot] = parseSlotsResponse([{ next_token: [{}, { n_decoded: 9 }] }]);
    expect(slot?.nDecoded).toBeNull();
  });

  // Mutation: replace the hasOwnProperty check with `"next_token" in obj`.
  it("ignores an inherited next_token", () => {
    const inherited = Object.create({ next_token: [{ n_decoded: 3 }] }) as Record<string, unknown>;
    const [slot] = parseSlotsResponse([inherited]);
    expect(slot?.nDecoded).toBeNull();
  });
});

const ENDPOINT = "http://127.0.0.1:8086";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function recordingFetch(response: () => Response): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return response();
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchFn, calls };
}

describe("readSlotProgress contract", () => {
  // Mutation: change the "/slots" path suffix or the request method.
  it("fetches GET ${endpoint}/slots exactly once", async () => {
    const { fetch: fetchFn, calls } = recordingFetch(() => new Response("[]", { status: 200 }));
    await readSlotProgress(ENDPOINT, { fetch: fetchFn });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(`${ENDPOINT}/slots`);
    expect(calls[0]?.init?.method).toBe("GET");
  });

  // Mutation: drop `signal: controller.signal` from the fetch init.
  it("passes an AbortSignal to fetch", async () => {
    const { fetch: fetchFn, calls } = recordingFetch(() => new Response("[]", { status: 200 }));
    await readSlotProgress(ENDPOINT, { fetch: fetchFn });
    const signal = calls[0]?.init?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  // Mutation: delete the inner try/catch around res.json() so the error
  // falls through to the outer "network/timeout" catch.
  it("reports invalid JSON for a 200 whose body is not JSON", async () => {
    const { fetch: fetchFn } = recordingFetch(() => new Response("not json", { status: 200 }));
    const reading = await readSlotProgress(ENDPOINT, { fetch: fetchFn });
    expect(reading).toEqual({ available: false, reason: "invalid JSON", slots: [] });
  });

  // Mutation: change the "non-array /slots body" reason string.
  it("reports the exact non-array reason for a 200 object body", async () => {
    const { fetch: fetchFn } = recordingFetch(
      () => new Response(JSON.stringify({ error: "no slots" }), { status: 200 }),
    );
    const reading = await readSlotProgress(ENDPOINT, { fetch: fetchFn });
    expect(reading.reason).toBe("non-array /slots body");
  });

  // Mutation: change the "network/timeout" reason string.
  it("reports network/timeout for a rejected fetch", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const reading = await readSlotProgress(ENDPOINT, { fetch: fetchFn });
    expect(reading.reason).toBe("network/timeout");
  });

  // Mutation: treat an empty array as unavailable.
  it("reports available with no slots for an empty array body", async () => {
    const { fetch: fetchFn } = recordingFetch(() => new Response("[]", { status: 200 }));
    const reading = await readSlotProgress(ENDPOINT, { fetch: fetchFn });
    expect(reading).toEqual({ available: true, slots: [] });
  });

  // Mutation: change the "invalid endpoint: " reason prefix.
  it("rejects a public endpoint by default without fetching", async () => {
    const { fetch: fetchFn, calls } = recordingFetch(() => new Response("[]", { status: 200 }));
    const reading = await readSlotProgress("http://8.8.8.8:8080", { fetch: fetchFn });
    expect(reading.available).toBe(false);
    expect(reading.reason?.startsWith("invalid endpoint: ")).toBe(true);
    expect(calls.length).toBe(0);
  });

  // Mutation: pass a hard-coded false to validateProbeEndpoint.
  it("fetches a public endpoint when allowPublicEndpoints is true", async () => {
    const { fetch: fetchFn, calls } = recordingFetch(() => new Response("[]", { status: 200 }));
    const reading = await readSlotProgress("http://8.8.8.8:8080", {
      fetch: fetchFn,
      allowPublicEndpoints: true,
    });
    expect(reading.available).toBe(true);
    expect(calls.length).toBe(1);
  });

  // Mutation: remove controller.abort() from the timer; the stub promise
  // then never settles and this test never completes.
  it("aborts the request when timeoutMs elapses", async () => {
    const fetchFn = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      })) as unknown as typeof globalThis.fetch;
    const reading = await readSlotProgress(ENDPOINT, { fetch: fetchFn, timeoutMs: 0 });
    expect(reading).toEqual({ available: false, reason: "network/timeout", slots: [] });
  });
});
