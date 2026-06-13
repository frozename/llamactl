/* eslint-disable @typescript-eslint/require-await -- Test fetch/probe stubs implement async contracts without artificial scheduling. */
import { describe, expect, it } from "bun:test";

import type { CompletionProbeConfig, CompletionProbeResult } from "../src/completion-probe.js";
import type { CompletionProbeSnapshot } from "../src/types.js";
import type { WorkloadTarget } from "../src/workload-probe.js";

import { makeDefaultProbeFn } from "../src/loop-helpers.js";

const PROBE_CONFIG: CompletionProbeConfig = {
  path: "/v1/chat/completions",
  prompt: "ping",
  maxTokens: 1,
  timeoutMs: 500,
  everyNTicks: 2,
};

function healthyFetch(): (url: string) => Promise<Response> {
  return async (url: string): Promise<Response> => {
    if (url.endsWith("/health")) return new Response("ok", { status: 200 });
    if (url.endsWith("/v1/models"))
      return new Response(JSON.stringify({ data: [{ id: "granite-3b" }] }), { status: 200 });
    return new Response("", { status: 404 });
  };
}

function freshState(): {
  consecutiveFailures: Map<string, number>;
  tickCounter: Map<string, number>;
  lastResult: Map<string, CompletionProbeSnapshot>;
} {
  return {
    consecutiveFailures: new Map<string, number>(),
    tickCounter: new Map<string, number>(),
    lastResult: new Map<string, CompletionProbeSnapshot>(),
  };
}

const TARGET: WorkloadTarget = {
  name: "granite-judge",
  endpoint: "http://127.0.0.1:8086",
  kind: "ModelRun",
  completionProbe: PROBE_CONFIG,
};

describe("makeDefaultProbeFn completion wiring", () => {
  it("runs the completion probe on cadence ticks and stays sticky between them", async () => {
    const seen: { endpoint: string; models: string[]; prior: number }[] = [];
    const fakeProbe = async (
      endpoint: string,
      opts: { models?: string[]; priorConsecutiveFailures?: number },
    ): Promise<CompletionProbeResult> => {
      const prior = opts.priorConsecutiveFailures ?? 0;
      seen.push({ endpoint, models: opts.models ?? [], prior });
      return {
        ok: false,
        status: 503,
        latencyMs: 5,
        classification: "wedge",
        consecutiveFailures: prior + 1,
      };
    };

    const state = freshState();
    const probeFn = makeDefaultProbeFn({
      fetch: healthyFetch() as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      completion: { ...state, probe: fakeProbe },
    });

    const a = await probeFn(TARGET);
    const b = await probeFn(TARGET);
    const c = await probeFn(TARGET);
    const d = await probeFn(TARGET);

    expect(a.completionProbe).toEqual({
      ran: true,
      ok: false,
      status: 503,
      consecutiveFailures: 1,
      latencyMs: 5,
    });
    expect(b.completionProbe?.ran).toBe(false);
    expect(b.completionProbe?.consecutiveFailures).toBe(1);
    expect(c.completionProbe?.ran).toBe(true);
    expect(c.completionProbe?.consecutiveFailures).toBe(2);
    expect(d.completionProbe?.ran).toBe(false);
    expect(d.completionProbe?.consecutiveFailures).toBe(2);

    // Probe only actually fired on the two cadence ticks, with the served models + resolved endpoint.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({
      endpoint: "http://127.0.0.1:8086",
      models: ["granite-3b"],
      prior: 0,
    });
    expect(seen[1]?.prior).toBe(1);
  });

  it("clears completion state and omits the field when /health is unreachable", async () => {
    const fakeProbe = async (
      _endpoint: string,
      opts: { priorConsecutiveFailures?: number },
    ): Promise<CompletionProbeResult> => ({
      ok: false,
      status: 503,
      latencyMs: 5,
      classification: "wedge",
      consecutiveFailures: (opts.priorConsecutiveFailures ?? 0) + 1,
    });
    const state = freshState();

    const wedged = makeDefaultProbeFn({
      fetch: healthyFetch() as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      completion: { ...state, probe: fakeProbe },
    });
    await wedged(TARGET);
    expect(state.consecutiveFailures.get("granite-judge")).toBe(1);

    const downFetch = async (): Promise<Response> => new Response("down", { status: 503 });
    const down = makeDefaultProbeFn({
      fetch: downFetch as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      completion: { ...state, probe: fakeProbe },
    });
    const snap = await down(TARGET);
    expect(snap.reachable).toBe(false);
    expect(snap.completionProbe).toBeUndefined();
    expect(state.consecutiveFailures.has("granite-judge")).toBe(false);
    expect(state.tickCounter.has("granite-judge")).toBe(false);
  });

  it("does not probe a workload without a completionProbe config", async () => {
    let probeCalls = 0;
    const fakeProbe = async (): Promise<CompletionProbeResult> => {
      probeCalls++;
      return { ok: true, status: 200, latencyMs: 1, classification: "ok", consecutiveFailures: 0 };
    };
    const probeFn = makeDefaultProbeFn({
      fetch: healthyFetch() as unknown as typeof fetch,
      timeoutMs: 500,
      consecutiveErrors: new Map(),
      completion: { ...freshState(), probe: fakeProbe },
    });
    const snap = await probeFn({
      name: "plain",
      endpoint: "http://127.0.0.1:8090",
      kind: "ModelHost",
    });
    expect(snap.completionProbe).toBeUndefined();
    expect(probeCalls).toBe(0);
  });
});
