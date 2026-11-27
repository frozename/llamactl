// RED pins for frozename/llamactl#367: process memory attribution reads the
// control process footprint directly from procfs on Linux and proc_pid_rusage
// on macOS, keeps the Linux RSS split source-attributed, and never throws
// platform or probe failures into the metrics path. The module does not exist
// at the pinned base; every case reaches it dynamically and asserts each
// export's type first so a missing export fails by assertion, never by a link
// error.
import { describe, expect, test } from "bun:test";

const MiB = 1024 * 1024;
// Widened to `string` on purpose: a literal specifier would let `tsc`
// resolve (and fail on) the not-yet-existing module at base.
const PROCESS_MEMORY_MODULE = "../src/server/process-memory.js" as string;

type LinuxProcStatusMemory = {
  rssAnonBytes: number | null;
  rssFileBytes: number | null;
  rssShmemBytes: number | null;
  swapBytes: number | null;
};

type DarwinRusageV0Memory = {
  residentBytes: number;
  physFootprintBytes: number;
};

type ProcessMemoryAttribution = {
  footprint: {
    status: "ok" | "unavailable" | "denied" | "unsupported";
    bytes: number | null;
    source: string;
  };
  rssAnonBytes?: number | null;
  rssFileBytes?: number | null;
  rssShmemBytes?: number | null;
  swapBytes?: number | null;
};

const LINUX_SPLIT_KEYS = ["rssAnonBytes", "rssFileBytes", "rssShmemBytes", "swapBytes"] as const;

type ProcessMemoryModule = {
  parseLinuxProcStatusMemory: (text: string) => LinuxProcStatusMemory | null;
  decodeDarwinRusageV0: (bytes: Uint8Array) => DarwinRusageV0Memory | null;
  createProcessMemoryReader: (deps: {
    platform: string;
    readLinuxProcStatus?: () => string;
    readDarwinRusageV0?: () => Uint8Array | null;
  }) => () => ProcessMemoryAttribution;
  defaultProcessMemoryReader: () => () => ProcessMemoryAttribution;
};

async function loadProcessMemoryModule(): Promise<ProcessMemoryModule> {
  const mod = (await import(PROCESS_MEMORY_MODULE).catch(() => ({}))) as Record<string, unknown>;
  expect(typeof mod["parseLinuxProcStatusMemory"]).toBe("function");
  expect(typeof mod["decodeDarwinRusageV0"]).toBe("function");
  expect(typeof mod["createProcessMemoryReader"]).toBe("function");
  expect(typeof mod["defaultProcessMemoryReader"]).toBe("function");
  return mod as unknown as ProcessMemoryModule;
}

const LINUX_PROC_STATUS_FIXTURE = [
  "Name:\tllamactl-agent",
  "VmRSS:\t  307200 kB",
  "RssAnon:\t  153600 kB",
  "RssFile:\t  140000 kB",
  "RssShmem:\t   13600 kB",
  "VmSwap:\t    2048 kB",
  "",
].join("\n");

function rusageV0Bytes(residentBytes: bigint, physFootprintBytes: bigint): Uint8Array {
  const bytes = new Uint8Array(96);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(64, residentBytes, true);
  view.setBigUint64(72, physFootprintBytes, true);
  return bytes;
}

describe("parseLinuxProcStatusMemory", () => {
  test("parses the Linux RSS split and swap from /proc/self/status", async () => {
    const { parseLinuxProcStatusMemory } = await loadProcessMemoryModule();

    expect(parseLinuxProcStatusMemory(LINUX_PROC_STATUS_FIXTURE)).toEqual({
      rssAnonBytes: 153600 * 1024,
      rssFileBytes: 140000 * 1024,
      rssShmemBytes: 13600 * 1024,
      swapBytes: 2048 * 1024,
    });
  });

  test("reports absent and non-numeric fields as null rather than zero", async () => {
    const { parseLinuxProcStatusMemory } = await loadProcessMemoryModule();

    expect(
      parseLinuxProcStatusMemory(
        ["RssAnon:\tnot-a-number kB", "RssFile:\t  140000 kB", ""].join("\n"),
      ),
    ).toEqual({
      rssAnonBytes: null,
      rssFileBytes: 140000 * 1024,
      rssShmemBytes: null,
      swapBytes: null,
    });
  });

  test("returns null when none of the four split fields is present", async () => {
    const { parseLinuxProcStatusMemory } = await loadProcessMemoryModule();

    expect(
      parseLinuxProcStatusMemory(["Name:\tllamactl-agent", "VmRSS:\t  307200 kB", ""].join("\n")),
    ).toBeNull();
  });
});

describe("decodeDarwinRusageV0", () => {
  test("decodes resident size and physical footprint from the rusage_info_v0 layout", async () => {
    const { decodeDarwinRusageV0 } = await loadProcessMemoryModule();
    const bytes = rusageV0Bytes(BigInt(300 * MiB), BigInt(180 * MiB));

    expect(decodeDarwinRusageV0(bytes)).toEqual({
      residentBytes: 300 * MiB,
      physFootprintBytes: 180 * MiB,
    });
  });

  test("rejects a buffer shorter than the 96-byte rusage_info_v0 layout", async () => {
    const { decodeDarwinRusageV0 } = await loadProcessMemoryModule();

    expect(decodeDarwinRusageV0(new Uint8Array(95))).toBeNull();
  });

  test("rejects a physical footprint above the safe integer range", async () => {
    const { decodeDarwinRusageV0 } = await loadProcessMemoryModule();
    const bytes = rusageV0Bytes(1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n);

    expect(decodeDarwinRusageV0(bytes)).toBeNull();
  });
});

