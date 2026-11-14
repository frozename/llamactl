import { describe, expect, test } from "bun:test";

import * as profileMod from "../src/profile.js";
import {
  defaultOmlxMemoryGiBForProfile,
  normalizeProfile,
  profileFromMemory,
  resolveProfile,
} from "../src/profile.js";
import { resolveTarget } from "../src/target.js";

describe("profile.normalizeProfile", () => {
  test("canonicalises the three primary names", () => {
    expect(normalizeProfile("mac-mini-16g")).toBe("mac-mini-16g");
    expect(normalizeProfile("balanced")).toBe("balanced");
    expect(normalizeProfile("macbook-pro-48g")).toBe("macbook-pro-48g");
  });

  test("accepts friendly aliases", () => {
    expect(normalizeProfile("mini")).toBe("mac-mini-16g");
    expect(normalizeProfile("16g")).toBe("mac-mini-16g");
    expect(normalizeProfile("mbp")).toBe("macbook-pro-48g");
    expect(normalizeProfile("48g")).toBe("macbook-pro-48g");
    expect(normalizeProfile("best")).toBe("macbook-pro-48g");
    expect(normalizeProfile("large")).toBe("large-128g");
    expect(normalizeProfile("128g")).toBe("large-128g");
    expect(normalizeProfile("large-128g")).toBe("large-128g");
  });

  test("returns null on empty and unknown", () => {
    expect(normalizeProfile(undefined)).toBeNull();
    expect(normalizeProfile("")).toBeNull();
    expect(normalizeProfile("m3-ultra-500g")).toBeNull();
  });
});

describe("profile.profileFromMemory", () => {
  test("<= 16 GiB -> mac-mini-16g", () => {
    expect(profileFromMemory(8 * 1024 ** 3)).toBe("mac-mini-16g");
    expect(profileFromMemory(16 * 1024 ** 3)).toBe("mac-mini-16g");
  });
  test("<= 32 GiB -> balanced", () => {
    expect(profileFromMemory(24 * 1024 ** 3)).toBe("balanced");
    expect(profileFromMemory(32 * 1024 ** 3)).toBe("balanced");
  });
  test("> 32 GiB up to 64 GiB -> macbook-pro-48g", () => {
    expect(profileFromMemory(48 * 1024 ** 3)).toBe("macbook-pro-48g");
    expect(profileFromMemory(64 * 1024 ** 3)).toBe("macbook-pro-48g");
  });
  test("> 64 GiB -> large-128g", () => {
    expect(profileFromMemory(64 * 1024 ** 3 + 1)).toBe("large-128g");
    expect(profileFromMemory(96 * 1024 ** 3)).toBe("large-128g");
    expect(profileFromMemory(124 * 1024 ** 3)).toBe("large-128g");
    expect(profileFromMemory(128 * 1024 ** 3)).toBe("large-128g");
  });
  test("null memory keeps macbook-pro-48g", () => {
    expect(profileFromMemory(null)).toBe("macbook-pro-48g");
  });
});

describe("profile.resolveProfile", () => {
  test("explicit override wins over detection", () => {
    expect(resolveProfile({ LLAMA_CPP_MACHINE_PROFILE: "mac-mini-16g" })).toBe("mac-mini-16g");
  });
  test("alias in env is normalised", () => {
    expect(resolveProfile({ LLAMA_CPP_MACHINE_PROFILE: "mini" })).toBe("mac-mini-16g");
  });
  test("large-128g override resolves", () => {
    expect(resolveProfile({ LLAMA_CPP_MACHINE_PROFILE: "large-128g" })).toBe("large-128g");
  });
});

describe("profile.resolveTarget", () => {
  test("qwen on large-128g resolves the UD-Q4_K_XL rel", () => {
    expect(resolveTarget("qwen", { LLAMA_CPP_MACHINE_PROFILE: "large-128g" })).toBe(
      "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf",
    );
  });
});

describe("profile.defaultOmlxMemoryGiBForProfile", () => {
  test("maps the four primary profiles to explicit oMLX caps", () => {
    expect(defaultOmlxMemoryGiBForProfile("mac-mini-16g")).toBe(12);
    expect(defaultOmlxMemoryGiBForProfile("balanced")).toBe(24);
    expect(defaultOmlxMemoryGiBForProfile("macbook-pro-48g")).toBe(32);
    expect(defaultOmlxMemoryGiBForProfile("large-128g")).toBe(96);
  });
});

type Desc = {
  platform: string;
  memoryBytes: number | null;
  memoryTier: string;
  profile: string;
  profileSource: "env" | "detected";
};

