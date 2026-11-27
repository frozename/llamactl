import { projectManagedCapacity } from "@llamactl/core/resources/managed-capacity";
import { expect, test } from "bun:test";

import {
  type LocalManagedCapacityDeps,
  readLocalManagedCapacity,
} from "../../src/residency/local-managed-capacity.js";

const GiB = 1024 ** 3;
const NOW = 100_000;
const PSI =
  "some avg10=0.00 avg60=0.00 avg300=0.00 total=42\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=18\n";
const PROC_MEMINFO =
  "MemTotal: 67108864 kB\nMemAvailable: 58720256 kB\nSwapTotal: 4194304 kB\nSwapFree: 4194304 kB\n";
const MOUNT = "36 25 0:32 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n";
const CGROUP = "/sys/fs/cgroup";

function linuxFixture(overrides: Record<string, string> = {}): LocalManagedCapacityDeps {
  const files: Record<string, string> = {
    "/proc/meminfo": PROC_MEMINFO,
    "/proc/pressure/memory": PSI,
    "/proc/self/mountinfo": MOUNT,
    "/proc/self/cgroup": "0::/\n",
    [`${CGROUP}/cgroup.controllers`]: "cpuset cpu io memory hugetlb pids\n",
    ...overrides,
  };
  return {
    platform: "linux",
    nowMs: () => NOW,
    readFile: (path): string => {
      const value = files[path];
      if (value === undefined)
        throw Object.assign(new Error("missing fixture"), { code: "ENOENT" });
      return value;
    },
    exec: (): never => {
      throw new Error("Linux measurements must come from procfs and cgroupfs");
    },
  };
}

test("a finite configured budget cannot override fresh physical capacity or host reserve", () => {
  const sample = readLocalManagedCapacity(linuxFixture());
  expect(sample).toMatchObject({
    source: "linux-procfs",
    physicalBytes: 64 * GiB,
    availableBytes: 56 * GiB,
    pressure: "normal",
    swapUsedBytes: 0,
    scope: { kind: "host-physical" },
  });
  expect(projectManagedCapacity(sample, { nowMs: NOW, configuredBudgetGiB: 96 })).toMatchObject({
    ok: true,
    ledgerCeilingGiB: 48,
    launchHeadroomGiB: 40,
    budgetGiB: 40,
    hostReserveGiB: 16,
  });
  expect(
    projectManagedCapacity(sample, {
      nowMs: NOW,
      safetyMarginRatio: 1,
      hostReserveGiB: 18,
      configuredBudgetGiB: 37,
    }),
  ).toMatchObject({ ok: true, ledgerCeilingGiB: 37, launchHeadroomGiB: 38, budgetGiB: 37 });
});

test("Linux bounds physical and current launch bytes by every visible finite memory ancestor", () => {
  const parent = `${CGROUP}/parent`;
  const child = `${parent}/child`;
  const sample = readLocalManagedCapacity(
    linuxFixture({
      "/proc/self/cgroup": "0::/parent/child\n",
      [`${parent}/memory.max`]: String(12 * GiB),
      [`${parent}/memory.current`]: String(5 * GiB),
      [`${parent}/memory.pressure`]: PSI,
      [`${child}/memory.max`]: String(16 * GiB),
      [`${child}/memory.current`]: String(3 * GiB),
      [`${child}/memory.pressure`]: PSI,
    }),
  );
  expect(sample).toMatchObject({
    physicalBytes: 64 * GiB,
    scope: { kind: "cgroup-v2", limitBytes: 12 * GiB, availableBytes: 7 * GiB },
  });
  expect(projectManagedCapacity(sample, { nowMs: NOW, configuredBudgetGiB: 96 })).toMatchObject({
    ok: true,
    ledgerCeilingGiB: 12,
    launchHeadroomGiB: 7,
    budgetGiB: 7,
  });
});

test("Linux does not fall back to host capacity when an ancestor or the real root cannot be proven", () => {
  const samples = [
    linuxFixture({ [`${CGROUP}/memory.max`]: "max\n" }),
    linuxFixture({ "/proc/self/cgroup": "0::/parent/child\n" }),
    linuxFixture({ "/proc/self/cgroup": "2:memory:/legacy\n" }),
    linuxFixture({ "/proc/self/mountinfo": MOUNT.replace(" / /sys/", " /container /sys/") }),
  ];
  for (const deps of samples) {
    const sample = readLocalManagedCapacity(deps);
    expect(sample.scope).toEqual({ kind: "unknown" });
    expect(projectManagedCapacity(sample, { nowMs: NOW, configuredBudgetGiB: 6 })).toEqual({
      ok: false,
      reason: "CapacityScopeUnknown",
    });
  }
});

