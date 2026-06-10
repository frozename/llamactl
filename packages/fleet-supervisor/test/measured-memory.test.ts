import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readMeasuredMemoryCache, writeMeasuredMemoryCache } from "../src/measured-memory.js";

const ORIG_ENV_KEY = "LLAMACTL_MEASURED_MEMORY_PATH";

function makeEntry(name: string, peakMb: number) {
  return {
    workloadName: name,
    measuredAt: "2026-05-22T10:00:00.000Z",
    rssMeanMb: peakMb - 200,
    rssPeakMb: peakMb,
    sampleCount: 6,
    engineKind: "llama.cpp" as const,
    binary: "/usr/local/bin/llama-server",
  };
}

describe("readMeasuredMemoryCache", () => {
  let tmpDir: string;
  let cachePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "measured-mem-test-"));
    cachePath = join(tmpDir, "measured-memory.json");
    process.env[ORIG_ENV_KEY] = cachePath;
  });

  afterEach(() => {
    delete process.env[ORIG_ENV_KEY];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns null when cache file does not exist", () => {
    expect(readMeasuredMemoryCache("some/model.gguf::")).toBeNull();
  });

  test("returns null when key is absent from cache", () => {
    writeFileSync(cachePath, JSON.stringify({ "other::": { rssPeakMb: 9000 } }), "utf8");
    expect(readMeasuredMemoryCache("some/model.gguf::")).toBeNull();
  });

  test("returns null when file is invalid JSON", () => {
    writeFileSync(cachePath, "not-valid-json", "utf8");
    expect(readMeasuredMemoryCache("some/model.gguf::")).toBeNull();
  });

  test("returns null when rssPeakMb field is missing from the entry", () => {
    writeFileSync(
      cachePath,
      JSON.stringify({ "some/model.gguf::": { workloadName: "test" } }),
      "utf8",
    );
    expect(readMeasuredMemoryCache("some/model.gguf::")).toBeNull();
  });

  test("returns { peakMb } when key is present and valid", () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        "granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf::": makeEntry(
          "granite41-3b-judge-local",
          3800,
        ),
      }),
      "utf8",
    );
    expect(readMeasuredMemoryCache("granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf::")).toEqual({
      peakMb: 3800,
    });
  });
});

describe("writeMeasuredMemoryCache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "measured-mem-test-"));
    process.env[ORIG_ENV_KEY] = join(tmpDir, "measured-memory.json");
  });

  afterEach(() => {
    delete process.env[ORIG_ENV_KEY];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates the cache file and reads back correctly", () => {
    writeMeasuredMemoryCache("some/model.gguf::", makeEntry("test-workload", 4200));
    expect(readMeasuredMemoryCache("some/model.gguf::")).toEqual({ peakMb: 4200 });
  });

  test("merges entries without overwriting unrelated keys", () => {
    writeMeasuredMemoryCache("a.gguf::", makeEntry("a", 1100));
    writeMeasuredMemoryCache("b.gguf::", makeEntry("b", 2200));
    expect(readMeasuredMemoryCache("a.gguf::")).toEqual({ peakMb: 1100 });
    expect(readMeasuredMemoryCache("b.gguf::")).toEqual({ peakMb: 2200 });
  });

  test("overwrites an existing key on re-measurement", () => {
    writeMeasuredMemoryCache("model.gguf::", makeEntry("w", 5000));
    writeMeasuredMemoryCache("model.gguf::", makeEntry("w", 5500));
    expect(readMeasuredMemoryCache("model.gguf::")).toEqual({ peakMb: 5500 });
  });

  test("creates intermediate directories when cache path has nested dirs", () => {
    const nested = join(tmpDir, "a", "b", "c", "measured-memory.json");
    process.env[ORIG_ENV_KEY] = nested;
    writeMeasuredMemoryCache("model.gguf::", makeEntry("w", 3000));
    expect(readMeasuredMemoryCache("model.gguf::")).toEqual({ peakMb: 3000 });
  });
});
