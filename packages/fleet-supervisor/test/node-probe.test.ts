import { describe, expect, it } from "bun:test";

import { parseProcMeminfo, parseVmStatOutput, probeNodeMem } from "../src/node-probe.js";

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
    expect(snap.unavailable_reason).toBeUndefined();
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

const MEMINFO = `
MemTotal:       65536000 kB
MemFree:         2048000 kB
MemAvailable:   40960000 kB
Buffers:          512000 kB
Cached:         30000000 kB
Active:         20480000 kB
Inactive:       15360000 kB
Active(anon):    9999999 kB
Unevictable:       65536 kB
SwapTotal:       8388608 kB
SwapFree:        6291456 kB
`.trim();

describe("parseProcMeminfo", () => {
  it("produces correct NodeMemSnapshot from known /proc/meminfo output", () => {
    const snap = parseProcMeminfo(MEMINFO);
    expect(snap.available).not.toBe(false);
    expect(snap.unavailable_reason).toBeUndefined();
    expect(snap.free_mb).toBe(40000);
    expect(snap.active_mb).toBe(20000);
    expect(snap.wired_mb).toBe(64);
    expect(snap.compressor_mb).toBe(2048);
    expect(snap.inactive_mb).toBe(0);
    expect(snap.swap_in).toBe(0);
    expect(snap.swap_out).toBe(0);
  });

  it("reports zero compressor when swap is not configured", () => {
    const snap = parseProcMeminfo(
      `
MemTotal:       65536000 kB
MemAvailable:   40960000 kB
SwapTotal:            0 kB
SwapFree:             0 kB
`.trim(),
    );
    expect(snap.compressor_mb).toBe(0);
    expect(snap.available).not.toBe(false);
  });
});

describe("probeNodeMem platform routing", () => {
  it("reads /proc/meminfo on linux without calling exec", async () => {
    let readPath = "";
    const snap = await probeNodeMem({
      platform: "linux",
      readFile: (path: string) => {
        readPath = path;
        return Promise.resolve(MEMINFO);
      },
      exec: () => {
        throw new Error("exec must not be called on linux");
      },
    });
    expect(readPath).toBe("/proc/meminfo");
    expect(snap).toEqual(parseProcMeminfo(MEMINFO));
  });

  it("runs vm_stat on darwin without calling readFile", async () => {
    const snap = await probeNodeMem({
      platform: "darwin",
      exec: (_cmd: string) => Promise.resolve(FAKE_VM_STAT),
      readFile: (_path: string) => {
        throw new Error("readFile must not be called on darwin");
      },
    });
    expect(snap).toEqual(parseVmStatOutput(FAKE_VM_STAT));
  });

  it("returns an unavailable zeroed snapshot on unsupported platforms", async () => {
    const snap = await probeNodeMem({
      platform: "win32",
      exec: () => {
        throw new Error("exec must not be called on win32");
      },
      readFile: () => {
        throw new Error("readFile must not be called on win32");
      },
    });
    expect(snap.available).toBe(false);
    expect(snap.unavailable_reason).toBe("unsupported-platform");
    expect(snap.free_mb).toBe(0);
    expect(snap.active_mb).toBe(0);
    expect(snap.inactive_mb).toBe(0);
    expect(snap.wired_mb).toBe(0);
    expect(snap.compressor_mb).toBe(0);
    expect(snap.swap_in).toBe(0);
    expect(snap.swap_out).toBe(0);
  });
});
