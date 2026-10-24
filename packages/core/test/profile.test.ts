import { describe, expect, test } from "bun:test";

import {
  defaultOmlxMemoryGiBForProfile,
  normalizeProfile,
  profileFromMemory,
  resolveProfile,
} from "../src/profile.js";

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

describe("profile.defaultOmlxMemoryGiBForProfile", () => {
  test("maps the four primary profiles to explicit oMLX caps", () => {
    expect(defaultOmlxMemoryGiBForProfile("mac-mini-16g")).toBe(12);
    expect(defaultOmlxMemoryGiBForProfile("balanced")).toBe(24);
    expect(defaultOmlxMemoryGiBForProfile("macbook-pro-48g")).toBe(32);
    expect(defaultOmlxMemoryGiBForProfile("large-128g")).toBe(96);
  });
});
