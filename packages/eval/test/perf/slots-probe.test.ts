import { describe, expect, test } from "bun:test";

import * as evalIndex from "../../src/index.js";
import * as perfClient from "../../src/perf/client.js";

/**
 * RED pins for #521: probeEngineSlots(baseUrl, {fetchImpl}) GETs
 * <base>/props once and resolves {slots, reason:null} on a positive
 * integer total_slots, or {slots:null, reason} naming the failed GET —
 * it must never reject, because runPerfSuite turns the reason into the
 * cN_tps unavailable text. At base the export does not exist, so every
 * case fails on the probe()-presence assertion.
 */

type ProbeResult = { slots: number; reason: null } | { slots: null; reason: string };

type ProbeFn = (
  baseUrl: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
) => Promise<ProbeResult>;

function probe(): ProbeFn {
  const candidate = perfClient as unknown as { probeEngineSlots?: ProbeFn };
  const fn = candidate.probeEngineSlots;
  expect(typeof fn).toBe("function");
  if (typeof fn !== "function") throw new Error("probeEngineSlots is not exported");
  return fn;
}

interface RecordedRequest {
  url: string;
  method: string;
}

function recordingFetch(respond: (url: string) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    requests.push({ url, method });
    return Promise.resolve(respond(url));
  };
  return { fetchImpl: fetchImpl as typeof fetch, requests };
}

function slotsReason(result: ProbeResult): string {
  expect(result.slots).toBeNull();
  if (result.slots !== null) throw new Error("expected slots to be null");
  return result.reason;
}

describe("#521 probeEngineSlots", () => {
  test("GETs <base>/props once and returns total_slots (kills: wrong path, unstripped trailing slash, unparsed total_slots)", async () => {
    const fake = recordingFetch((url) => {
      if (url.endsWith("/props")) return Response.json({ total_slots: 4 });
      return Promise.reject(new Error(`unexpected engine request: ${url}`));
    });

    const result = await probe()("http://127.0.0.1:9/", { fetchImpl: fake.fetchImpl });

    expect(result).toEqual({ slots: 4, reason: null });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.url).toBe("http://127.0.0.1:9/props");
    expect(fake.requests[0]?.method).toBe("GET");
  });

  test("a non-OK /props resolves slots null with the status in the reason (kills: throwing on non-ok, dropping the status)", async () => {
    const fake = recordingFetch(() => new Response("nope", { status: 404 }));

    const result = await probe()("http://127.0.0.1:9/", { fetchImpl: fake.fetchImpl });

    const reason = slotsReason(result);
    expect(reason).toContain("GET http://127.0.0.1:9/props returned HTTP 404");
    expect(reason).toContain("engine slot count unknown");
  });

  test("a fetch rejection resolves slots null naming the failed GET (kills: an uncaught rejection)", async () => {
    const fake = recordingFetch(() => Promise.reject(new Error("ECONNREFUSED")));

    const result = await probe()("http://127.0.0.1:9/", { fetchImpl: fake.fetchImpl });

    expect(slotsReason(result)).toContain("GET http://127.0.0.1:9/props failed: ECONNREFUSED");
  });

  const BODIES: readonly (readonly [string, () => Response])[] = [
    ["total_slots: 0", (): Response => Response.json({ total_slots: 0 })],
    ["total_slots: -1", (): Response => Response.json({ total_slots: -1 })],
    ["total_slots: 1.5", (): Response => Response.json({ total_slots: 1.5 })],
    ["total_slots: '4'", (): Response => Response.json({ total_slots: "4" })],
    ["no total_slots", (): Response => Response.json({})],
    ["non-JSON body", (): Response => new Response("x", { status: 200 })],
  ];

  for (const [label, respond] of BODIES) {
    test(`rejects a /props body with ${label} (kills: a >= 0 check, non-integer acceptance, string coercion)`, async () => {
      const fake = recordingFetch(() => respond());

      const result = await probe()("http://127.0.0.1:9/", { fetchImpl: fake.fetchImpl });

      expect(slotsReason(result)).toContain("carried no positive integer total_slots");
    });
  }

  test("re-exports probeEngineSlots from the package barrel (kills: a missing barrel re-export)", () => {
    const index = evalIndex as unknown as Record<string, unknown>;
    expect(typeof index["probeEngineSlots"]).toBe("function");
  });
});