type DescribeFn = (
  env: NodeJS.ProcessEnv,
  probe?: { platform?: NodeJS.Platform; memoryBytes?: number | null },
) => Desc;

type DetectMemoryDeps = {
  platform?: NodeJS.Platform;
  darwin?: () => number | null;
  linux?: () => number | null;
  totalmem?: () => number;
};

type DetectMemoryFn = (deps?: DetectMemoryDeps) => number | null;

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Callers pick the expected export type; the runtime check only proves it is a function.
function exported<T>(name: string): T {
  const v = (profileMod as unknown as Record<string, unknown>)[name];
  expect(typeof v).toBe("function");
  return v as T;
}

describe("profile.describeMachine (#213)", () => {
  const G = 1024 ** 3;
  test("128 GiB linux -> platform linux, tier 128g+, profile large-128g", () => {
    const describeMachine = exported<DescribeFn>("describeMachine");
    expect(describeMachine({}, { platform: "linux", memoryBytes: 128 * G })).toEqual({
      platform: "linux",
      memoryBytes: 128 * G,
      memoryTier: "128g+",
      profile: "large-128g",
      profileSource: "detected",
    });
  });
  test("64 GiB mac -> tier 64g, profile stays macbook-pro-48g", () => {
    const describeMachine = exported<DescribeFn>("describeMachine");
    expect(describeMachine({}, { platform: "darwin", memoryBytes: 64 * G })).toEqual({
      platform: "darwin",
      memoryBytes: 64 * G,
      memoryTier: "64g",
      profile: "macbook-pro-48g",
      profileSource: "detected",
    });
  });
  test("48 GiB linux keeps profile macbook-pro-48g but reports platform linux and tier 48g", () => {
    const describeMachine = exported<DescribeFn>("describeMachine");
    expect(describeMachine({}, { platform: "linux", memoryBytes: 48 * G })).toEqual({
      platform: "linux",
      memoryBytes: 48 * G,
      memoryTier: "48g",
      profile: "macbook-pro-48g",
      profileSource: "detected",
    });
  });
  test("96 GiB boundary", () => {
    const describeMachine = exported<DescribeFn>("describeMachine");
    const at = describeMachine({}, { platform: "linux", memoryBytes: 96 * G });
    expect(at.memoryTier).toBe("96g");
    expect(at.profile).toBe("large-128g");
    const above = describeMachine({}, { platform: "linux", memoryBytes: 96 * G + 1 });
    expect(above.memoryTier).toBe("128g+");
    expect(above.profile).toBe("large-128g");
  });
  test("unchanged existing tiers", () => {
    const describeMachine = exported<DescribeFn>("describeMachine");
    const mini = describeMachine({}, { platform: "darwin", memoryBytes: 16 * G });
    expect(mini.memoryTier).toBe("16g");
    expect(mini.profile).toBe("mac-mini-16g");
    const balanced = describeMachine({}, { platform: "darwin", memoryBytes: 32 * G });
    expect(balanced.memoryTier).toBe("32g");
    expect(balanced.profile).toBe("balanced");
    const mbp = describeMachine({}, { platform: "darwin", memoryBytes: 32 * G + 1 });
    expect(mbp.memoryTier).toBe("48g");
    expect(mbp.profile).toBe("macbook-pro-48g");
  });
  test("unknown memory", () => {
    const describeMachine = exported<DescribeFn>("describeMachine");
    expect(describeMachine({}, { platform: "linux", memoryBytes: null })).toEqual({
      platform: "linux",
      memoryBytes: null,
      memoryTier: "unknown",
      profile: "macbook-pro-48g",
      profileSource: "detected",
    });
  });
  test("win32 -> windows, other platforms -> other", () => {
    const describeMachine = exported<DescribeFn>("describeMachine");
    expect(describeMachine({}, { platform: "win32", memoryBytes: 64 * G }).platform).toBe(
      "windows",
    );
    expect(describeMachine({}, { platform: "freebsd", memoryBytes: 64 * G }).platform).toBe(
      "other",
    );
  });
  test("env override is reported as source env", () => {
    const describeMachine = exported<DescribeFn>("describeMachine");
    expect(
      describeMachine(
        { LLAMA_CPP_MACHINE_PROFILE: "mini" },
        { platform: "linux", memoryBytes: 128 * G },
      ),
    ).toEqual({
      platform: "linux",
      memoryBytes: 128 * G,
      memoryTier: "128g+",
      profile: "mac-mini-16g",
      profileSource: "env",
    });
  });
  test("formatMachineSummary", () => {
    const describeMachine = exported<DescribeFn>("describeMachine");
    const formatMachineSummary = exported<(d: Desc) => string>("formatMachineSummary");
    expect(
      formatMachineSummary(describeMachine({}, { platform: "linux", memoryBytes: 128 * G })),
    ).toBe("platform=linux memory=128.0GiB tier=128g+ profile=large-128g source=detected");
    expect(
      formatMachineSummary(describeMachine({}, { platform: "linux", memoryBytes: null })),
    ).toBe("platform=linux memory=unknown tier=unknown profile=macbook-pro-48g source=detected");
  });
});

