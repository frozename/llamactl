import { describe, expect, test } from "bun:test";

import { openaiPathBucket, statusClass } from "../src/server/metrics.js";

describe("statusClass", () => {
  test("100 -> 1xx", () => {
    expect(statusClass(100)).toBe("1xx");
  });

  test("199 -> 1xx", () => {
    expect(statusClass(199)).toBe("1xx");
  });

  test("200 -> 2xx", () => {
    expect(statusClass(200)).toBe("2xx");
  });

  test("204 -> 2xx", () => {
    expect(statusClass(204)).toBe("2xx");
  });

  test("301 -> 3xx", () => {
    expect(statusClass(301)).toBe("3xx");
  });

  test("404 -> 4xx", () => {
    expect(statusClass(404)).toBe("4xx");
  });

  test("499 -> 4xx", () => {
    expect(statusClass(499)).toBe("4xx");
  });

  test("500 -> 5xx", () => {
    expect(statusClass(500)).toBe("5xx");
  });

  test("599 -> 5xx", () => {
    expect(statusClass(599)).toBe("5xx");
  });

  test("bounds outside 100-599 give 'unknown'", () => {
    expect(statusClass(99)).toBe("unknown");
    expect(statusClass(0)).toBe("unknown");
    expect(statusClass(-1)).toBe("unknown");
    expect(statusClass(600)).toBe("unknown");
  });

  test("non-integer inside range floors", () => {
    expect(statusClass(404.5)).toBe("4xx");
  });
});

describe("openaiPathBucket", () => {
  test('"/v1/chat/completions" passes through unchanged', () => {
    expect(openaiPathBucket("/v1/chat/completions")).toBe("/v1/chat/completions");
  });

  test('"/v1/completions" passes through unchanged', () => {
    expect(openaiPathBucket("/v1/completions")).toBe("/v1/completions");
  });

  test('"/v1/embeddings" passes through unchanged', () => {
    expect(openaiPathBucket("/v1/embeddings")).toBe("/v1/embeddings");
  });

  test('"/v1/models" passes through unchanged', () => {
    expect(openaiPathBucket("/v1/models")).toBe("/v1/models");
  });

  test('"/v1/rerank" passes through unchanged', () => {
    expect(openaiPathBucket("/v1/rerank")).toBe("/v1/rerank");
  });

  test("trailing slash variant falls into '/v1/other'", () => {
    expect(openaiPathBucket("/v1/models/")).toBe("/v1/other");
  });

  test("sub-path variant falls into '/v1/other'", () => {
    expect(openaiPathBucket("/v1/models/llama-3")).toBe("/v1/other");
  });

  test("case change falls into '/v1/other'", () => {
    expect(openaiPathBucket("/V1/models")).toBe("/v1/other");
  });

  test("unknown endpoint falls into '/v1/other'", () => {
    expect(openaiPathBucket("/v1/responses")).toBe("/v1/other");
  });

  test("non-v1 path falls into '/v1/other'", () => {
    expect(openaiPathBucket("/health")).toBe("/v1/other");
  });

  test("empty string falls into '/v1/other'", () => {
    expect(openaiPathBucket("")).toBe("/v1/other");
  });
});
