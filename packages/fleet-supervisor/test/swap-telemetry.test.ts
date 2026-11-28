import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FleetJournalEntry } from "../src/types.js";

import { startSupervisorLoop } from "../src/loop.js";
import { probeNodeMem } from "../src/node-probe.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

const MEMINFO = "MemTotal: 65536000 kB\nMemAvailable: 40960000 kB\n";
const DARWIN = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 1031.
Pages active: 912.
Pages inactive: 839.
Pages wired down: 320.
Pages occupied by compressor: 2600.
Pageins: 99.
Pageouts: 42.
Swapins: 8.
Swapouts: 4.
`;

function linuxProbe(
  vmstat: string,
  observedAtMs: number,
  pageSize = "65536",
): ReturnType<typeof probeNodeMem> {
  const options = {
    platform: "linux" as const,
    readFile: (path: string): Promise<string> =>
      Promise.resolve(path === "/proc/meminfo" ? MEMINFO : vmstat),
    readPageSize: (): string => pageSize,
    now: (): number => observedAtMs,
  };
  return probeNodeMem(options);
}

function darwinProbe(raw: string, observedAtMs: number): ReturnType<typeof probeNodeMem> {
  return probeNodeMem({
    platform: "darwin",
    exec: (): Promise<string> => Promise.resolve(raw),
    now: (): number => observedAtMs,
  });
}

describe("swap I/O observations", () => {
  it("records Linux pswp page counters in bytes with the measured page size", async () => {
    const snap = await linuxProbe("pswpin 4\npgpgin 97\npswpout 6\npgpgout 123\n", 77);
    expect(snap).toMatchObject({
      swap_in: 0,
      swap_out: 0,
      free_mb: 40_000,
      swap_io: {
        status: "ok",
        source: "/proc/vmstat",
        observedAtMs: 77,
        swapInBytes: 4 * 65_536,
        swapOutBytes: 6 * 65_536,
      },
    });
  });

  it("records macOS swap I/O from vm_stat rather than ordinary page faults", async () => {
    expect(await darwinProbe(DARWIN, 91)).toMatchObject({
      swap_in: 8,
      swap_out: 4,
      swap_io: {
        status: "ok",
        source: "vm_stat",
        observedAtMs: 91,
        swapInBytes: 8 * 16_384,
        swapOutBytes: 4 * 16_384,
      },
    });
  });

  it("distinguishes actual zero counters from unavailable unit or counter evidence", async () => {
    expect(await linuxProbe("pswpin 0\npswpout 0", 101)).toMatchObject({
      swap_io: { status: "ok", swapInBytes: 0, swapOutBytes: 0 },
    });
    for (const [vmstat, pageSize] of [
      ["pswpin 0\npswpout 0", ""],
      ["pswpin 0\npswpout 0", "4096 bytes"],
      ["pswpin 0\npgpgout 0", "4096"],
      ["pswpin\n5\npswpout 0", "4096"],
      ["pswpin 9007199254740991\npswpout 0", "4096"],
    ]) {
      expect(await linuxProbe(vmstat ?? "", 101, pageSize)).toMatchObject({
        swap_io: { status: "unavailable", swapInBytes: null, swapOutBytes: null },
      });
    }
    expect(await darwinProbe(DARWIN.split("\n").slice(1).join("\n"), 101)).toMatchObject({
      swap_io: { status: "unavailable", swapInBytes: null, swapOutBytes: null },
    });
  });

  it("journals rates from consecutive source observations and recovers after gaps or resets", async () => {
    const samples = [
      { ts: 1000, vmstat: "pswpin 2\npswpout 0" },
      { ts: 3000, vmstat: "pswpin 8\npswpout 4" },
      { ts: 5000, vmstat: "pswpin 1\npswpout 0" },
      { ts: 6000, vmstat: "" },
      { ts: 7000, vmstat: "pswpin 6\npswpout 6" },
      { ts: 20_000, vmstat: "pswpin 8\npswpout 8" },
      { ts: 21_000, vmstat: "pswpin 9\npswpout 10" },
      { ts: 22_000, vmstat: null },
    ];
    const dir = mkdtempSync(join(tmpdir(), "llamactl-swap-telemetry-"));
    const journalPath = join(dir, "journal.jsonl");
    let tick = 0;
    let time = 0;
    try {
      const handle = startSupervisorLoop({
        node: "local",
        intervalMs: 1,
        workloads: [],
        journalPath,
        swapRateNow: () => time,
        probeNodeMem: () => {
          const sample = samples[tick];
          if (sample === undefined) throw new Error("unexpected extra tick");
          time = sample.ts;
          return sample.vmstat === null
            ? darwinProbe(DARWIN, time)
            : linuxProbe(sample.vmstat, time, "4096");
        },
        onTick: () => {
          tick++;
          if (tick === samples.length) handle.stop();
        },
      });
      await handle.done;
      const published = (await Bun.file(journalPath).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as FleetJournalEntry)
        .filter((entry) => entry.kind === "fleet-snapshot");

      expect(published).toMatchObject([
        { swapRate: { known: false, reason: "unknown-source" } },
        {
          swapRate: {
            known: true,
            source: "/proc/vmstat",
            intervalMs: 2000,
            swapInBytesPerSec: 3 * 4096,
            swapOutBytesPerSec: 2 * 4096,
          },
        },
        { swapRate: { known: false, reason: "counter-reset" } },
        { swapRate: { known: false, reason: "unknown-source" } },
        { swapRate: { known: false, reason: "unknown-source" } },
        { swapRate: { known: false, reason: "stale-source" } },
        {
          swapRate: {
            known: true,
            source: "/proc/vmstat",
            intervalMs: 1000,
            swapInBytesPerSec: 4096,
            swapOutBytesPerSec: 2 * 4096,
          },
        },
        { swapRate: { known: false, reason: "source-changed" } },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
