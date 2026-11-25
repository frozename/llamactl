// #806 phase 3: CommandExpectation.alternatives lets a systemd-run wrapper
// record be recognised either by the wrapper path or by the engine binary the
// wrapper exec'd, while an unrelated process stays unverifiable.

import { describe, expect, test } from "bun:test";

import type { CommandExpectation } from "../src/pidIdentity.js";

import { scopeWrapperExpectation } from "../src/engines/scope.js";
import { verifyRecordedPid } from "../src/pidIdentity.js";

const RECORD_MS = 1_000_000;

function verdict(cmdline: string, expect: CommandExpectation): string {
  return verifyRecordedPid(4242, RECORD_MS, {
    probe: () => undefined,
    processStartMs: () => RECORD_MS,
    processCommand: () => cmdline,
    expectCommand: expect,
  });
}

const EXPECT: CommandExpectation = {
  path: "/usr/bin/systemd-run",
  args: ["--scope"],
  alternatives: [{ binary: "llama-server", args: ["-m"] }],
};

describe("CommandExpectation.alternatives", () => {
  test("the primary expectation still matches", () => {
    expect(verdict("/usr/bin/systemd-run --scope --unit=llamactl-engine-x llamactl", EXPECT)).toBe(
      "alive",
    );
  });

  test("an alternative matches when the wrapper has exec'd the engine", () => {
    expect(verdict("/opt/llama-server -m /models/a.gguf", EXPECT)).toBe("alive");
  });

  test("a process matching neither the primary nor any alternative is unknown", () => {
    expect(verdict("/usr/bin/python3 worker.py", EXPECT)).toBe("unknown");
  });

  test("an alternative is not matched against the primary's args", () => {
    // The engine cmdline lacks `--scope`; only the alternative can accept it.
    const strict: CommandExpectation = {
      path: "/usr/bin/systemd-run",
      args: ["--scope"],
    };
    expect(verdict("/opt/llama-server -m /models/a.gguf", strict)).toBe("unknown");
  });
});

describe("scopeWrapperExpectation", () => {
  const UNIT = "llamactl-engine-a-0123456789ab.scope";
  const WRAPPER =
    "systemd-run --user --scope --unit=llamactl-engine-a-0123456789ab -- /opt/llama-server -m m.gguf";
  const ENGINE = "/opt/llama-server -m m.gguf";
  const scoped: CommandExpectation = {
    binaries: ["llama-server"],
    alternatives: [scopeWrapperExpectation(UNIT)],
  };

  test("the pre-exec wrapper argv verifies through the alternative", () => {
    expect(verdict(WRAPPER, scoped)).toBe("alive");
  });

  test("the exec'd engine argv verifies through the primary", () => {
    expect(verdict(ENGINE, scoped)).toBe("alive");
    expect(verdict(ENGINE, { binaries: ["llama-server"] })).toBe("alive");
  });

  test("a wrapper naming a different unit is unknown", () => {
    expect(
      verdict(WRAPPER, {
        binaries: ["llama-server"],
        alternatives: [scopeWrapperExpectation("llamactl-engine-a-ffffffffffff.scope")],
      }),
    ).toBe("unknown");
  });

  test("the wrapper is unknown without alternatives", () => {
    expect(verdict(WRAPPER, { binaries: ["llama-server"] })).toBe("unknown");
  });

  test("a nested alternative is ignored", () => {
    const nested: CommandExpectation = {
      binaries: ["llama-server"],
      alternatives: [
        {
          ...scopeWrapperExpectation(UNIT),
          alternatives: [{ binary: "python3" }],
        },
      ],
    };
    expect(verdict("python3 worker.py", nested)).toBe("unknown");
  });
});