describe("profile.detectMemoryBytes fallback (#213)", () => {
  const G = 1024 ** 3;
  const detectMemoryBytes = exported<DetectMemoryFn>("detectMemoryBytes");

  test("win32 falls back to totalmem", () => {
    expect(detectMemoryBytes({ platform: "win32", totalmem: () => 100 * G + 4096 })).toBe(
      100 * G + 4096,
    );
  });

  test("freebsd falls back to totalmem", () => {
    expect(detectMemoryBytes({ platform: "freebsd", totalmem: () => 7 * G + 8192 })).toBe(
      7 * G + 8192,
    );
  });

  test("darwin probe failure falls back to totalmem", () => {
    expect(
      detectMemoryBytes({
        platform: "darwin",
        darwin: () => null,
        totalmem: () => 100 * G + 4096,
      }),
    ).toBe(100 * G + 4096);
  });

  test("linux probe failure falls back to totalmem", () => {
    expect(
      detectMemoryBytes({
        platform: "linux",
        linux: () => null,
        totalmem: () => 100 * G + 4096,
      }),
    ).toBe(100 * G + 4096);
  });

  test("platform probe wins over totalmem", () => {
    expect(
      detectMemoryBytes({
        platform: "darwin",
        darwin: () => 48 * G + 12345,
        totalmem: () => 100 * G + 4096,
      }),
    ).toBe(48 * G + 12345);
    expect(
      detectMemoryBytes({
        platform: "linux",
        linux: () => 48 * G + 12345,
        totalmem: () => 100 * G + 4096,
      }),
    ).toBe(48 * G + 12345);
  });

  test("non-positive or throwing totalmem yields null", () => {
    expect(detectMemoryBytes({ platform: "freebsd", totalmem: () => 13 * G + 555 })).toBe(
      13 * G + 555,
    );
    expect(detectMemoryBytes({ platform: "freebsd", totalmem: () => 0 })).toBeNull();
    expect(detectMemoryBytes({ platform: "freebsd", totalmem: () => Number.NaN })).toBeNull();
    expect(
      detectMemoryBytes({
        platform: "freebsd",
        totalmem: () => {
          throw new Error("totalmem unavailable");
        },
      }),
    ).toBeNull();
  });

  test("non-finite totalmem yields null", () => {
    expect(
      detectMemoryBytes({ platform: "freebsd", totalmem: () => Number.POSITIVE_INFINITY }),
    ).toBeNull();
  });

  test("fractional totalmem is truncated to whole bytes", () => {
    expect(detectMemoryBytes({ platform: "freebsd", totalmem: () => 8 * G + 0.5 })).toBe(8 * G);
  });
});

describe("profile tier-name aliases (#213)", () => {
  const G = 1024 ** 3;

  test("tier names normalise to profiles", () => {
    expect(normalizeProfile("32g")).toBe("balanced");
    expect(normalizeProfile("64g")).toBe("macbook-pro-48g");
    expect(normalizeProfile("96g")).toBe("large-128g");
    expect(normalizeProfile("128g+")).toBe("large-128g");
  });

  test("tier names round-trip through detection buckets", () => {
    const memoryTierFromBytes = exported<(b: number | null) => string>("memoryTierFromBytes");
    for (const b of [16 * G, 32 * G, 32 * G + 1, 48 * G, 64 * G, 64 * G + 1, 96 * G, 128 * G]) {
      expect(normalizeProfile(memoryTierFromBytes(b))).toBe(profileFromMemory(b));
    }
  });

  test("env override accepts tier names", () => {
    const describeMachine = exported<DescribeFn>("describeMachine");
    expect(
      describeMachine(
        { LLAMA_CPP_MACHINE_PROFILE: "96g" },
        { platform: "linux", memoryBytes: 16 * G },
      ),
    ).toEqual({
      platform: "linux",
      memoryBytes: 16 * G,
      memoryTier: "16g",
      profile: "large-128g",
      profileSource: "env",
    });
    expect(resolveProfile({ LLAMA_CPP_MACHINE_PROFILE: "64g" })).toBe("macbook-pro-48g");
  });
});