describe("createProcessMemoryReader", () => {
  test("charges anonymous RSS plus swap as the Linux footprint and keeps the split", async () => {
    const { createProcessMemoryReader } = await loadProcessMemoryModule();

    const attribution = createProcessMemoryReader({
      platform: "linux",
      readLinuxProcStatus: () => LINUX_PROC_STATUS_FIXTURE,
    })();

    expect(attribution.footprint).toEqual({
      status: "ok",
      bytes: (153600 + 2048) * 1024,
      source: "linux:/proc/self/status RssAnon+VmSwap",
    });
    expect(attribution.rssAnonBytes).toBe(153600 * 1024);
    expect(attribution.rssFileBytes).toBe(140000 * 1024);
    expect(attribution.rssShmemBytes).toBe(13600 * 1024);
    expect(attribution.swapBytes).toBe(2048 * 1024);
  });

  test("marks the Linux footprint unavailable when RssAnon or VmSwap is absent", async () => {
    const { createProcessMemoryReader } = await loadProcessMemoryModule();
    const fixtures = [
      {
        text: ["RssFile:\t  140000 kB", "RssShmem:\t   13600 kB", "VmSwap:\t    2048 kB", ""].join(
          "\n",
        ),
        rssFileBytes: 140000 * 1024,
        rssShmemBytes: 13600 * 1024,
        swapBytes: 2048 * 1024,
      },
      {
        text: ["RssAnon:\t  153600 kB", "RssFile:\t  140000 kB", "RssShmem:\t   13600 kB", ""].join(
          "\n",
        ),
        rssAnonBytes: 153600 * 1024,
        rssFileBytes: 140000 * 1024,
        rssShmemBytes: 13600 * 1024,
      },
    ];

    for (const fixture of fixtures) {
      const attribution = createProcessMemoryReader({
        platform: "linux",
        readLinuxProcStatus: () => fixture.text,
      })();

      expect(attribution.footprint.status).toBe("unavailable");
      expect(attribution.footprint.bytes).toBeNull();
      for (const key of LINUX_SPLIT_KEYS) {
        if (!(key in fixture)) continue;
        expect(attribution[key]).toBe((fixture as Partial<LinuxProcStatusMemory>)[key]);
      }
    }
  });

  test("marks the Linux footprint unavailable instead of throwing when procfs cannot be read", async () => {
    const { createProcessMemoryReader } = await loadProcessMemoryModule();

    const attribution = createProcessMemoryReader({
      platform: "linux",
      readLinuxProcStatus: () => {
        throw new Error("procfs unavailable");
      },
    })();

    expect(attribution.footprint.status).toBe("unavailable");
    expect(attribution.footprint.bytes).toBeNull();
  });

  test("charges ri_phys_footprint as the macOS footprint", async () => {
    const { createProcessMemoryReader } = await loadProcessMemoryModule();
    const bytes = rusageV0Bytes(BigInt(300 * MiB), BigInt(180 * MiB));

    const attribution = createProcessMemoryReader({
      platform: "darwin",
      readDarwinRusageV0: () => bytes,
    })();

    expect(attribution.footprint).toEqual({
      status: "ok",
      bytes: 180 * MiB,
      source: "darwin:proc_pid_rusage ri_phys_footprint",
    });
  });

  test("marks the macOS footprint unavailable when the injected rusage read fails", async () => {
    const { createProcessMemoryReader } = await loadProcessMemoryModule();
    const readers: (() => Uint8Array | null)[] = [
      (): Uint8Array | null => null,
      (): Uint8Array | null => {
        throw new Error("rusage unavailable");
      },
    ];

    for (const readDarwinRusageV0 of readers) {
      const attribution = createProcessMemoryReader({
        platform: "darwin",
        readDarwinRusageV0,
      })();

      expect(attribution.footprint.status).toBe("unavailable");
      expect(attribution.footprint.bytes).toBeNull();
    }
  });

  test("reports win32 unsupported without invoking either platform reader", async () => {
    const { createProcessMemoryReader } = await loadProcessMemoryModule();
    let linuxCalls = 0;
    let darwinCalls = 0;

    const attribution = createProcessMemoryReader({
      platform: "win32",
      readLinuxProcStatus: () => {
        linuxCalls += 1;
        return LINUX_PROC_STATUS_FIXTURE;
      },
      readDarwinRusageV0: () => {
        darwinCalls += 1;
        return null;
      },
    })();

    expect(attribution.footprint.status).toBe("unsupported");
    expect(attribution.footprint.bytes).toBeNull();
    expect(linuxCalls).toBe(0);
    expect(darwinCalls).toBe(0);
  });
});

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "defaultProcessMemoryReader reads this process footprint on macOS and Linux",
  async () => {
    const { defaultProcessMemoryReader } = await loadProcessMemoryModule();

    const attribution = defaultProcessMemoryReader()();
    expect(attribution.footprint.status).toBe("ok");
    expect(typeof attribution.footprint.bytes).toBe("number");
    if (attribution.footprint.bytes !== null) {
      expect(Number.isSafeInteger(attribution.footprint.bytes)).toBe(true);
      expect(attribution.footprint.bytes).toBeGreaterThan(0);
    }
  },
);