test("a finite override cannot convert stale, future, unknown or contradictory observations into a budget", () => {
  const baseline = readLocalManagedCapacity(linuxFixture());
  const options = { nowMs: NOW, configuredBudgetGiB: 20 };
  expect(projectManagedCapacity(undefined, options)).toEqual({
    ok: false,
    reason: "CapacityUnknown",
  });
  expect(projectManagedCapacity({ ...baseline, observedAtMs: NOW - 30_001 }, options)).toEqual({
    ok: false,
    reason: "StaleCapacity",
  });
  expect(projectManagedCapacity({ ...baseline, observedAtMs: NOW + 1 }, options)).toEqual({
    ok: false,
    reason: "InvalidCapacity",
  });
  const noPhysical = readLocalManagedCapacity(
    linuxFixture({ "/proc/meminfo": PROC_MEMINFO.replace("MemTotal:", "Unknown:") }),
  );
  expect(projectManagedCapacity(noPhysical, options)).toEqual({
    ok: false,
    reason: "CapacityUnknown",
  });
  expect(projectManagedCapacity({ ...baseline, availableBytes: 65 * GiB }, options)).toEqual({
    ok: false,
    reason: "InvalidCapacity",
  });
  expect(projectManagedCapacity(baseline, { ...options, hostReserveGiB: 56 })).toEqual({
    ok: false,
    reason: "NoMemoryHeadroom",
  });
});

test("Linux missing pressure or swap is distinct from known normal pressure or zero swap", () => {
  const capacity = (overrides: Record<string, string>): ReturnType<typeof projectManagedCapacity> =>
    projectManagedCapacity(readLocalManagedCapacity(linuxFixture(overrides)), { nowMs: NOW });
  expect(capacity({ "/proc/pressure/memory": "" })).toEqual({
    ok: false,
    reason: "PressureUnknown",
  });
  expect(
    capacity({ "/proc/pressure/memory": PSI.replace("some avg10=0.00", "some avg10=0.01") }),
  ).toEqual({
    ok: false,
    reason: "MemoryPressure",
  });
  expect(capacity({ "/proc/meminfo": PROC_MEMINFO.replace("SwapFree:", "Unknown:") })).toEqual({
    ok: false,
    reason: "SwapUnknown",
  });
  const swap = readLocalManagedCapacity(
    linuxFixture({
      "/proc/meminfo": PROC_MEMINFO.replace("SwapFree: 4194304", "SwapFree: 3145728"),
    }),
  );
  expect(swap.swapUsedBytes).toBe(GiB);
  expect(projectManagedCapacity(swap, { nowMs: NOW })).toEqual({ ok: false, reason: "SwapUsed" });
  expect(projectManagedCapacity(swap, { nowMs: NOW, maxSwapUsedGiB: 1 })).toMatchObject({
    ok: true,
    budgetGiB: 40,
  });
});

test("Darwin uses exact page units and pressure flags without assuming swap or reclaimable bytes", () => {
  const outputs: Record<string, string> = {
    "hw.memsize": String(32 * GiB),
    "kern.memorystatus_vm_pressure_level": "1\n",
    "vm.swapusage": "total = 1024.00M  used = 0.00M  free = 1024.00M  (encrypted)\n",
    vm_stat:
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1048576.\nPages inactive: 524288.\n",
  };
  const deps: LocalManagedCapacityDeps = {
    platform: "darwin",
    nowMs: () => NOW,
    readFile: () => {
      throw new Error("Darwin measurements must come from the kernel utilities");
    },
    exec: (_file, args) => outputs[args.at(-1) ?? "vm_stat"] ?? "",
  };
  const sample = readLocalManagedCapacity(deps);
  expect(sample).toMatchObject({
    physicalBytes: 32 * GiB,
    availableBytes: 16 * GiB,
    pressure: "normal",
    swapUsedBytes: 0,
    source: "darwin-vm",
    scope: { kind: "host-physical" },
  });
  expect(projectManagedCapacity(sample, { nowMs: NOW })).toMatchObject({ ok: true, budgetGiB: 8 });
  outputs["kern.memorystatus_vm_pressure_level"] = "0";
  expect(readLocalManagedCapacity(deps).pressure).toBeNull();
  outputs["kern.memorystatus_vm_pressure_level"] = "4";
  expect(readLocalManagedCapacity(deps).pressure).toBe("critical");
  outputs["vm.swapusage"] = "not supported";
  expect(readLocalManagedCapacity(deps).swapUsedBytes).toBeNull();
  outputs["vm_stat"] = "Pages free: 1048576.\n";
  expect(readLocalManagedCapacity(deps).availableBytes).toBeNull();
});

test("a moving cgroup or missing finite usage cannot be used as launch headroom", () => {
  const leaf = `${CGROUP}/workload`;
  const fixture = linuxFixture({
    "/proc/self/cgroup": "0::/workload\n",
    [`${leaf}/memory.max`]: String(8 * GiB),
    [`${leaf}/memory.pressure`]: PSI,
  });
  expect(projectManagedCapacity(readLocalManagedCapacity(fixture), { nowMs: NOW })).toEqual({
    ok: false,
    reason: "CapacityScopeUnknown",
  });
  const complete = linuxFixture({
    "/proc/self/cgroup": "0::/workload\n",
    [`${leaf}/memory.max`]: String(8 * GiB),
    [`${leaf}/memory.current`]: String(2 * GiB),
    [`${leaf}/memory.pressure`]: PSI,
  });
  const read = complete.readFile;
  if (read === undefined) throw new Error("missing test reader");
  let memberships = 0;
  complete.readFile = (path): string => {
    if (path === "/proc/self/cgroup" && memberships++ > 0) return "0::/moved\n";
    return read(path);
  };
  expect(projectManagedCapacity(readLocalManagedCapacity(complete), { nowMs: NOW })).toEqual({
    ok: false,
    reason: "CapacityScopeUnknown",
  });
});
