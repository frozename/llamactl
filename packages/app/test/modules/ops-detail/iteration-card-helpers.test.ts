import { afterAll, describe, expect, mock, test } from "bun:test";

import type { IterationView } from "../../../src/lib/use-ops-session";

import { fmtMs, statusGlyph } from "../../../src/modules/ops/detail/iteration-card-helpers";

// Snapshot the real exports before registering the mocks. mock.module is
// process-global, so re-registering the snapshots in afterAll keeps later
// test files in this bun process on the real modules.
const ThemesActual = { ...(await import("../../../src/themes/index")) };
const UiActual = { ...(await import("../../../src/ui/index")) };

void mock.module("@/themes", () => ({}));
void mock.module("@/ui", () => ({ Badge: (): null => null }));

afterAll(() => {
  void mock.module("@/themes", () => ThemesActual);
  void mock.module("@/ui", () => UiActual);
});

const base: IterationView = {
  iteration: 0,
  stepId: "sp-1",
  tool: "llamactl.workload.list",
  tier: "read",
  reasoning: "",
  args: {},
};

describe("statusGlyph", () => {
  test("returns · when no outcome attached", () => {
    expect(statusGlyph(base)).toBe("·");
  });

  test("returns ✓ when wet outcome ok", () => {
    expect(statusGlyph({ ...base, wet: { ok: true, durationMs: 1 } })).toBe("✓");
  });

  test("returns ✗ when wet outcome failed", () => {
    expect(statusGlyph({ ...base, wet: { ok: false, durationMs: 1 } })).toBe("✗");
  });

  test("falls back to preview outcome when wet absent", () => {
    expect(statusGlyph({ ...base, preview: { ok: true, durationMs: 1 } })).toBe("✓");
  });
});

describe("fmtMs", () => {
  test("< 1000ms → ms suffix", () => {
    expect(fmtMs(750)).toBe("750ms");
  });

  test("≥ 1000ms → seconds with one decimal", () => {
    expect(fmtMs(1234)).toBe("1.2s");
  });
});
