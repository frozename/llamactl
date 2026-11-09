import { describe, expect, test } from "bun:test";

/**
 * RED pins for #521 (F-3 follow-up): named perf suites resolvable by id.
 * `../../src/perf/suites.js` does not exist yet, so every case loads the
 * module through a guarded dynamic import — a missing module resolves to
 * an empty namespace and the assertions fail, never the file load.
 */

async function load(): Promise<Record<string, unknown>> {
  const mod: unknown = await import("../../src/perf/suites.js").catch(() => ({}));
  return mod as Record<string, unknown>;
}

async function loadIndex(): Promise<Record<string, unknown>> {
  const mod: unknown = await import("../../src/index.js").catch(() => ({}));
  return mod as Record<string, unknown>;
}

type ResolvePerfSuite = ((id: string) => unknown) | undefined;

describe("perf suite registry", () => {
  test("suites module exposes resolvePerfSuite and the PERF_SUITES registry", async () => {
    const mod = await load();

    expect(typeof mod["resolvePerfSuite"]).toBe("function");
    const registry = (mod["PERF_SUITES"] ?? {}) as Record<string, unknown>;
    expect(Object.keys(registry).sort()).toEqual(["perf-full", "perf-quick"]);
  });

  test("resolvePerfSuite('perf-quick') returns the quick preset", async () => {
    const mod = await load();
    const resolve = mod["resolvePerfSuite"] as ResolvePerfSuite;

    expect(resolve).toBeDefined();
    expect(resolve?.("perf-quick")).toEqual({
      decodeTokens: 16,
      concurrencyPromptWords: 128,
    });
  });

  test("resolvePerfSuite('perf-full') returns the full preset", async () => {
    const mod = await load();
    const resolve = mod["resolvePerfSuite"] as ResolvePerfSuite;

    expect(resolve).toBeDefined();
    expect(resolve?.("perf-full")).toEqual({
      decodeTokens: 64,
      concurrencyPromptWords: 512,
    });
  });

  test("resolvePerfSuite rejects an unknown id naming the valid suites", async () => {
    const mod = await load();
    const resolve = mod["resolvePerfSuite"] as ResolvePerfSuite;

    expect(resolve).toBeDefined();
    let thrown: unknown;
    try {
      resolve?.("nope");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("unknown perf suite 'nope'");
    expect(message).toContain("perf-quick");
    expect(message).toContain("perf-full");
  });

  test("the package barrel exposes the perf suite surface", async () => {
    const mod = await loadIndex();

    for (const name of ["runPerfSuite", "createHttpPerfEngineClient", "resolvePerfSuite"]) {
      expect(typeof mod[name]).toBe("function");
    }
  });
});
