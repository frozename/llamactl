import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  getLiveWorkloads,
  selectActiveWorkload,
  type LiveWorkload,
} from "../../src/hooks/workload-selection";

describe("useActiveWorkload helpers", () => {
  afterEach(() => {
    mock.restore();
  });

  test("empty live list resolves to null", () => {
    expect(getLiveWorkloads([])).toEqual([]);
    expect(selectActiveWorkload(null, [])).toBeNull();
  });

  test("single live workload resolves and stays selectable", () => {
    const live = getLiveWorkloads([
      { name: "gemma", spec: { enabled: true }, status: { phase: "Running" } },
    ]);
    expect(live).toEqual([{ name: "gemma", phase: "Running" } satisfies LiveWorkload]);
    expect(selectActiveWorkload(null, live)).toBe("gemma");
    expect(selectActiveWorkload("gemma", live)).toBe("gemma");
  });

  test("stored selection wins until cleared, then falls back alphabetically", () => {
    const live = getLiveWorkloads([
      { name: "granite", spec: { enabled: true }, status: { phase: "Running" } },
      { name: "gemma", spec: { enabled: true }, status: { phase: "Pending" } },
    ]);
    expect(live.map((w) => w.name)).toEqual(["gemma", "granite"]);
    expect(selectActiveWorkload("granite", live)).toBe("granite");
    expect(selectActiveWorkload(null, live)).toBe("gemma");
  });
});
