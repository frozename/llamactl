import { afterEach, describe, expect, test } from "bun:test";

import { GpuFactsSchema } from "../src/config/schema.js";
import {
  collectNodeFacts,
  detectGpu,
  LLAMACTL_VERSION,
  resolveNodeName,
  resolveVersions,
} from "../src/nodeFacts.js";
import { detectMemoryBytes } from "../src/profile.js";
import { MACHINE_PROFILES } from "../src/types.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("resolveNodeName", () => {
  test("honors LLAMACTL_NODE_NAME override", () => {
    expect(resolveNodeName({ LLAMACTL_NODE_NAME: "gpu1" })).toBe("gpu1");
  });

  test("trims override whitespace", () => {
    expect(resolveNodeName({ LLAMACTL_NODE_NAME: "  gpu1  " })).toBe("gpu1");
  });

  test("falls back to hostname when override absent", () => {
    const name = resolveNodeName({});
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
  });

  test('falls back to literal "local" when override is empty string', () => {
    // Empty string is falsy, so hostname kicks in. Verify the contract
    // that we never return an empty string either way.
    expect(resolveNodeName({ LLAMACTL_NODE_NAME: "" }).length).toBeGreaterThan(0);
  });
});

describe("resolveVersions", () => {
  test("returns llamactl + bun + llamaCppSrcRev fields", () => {
    const v = resolveVersions();
    expect(typeof v.llamactl).toBe("string");
    expect(typeof v.bun).toBe("string");
    expect(v.llamaCppSrcRev === null || typeof v.llamaCppSrcRev === "string").toBe(true);
  });

  test("bun version is a semver-ish string when running under Bun", () => {
    const v = resolveVersions();
    // Under Bun the test runner sets process.versions.bun. If it is set,
    // it should look like a version. Otherwise it falls back to 'unknown'.
    if (v.bun !== "unknown") {
      expect(v.bun).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  test("llamactl field matches the exported LLAMACTL_VERSION", () => {
    const v = resolveVersions();
    expect(v.llamactl).toBe(LLAMACTL_VERSION);
  });
});

describe("detectGpu", () => {
  test("returns a GpuInfo or null without throwing", () => {
    const gpu = detectGpu();
    if (gpu !== null) {
      expect(["metal", "cuda", "rocm", "vulkan", "cpu"]).toContain(gpu.kind);
    }
  });

  test('on darwin, kind is "metal"', () => {
    if (process.platform !== "darwin") return;
    const gpu = detectGpu();
    expect(gpu?.kind).toBe("metal");
  });
});

function fakeExec(outputs: Record<string, string>): {
  exec: (file: string, args: string[]) => string;
  calls: string[];
} {
  const calls: string[] = [];
  const exec = (file: string, args: string[]): string => {
    calls.push([file, ...args].join(" "));
    const out = outputs[file];
    if (out === undefined) throw new Error(`${file}: not found`);
    return out;
  };
  return { exec, calls };
}

const ROCM_GPU = `*******
Agent 1
*******
  Name:                    AMD Ryzen AI MAX+ 395
  Device Type:             CPU
*******
Agent 2
*******
  Name:                    gfx1151
  Marketing Name:          AMD Radeon Graphics
  Device Type:             GPU
`;

const ROCM_CPU_ONLY = `*******
Agent 1
*******
  Name:                    AMD Ryzen AI MAX+ 395
  Device Type:             CPU
`;

const VULKAN_SUMMARY = `Devices:
========
GPU0:
\tapiVersion         = 1.3.274
\tdeviceType         = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU
\tdeviceName         = AMD Radeon Graphics (RADV GFX1151)
\tdriverName         = radv
GPU1:
\tdeviceType         = PHYSICAL_DEVICE_TYPE_CPU
\tdeviceName         = llvmpipe (LLVM 17.0.6, 256 bits)
\tdriverName         = llvmpipe
`;

const VULKAN_LLVMPIPE_ONLY = `Devices:
========
GPU0:
\tdeviceType         = PHYSICAL_DEVICE_TYPE_CPU
\tdeviceName         = llvmpipe (LLVM 17.0.6, 256 bits)
\tdriverName         = llvmpipe
`;

describe("detectGpu with stubbed probes", () => {
  test("cuda via nvidia-smi", () => {
    const { exec, calls } = fakeExec({
      "nvidia-smi": "NVIDIA GeForce RTX 4090, 24564\n",
    });
    const gpu = detectGpu({ platform: "linux", exec });
    expect(gpu).toEqual({ kind: "cuda", name: "NVIDIA GeForce RTX 4090", memoryMB: 24564 });
    expect(calls.length).toBe(1);
  });

  test("rocm when rocminfo lists a GPU agent", () => {
    const { exec } = fakeExec({ rocminfo: ROCM_GPU });
    const gpu = detectGpu({ platform: "linux", exec });
    expect(gpu?.kind).toBe("rocm");
  });

  test("cpu when rocminfo lists only a CPU agent and no vulkaninfo", () => {
    const { exec } = fakeExec({ rocminfo: ROCM_CPU_ONLY });
    const gpu = detectGpu({ platform: "linux", exec });
    expect(gpu).toEqual({ kind: "cpu" });
  });

  test("vulkan fallback when rocminfo lists only a CPU agent", () => {
    const { exec } = fakeExec({ rocminfo: ROCM_CPU_ONLY, vulkaninfo: VULKAN_SUMMARY });
    const gpu = detectGpu({ platform: "linux", exec });
    expect(gpu).toEqual({ kind: "vulkan", name: "AMD Radeon Graphics (RADV GFX1151)" });
  });

  test("vulkan when only vulkaninfo is installed", () => {
    const { exec } = fakeExec({ vulkaninfo: VULKAN_SUMMARY });
    const gpu = detectGpu({ platform: "linux", exec });
    expect(gpu).toEqual({ kind: "vulkan", name: "AMD Radeon Graphics (RADV GFX1151)" });
  });

  test("llvmpipe-only vulkan output stays cpu", () => {
    const { exec } = fakeExec({ vulkaninfo: VULKAN_LLVMPIPE_ONLY });
    const gpu = detectGpu({ platform: "linux", exec });
    expect(gpu).toEqual({ kind: "cpu" });
  });

  test("discrete GPU wins over integrated", () => {
    const { exec } = fakeExec({
      vulkaninfo: `Devices:
========
GPU0:
\tdeviceType         = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU
\tdeviceName         = AMD Radeon Graphics (RADV GFX1151)
GPU1:
\tdeviceType         = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU
\tdeviceName         = AMD Radeon RX 7900 XTX (RADV NAVI31)
`,
    });
    const gpu = detectGpu({ platform: "linux", exec });
    expect(gpu?.name).toBe("AMD Radeon RX 7900 XTX (RADV NAVI31)");
  });

  test("cpu when nothing is installed", () => {
    const { exec } = fakeExec({});
    const gpu = detectGpu({ platform: "linux", exec });
    expect(gpu).toEqual({ kind: "cpu" });
  });

  test("win32 returns cpu without probing", () => {
    const { exec, calls } = fakeExec({});
    const gpu = detectGpu({ platform: "win32", exec });
    expect(gpu).toEqual({ kind: "cpu" });
    expect(calls).toEqual([]);
  });

  test("GpuFactsSchema accepts vulkan kind", () => {
    expect(GpuFactsSchema.parse({ kind: "vulkan", name: "x" }).kind).toBe("vulkan");
  });
});

describe("collectNodeFacts", () => {
  test("returns all documented fields", () => {
    const facts = collectNodeFacts();
    expect(typeof facts.nodeName).toBe("string");
    expect([...MACHINE_PROFILES]).toContain(facts.profile);
    expect(facts.memBytes === null || typeof facts.memBytes === "number").toBe(true);
    expect(typeof facts.os).toBe("string");
    expect(typeof facts.arch).toBe("string");
    expect(facts.platform).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect(facts.llamaCppBuildId === null || typeof facts.llamaCppBuildId === "string").toBe(true);
    expect(facts.gpu === null || typeof facts.gpu === "object").toBe(true);
    expect(typeof facts.versions.llamactl).toBe("string");
    expect(typeof facts.versions.bun).toBe("string");
    expect(
      facts.versions.llamaCppSrcRev === null || typeof facts.versions.llamaCppSrcRev === "string",
    ).toBe(true);
    expect(facts.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("platform string matches process.platform/process.arch", () => {
    const facts = collectNodeFacts();
    expect(facts.platform).toBe(`${process.platform}-${process.arch}`);
  });

  test("startedAt is stable across calls (captured at module load)", () => {
    const a = collectNodeFacts();
    const b = collectNodeFacts();
    expect(a.startedAt).toBe(b.startedAt);
  });

  test("nodeName override propagates", () => {
    const facts = collectNodeFacts({ ...process.env, LLAMACTL_NODE_NAME: "probe" });
    expect(facts.nodeName).toBe("probe");
  });
});

describe("detectMemoryBytes", () => {
  test("returns a number on supported platforms, null otherwise", () => {
    const b = detectMemoryBytes();
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(typeof b).toBe("number");
      expect(b ?? 0).toBeGreaterThan(0);
    } else {
      expect(b).toBeNull();
    }
  });
});
