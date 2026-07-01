import { describe, expect, it } from "bun:test";

import { parseVmStatOutput } from "../src/node-probe.js";

const FAKE_VM_STAT = `
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                         1031.
Pages active:                        912.
Pages inactive:                      839.
Pages wired down:                    320.
Pages occupied by compressor:       2600.
Swapins:                               0.
Swapouts:                              0.
`.trim();

describe("parseVmStatOutput", () => {
  it("produces correct NodeMemSnapshot from known output", () => {
    const snap = parseVmStatOutput(FAKE_VM_STAT);
    expect(snap.available).not.toBe(false);
    expect(snap.free_mb).toBeCloseTo((1031 * 16384) / 1024 / 1024, 0);
    expect(snap.active_mb).toBeCloseTo((912 * 16384) / 1024 / 1024, 0);
    expect(snap.compressor_mb).toBeCloseTo((2600 * 16384) / 1024 / 1024, 0);
    expect(snap.swap_in).toBe(0);
    expect(snap.swap_out).toBe(0);
  });

  it("keeps complete page samples available when swap fields are missing", () => {
    const snap = parseVmStatOutput(
      `
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                         1031.
Pages active:                        912.
Pages inactive:                      839.
Pages wired down:                    320.
Pages occupied by compressor:       2600.
`.trim(),
    );
    expect(snap.available).not.toBe(false);
    expect(snap.free_mb).toBeCloseTo((1031 * 16384) / 1024 / 1024, 0);
    expect(snap.swap_in).toBe(0);
    expect(snap.swap_out).toBe(0);
  });
});
