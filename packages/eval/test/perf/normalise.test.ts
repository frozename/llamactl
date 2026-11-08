import { describe, expect, test } from "bun:test";

import type { MetricValue } from "../../src/matrix/types.js";

import {
  normaliseAcceptance,
  normaliseDecodeTps,
  normalisePrefillTps,
  parseProcIo,
  parseVmHwm,
  rusageIo,
} from "../../src/perf/normalise.js";

function expectOk(metric: MetricValue): number {
  expect(metric.status).toBe("ok");
  if (metric.status !== "ok") throw new Error("expected an ok metric");
  return metric.value;
}

function expectUnavailable(metric: MetricValue, pattern: RegExp): void {
  expect(metric.status).toBe("unavailable");
  if (metric.status !== "unavailable") throw new Error("expected an unavailable metric");
  expect(metric.value).toBeNull();
  expect(metric.reason).toMatch(pattern);
}

describe("normaliseAcceptance", () => {
  test("reads draft acceptance from llamacpp timings", () => {
    const metric = normaliseAcceptance({
      timings: { draft_n: 100, draft_n_accepted: 75 },
    });
    expect(metric).toEqual({ value: 0.75, status: "ok" });
  });

  test("reads draft acceptance from gufo usage fields", () => {
    const metric = normaliseAcceptance({
      usage: { draft_tokens: 4405, draft_tokens_accepted: 3467 },
    });
    expect(expectOk(metric)).toBeCloseTo(0.787, 3);
  });

  test("reads draft acceptance from kapitsa usage fields", () => {
    const metric = normaliseAcceptance({
      usage: { kapitsa: { draft_tokens: 200, draft_tokens_accepted: 120 } },
    });
    expect(expectOk(metric)).toBeCloseTo(0.6, 5);
  });

  test("reports unavailable when the payload has no draft fields", () => {
    const metric = normaliseAcceptance({ usage: { prompt_tokens: 5, completion_tokens: 5 } });
    expectUnavailable(metric, /no draft acceptance/i);
  });

  test("reports unavailable when the engine drafted zero tokens", () => {
    const metric = normaliseAcceptance({
      timings: { draft_n: 0, draft_n_accepted: 0 },
    });
    expectUnavailable(metric, /no draft tokens/i);
  });
});

describe("normaliseDecodeTps", () => {
  test("reads the decode rate from llamacpp timings", () => {
    expect(normaliseDecodeTps({ timings: { predicted_per_second: 50 } })).toEqual({
      value: 50,
      status: "ok",
    });
  });

  test("reads the decode rate from gufo usage fields", () => {
    expect(normaliseDecodeTps({ usage: { completion_tokens_per_second: 50 } })).toEqual({
      value: 50,
      status: "ok",
    });
  });

  test("derives the decode rate from gufo completion tokens and decode_ms", () => {
    const metric = normaliseDecodeTps({
      usage: { completion_tokens: 100, gufo: { decode_ms: 2000 } },
    });
    expect(expectOk(metric)).toBeCloseTo(50, 5);
  });

  test("reports unavailable when no decode rate is derivable", () => {
    expectUnavailable(normaliseDecodeTps({}), /no decode rate/i);
  });
});

describe("normalisePrefillTps", () => {
  test("reads the prefill rate from llamacpp timings", () => {
    expect(normalisePrefillTps({ timings: { prompt_per_second: 900 } })).toEqual({
      value: 900,
      status: "ok",
    });
  });

  test("reads the prefill rate from gufo usage fields", () => {
    expect(normalisePrefillTps({ usage: { prompt_tokens_per_second: 900 } })).toEqual({
      value: 900,
      status: "ok",
    });
  });

  test("derives the prefill rate from gufo prompt tokens and prefill_ms", () => {
    const metric = normalisePrefillTps({
      usage: { prompt_tokens: 900, gufo: { prefill_ms: 1000 } },
    });
    expect(expectOk(metric)).toBeCloseTo(900, 5);
  });

  test("falls back to measured prompt tokens over ttft", () => {
    const metric = normalisePrefillTps({}, { promptTokens: 450, ttftMs: 500 });
    expect(expectOk(metric)).toBeCloseTo(900, 5);
  });

  test("reports unavailable when no prefill rate is derivable", () => {
    expectUnavailable(normalisePrefillTps({}), /no prefill rate/i);
  });
});

describe("parseProcIo", () => {
  test("extracts read_bytes and write_bytes and rejects non-proc text", () => {
    expect(
      parseProcIo(
        "rchar: 10\nwchar: 20\nsyscr: 1\nsyscw: 1\nread_bytes: 4096\nwrite_bytes: 8192\ncancelled_write_bytes: 0\n",
      ),
    ).toEqual({ readBytes: 4096, writeBytes: 8192 });
    expect(parseProcIo("garbage")).toBeNull();
  });
});

describe("parseVmHwm", () => {
  test("converts VmHWM kilobytes to bytes and rejects status without it", () => {
    expect(parseVmHwm("Name:\tllama-server\nVmHWM:\t  123456 kB\nVmRSS:\t 1000 kB\n")).toBe(
      123456 * 1024,
    );
    expect(parseVmHwm("Name:\tx\n")).toBeNull();
  });
});

describe("rusageIo", () => {
  test("maps ri_diskio fields and rejects non-finite values", () => {
    expect(rusageIo({ ri_diskio_bytesread: 4096, ri_diskio_byteswritten: 8192 })).toEqual({
      readBytes: 4096,
      writeBytes: 8192,
    });
    expect(rusageIo({ ri_diskio_bytesread: NaN, ri_diskio_byteswritten: 1 })).toBeNull();
  });
});
