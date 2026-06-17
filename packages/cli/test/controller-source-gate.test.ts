import { describe, expect, it } from "bun:test";

import { applyControllerSourceGate, parseFlags } from "../src/commands/controller.js";

/**
 * Unit coverage for the controller's source-staleness wiring — the exported
 * helper + flag parsing — without the slow spawn-e2e. The reducer truth table
 * lives in core's sourceRevision.test.ts; here we pin only the controller-side
 * contract: feature-off inertness, streak advance, debounce, fail-safe, and the
 * --no-reload-on-source-change flag.
 */

describe("applyControllerSourceGate", () => {
  it("is inert when startupRev is null (not a git checkout) — feature off", () => {
    const r = applyControllerSourceGate(
      { streak: 5 },
      { startupRev: null, readSourceRevision: () => "bbb" },
    );
    // No streak mutation, never reloads, no rev surfaced — the gate must not even
    // read the source when detection is disabled.
    expect(r).toEqual({ nextState: { streak: 5 }, shouldReload: false, currentRev: null });
  });

  it("is inert when startupRev is undefined", () => {
    const r = applyControllerSourceGate(
      { streak: 0 },
      { startupRev: undefined, readSourceRevision: () => "bbb" },
    );
    expect(r).toEqual({ nextState: { streak: 0 }, shouldReload: false, currentRev: null });
  });

  it("same rev as startup -> streak 0, no reload", () => {
    const r = applyControllerSourceGate(
      { streak: 0 },
      { startupRev: "aaa", readSourceRevision: () => "aaa" },
    );
    expect(r).toEqual({ nextState: { streak: 0 }, shouldReload: false, currentRev: "aaa" });
  });

  it("changed once below threshold -> advances streak, no reload yet", () => {
    const r = applyControllerSourceGate(
      { streak: 0 },
      { startupRev: "aaa", readSourceRevision: () => "bbb", reloadStaleChecks: 2 },
    );
    expect(r).toEqual({ nextState: { streak: 1 }, shouldReload: false, currentRev: "bbb" });
  });

  it("changed and debounce satisfied -> reload", () => {
    const r = applyControllerSourceGate(
      { streak: 1 },
      { startupRev: "aaa", readSourceRevision: () => "bbb", reloadStaleChecks: 2 },
    );
    expect(r).toEqual({ nextState: { streak: 2 }, shouldReload: true, currentRev: "bbb" });
  });

  it("null read -> streak unchanged, no reload (fail-safe, not a rev change)", () => {
    const r = applyControllerSourceGate(
      { streak: 1 },
      { startupRev: "aaa", readSourceRevision: () => null },
    );
    expect(r.shouldReload).toBe(false);
    expect(r.nextState).toEqual({ streak: 1 });
    expect(r.currentRev).toBeNull();
  });
});

describe("controller parseFlags --no-reload-on-source-change", () => {
  it("defaults reloadOnSourceChange to true", () => {
    const r = parseFlags([]);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.reloadOnSourceChange).toBe(true);
  });

  it("--no-reload-on-source-change sets it false", () => {
    const r = parseFlags(["--no-reload-on-source-change"]);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.reloadOnSourceChange).toBe(false);
  });

  it("coexists with --interval and --once", () => {
    const r = parseFlags(["--interval=5", "--no-reload-on-source-change", "--once"]);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.reloadOnSourceChange).toBe(false);
    expect(r.once).toBe(true);
    expect(r.intervalMs).toBe(5000);
  });

  it("still rejects genuinely unknown flags (fail-closed)", () => {
    const r = parseFlags(["--definitely-not-a-flag"]);
    expect("error" in r).toBe(true);
  });
});
