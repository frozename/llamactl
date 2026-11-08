import { describe, expect, it } from "bun:test";

import { parseProcMeminfo, parseVmStatOutput, probeNodeMem } from "../src/node-probe.js";
import * as nodeProbeNs from "../src/node-probe.js";

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

// DF-04 remainder (#277): Linux GTT observation. probeGpuGtt does not exist at
// the pinned base; it is reached through a namespace import plus a structural
// cast so a missing export fails by assertion, never by a module-link error.
const GiB = 1024 * 1024 * 1024;
const NOW = 1_000_000_000_000;

type GpuGttObservation = {
  status: "ok" | "unavailable" | "denied" | "unsupported";
  totalBytes: number | null;
  usedBytes: number | null;
  observedAtMs: number | null;
  source: string;
  scope: "shared" | "process" | "unknown";
};

type GpuGttProbeOptions = {
  platform?: NodeJS.Platform;
  readDir?: (path: string) => Promise<string[]>;
  readFile?: (path: string) => Promise<string>;
  now?: () => number;
};

type ProbeApi = {
  probeGpuGtt: (opts: GpuGttProbeOptions) => Promise<GpuGttObservation>;
};

const probeApi = nodeProbeNs as unknown as Partial<ProbeApi>;

function enoent(): Error {
  return Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
}

describe("probeGpuGtt", () => {
  const DRM_DIR = "/sys/class/drm";
  const CARD1_DEVICE = `${DRM_DIR}/card1/device`;

  it("reads GTT counters from the first card device exposing them", async () => {
    const probe = probeApi.probeGpuGtt;
    expect(typeof probe).toBe("function");
    const readPaths: string[] = [];
    const readDirPaths: string[] = [];
    const result = await probe!({
      platform: "linux",
      readDir: (path: string) => {
        readDirPaths.push(path);
        return Promise.resolve(["card0", "card0-eDP-1", "card1", "renderD128", "version"]);
      },
      readFile: (path: string) => {
        readPaths.push(path);
        if (path === `${CARD1_DEVICE}/mem_info_gtt_total`) {
          return Promise.resolve("68719476736\n");
        }
        if (path === `${CARD1_DEVICE}/mem_info_gtt_used`) {
          return Promise.resolve("4294967296\n");
        }
        return Promise.reject(enoent());
      },
      now: () => NOW,
    });
    expect(result).toEqual({
      status: "ok",
      totalBytes: 64 * GiB,
      usedBytes: 4 * GiB,
      observedAtMs: NOW,
      source: CARD1_DEVICE,
      scope: "shared",
    });
    expect(readDirPaths).toContain(DRM_DIR);
    for (const path of readPaths) {
      expect(path).not.toContain("card0-eDP-1");
      expect(path).not.toContain("renderD128");
      expect(path).not.toContain("version");
    }
  });

  it("returns unsupported on darwin and win32 without touching injected IO", async () => {
    const probe = probeApi.probeGpuGtt;
    expect(typeof probe).toBe("function");
    const calls: string[] = [];
    for (const platform of ["darwin", "win32"] as const) {
      const result = await probe!({
        platform,
        readDir: () => {
          calls.push("readDir");
          throw new Error("readDir must not be called");
        },
        readFile: () => {
          calls.push("readFile");
          throw new Error("readFile must not be called");
        },
        now: () => {
          calls.push("now");
          throw new Error("now must not be called");
        },
      });
      expect(result).toMatchObject({
        status: "unsupported",
        totalBytes: null,
        usedBytes: null,
      });
    }
    expect(calls).toEqual([]);
  });

  it("reports unavailable when the DRM directory cannot be listed", async () => {
    const probe = probeApi.probeGpuGtt;
    expect(typeof probe).toBe("function");
    const result = await probe!({
      platform: "linux",
      readDir: () => Promise.reject(new Error("cannot list")),
      readFile: () => Promise.reject(enoent()),
      now: () => NOW,
    });
    expect(result).toMatchObject({ status: "unavailable", totalBytes: null, usedBytes: null });
  });

  it("reports unavailable when no card exposes GTT files", async () => {
    const probe = probeApi.probeGpuGtt;
    expect(typeof probe).toBe("function");
    const result = await probe!({
      platform: "linux",
      readDir: () => Promise.resolve(["card0", "card1", "renderD128"]),
      readFile: () => Promise.reject(enoent()),
      now: () => NOW,
    });
    expect(result).toMatchObject({ status: "unavailable", totalBytes: null, usedBytes: null });
  });

  it("reports denied when GTT reads are permission-denied", async () => {
    const probe = probeApi.probeGpuGtt;
    expect(typeof probe).toBe("function");
    const eacces = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const result = await probe!({
      platform: "linux",
      readDir: () => Promise.resolve(["card0"]),
      readFile: () => Promise.reject(eacces),
      now: () => NOW,
    });
    expect(result).toMatchObject({ status: "denied", totalBytes: null, usedBytes: null });
  });

  it("orders card devices numerically rather than lexicographically", async () => {
    const probe = probeApi.probeGpuGtt;
    expect(typeof probe).toBe("function");
    const card2Device = `${DRM_DIR}/card2/device`;
    const card10Device = `${DRM_DIR}/card10/device`;
    const result = await probe!({
      platform: "linux",
      readDir: () => Promise.resolve(["card10", "card2"]),
      readFile: (path: string) => {
        if (path === `${card2Device}/mem_info_gtt_total`) {
          return Promise.resolve("68719476736\n");
        }
        if (path === `${card2Device}/mem_info_gtt_used`) {
          return Promise.resolve("4294967296\n");
        }
        if (path === `${card10Device}/mem_info_gtt_total`) {
          return Promise.resolve("137438953472\n");
        }
        if (path === `${card10Device}/mem_info_gtt_used`) {
          return Promise.resolve("8589934592\n");
        }
        return Promise.reject(enoent());
      },
      now: () => NOW,
    });
    expect(result).toMatchObject({
      status: "ok",
      totalBytes: 64 * GiB,
      usedBytes: 4 * GiB,
      source: card2Device,
    });
  });

  it("keeps probeNodeMem snapshots free of GTT fields", async () => {
    const snap = await probeNodeMem({
      platform: "linux",
      readFile: () => Promise.resolve(MEMINFO),
      exec: () => {
        throw new Error("exec must not be called on linux");
      },
    });
    expect(snap).toEqual(parseProcMeminfo(MEMINFO));
    expect(snap.free_mb).toBe(40000);
    expect("gtt" in snap).toBe(false);
  });
});
