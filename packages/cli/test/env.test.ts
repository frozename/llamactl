import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { makeTempRuntime, parseJsonRecord, runCli } from "./helpers.js";

describe("llamactl env", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  beforeEach(() => {
    temp = makeTempRuntime();
  });
  afterEach(() => {
    temp.cleanup();
  });

  test("env --eval emits export lines for every expected var", () => {
    const r = runCli(["env", "--eval"], temp.env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("export LLAMA_CPP_MACHINE_PROFILE=macbook-pro-48g");
    expect(r.stdout).toContain("export LOCAL_AI_PROVIDER=llama.cpp");
    expect(r.stdout).toContain("export OPENAI_BASE_URL=");
    expect(r.stdout).toContain("mkdir -p");
  });

  test("env --json is valid JSON", () => {
    const r = runCli(["env", "--json"], temp.env);
    expect(r.code).toBe(0);
    const parsed = parseJsonRecord(r.stdout);
    expect(parsed["LLAMA_CPP_MACHINE_PROFILE"]).toBe("macbook-pro-48g");
    expect(parsed["LOCAL_AI_RUNTIME_DIR"]).toBe(temp.runtimeDir);
  });

  test("env default (no flag) behaves as --eval", () => {
    const r = runCli(["env"], temp.env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("export ");
  });

  test("unknown env flag exits non-zero", () => {
    const r = runCli(["env", "--bogus"], temp.env);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Unknown flag");
  });

  test("unknown top-level command prints USAGE to stderr", () => {
    const r = runCli(["not-a-command"], temp.env);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Unknown command");
    expect(r.stderr).toContain("Usage:");
  });

  test("env --eval leads with a machine summary comment (#213)", () => {
    const r = runCli(["env", "--eval"], temp.env);
    expect(r.code).toBe(0);
    const firstLine = r.stdout.split("\n")[0] ?? "";
    expect(firstLine).toMatch(
      /^# machine: platform=(?:darwin|linux|windows|other) memory=(?:\d+\.\dGiB|unknown) tier=(?:16g|32g|48g|64g|96g|128g\+|unknown) profile=macbook-pro-48g source=env$/,
    );
    expect(r.stdout).toContain("export LLAMA_CPP_MACHINE_PROFILE=macbook-pro-48g");
  });

  test("env --json keeps stdout pure JSON and reports the machine on stderr (#213)", () => {
    const r = runCli(["env", "--json"], temp.env);
    expect(r.code).toBe(0);
    const parsed = parseJsonRecord(r.stdout);
    expect("machine" in parsed).toBe(false);
    expect(r.stderr).toMatch(
      /^machine: platform=\S+ memory=\S+ tier=\S+ profile=macbook-pro-48g source=env$/m,
    );
  });
});
