import { type CliBinding, CliBindingSchema } from "@llamactl/core/config/schema";
import { describe, expect, test } from "bun:test";

import { CLI_PRESETS, expandArgs, resolvePreset } from "../src/cli/presets.js";

// Build every CliBinding through the schema so required keys (timeoutMs,
// advertisedModels, capabilities) are always present.
const bind = (o: Record<string, unknown>): CliBinding =>
  CliBindingSchema.parse({ name: "test-cli", ...o });

describe("resolvePreset — claude preset", () => {
  test("returns command, args, stream, versionProbe and format", () => {
    const result = resolvePreset(bind({ preset: "claude" }));
    expect(result.command).toBe("claude");
    expect(result.args).toEqual(["-p", "{{prompt}}", "--output-format", "text"]);
    expect(result.stream).toBe(true);
    expect(result.versionProbe).toEqual(["--version"]);
    expect(result.format).toBe("text");
  });

  test("binding.format overrides preset format", () => {
    const result = resolvePreset(bind({ preset: "claude", format: "json" }));
    expect(result.format).toBe("json");
  });
});

describe("resolvePreset — codex + gemini presets", () => {
  test("codex returns command, args and stream false", () => {
    const result = resolvePreset(bind({ preset: "codex" }));
    expect(result.command).toBe("codex");
    expect(result.args).toEqual(["exec", "{{prompt}}"]);
    expect(result.stream).toBe(false);
  });

  test("gemini returns command, args and stream false", () => {
    const result = resolvePreset(bind({ preset: "gemini" }));
    expect(result.command).toBe("gemini");
    expect(result.args).toEqual(["-p", "{{prompt}}"]);
    expect(result.stream).toBe(false);
  });
});

describe("resolvePreset — command/args overrides on known preset", () => {
  test("override command + args but stream still comes from preset", () => {
    const result = resolvePreset(
      bind({
        preset: "claude",
        command: "/custom/claude",
        args: ["-m", "sonnet", "-p", "{{prompt}}"],
      }),
    );
    expect(result.command).toBe("/custom/claude");
    expect(result.args).toEqual(["-m", "sonnet", "-p", "{{prompt}}"]);
    expect(result.stream).toBe(true);
  });
});

describe("resolvePreset — copy semantics", () => {
  test("pushing onto returned args does not mutate CLI_PRESETS", () => {
    const result = resolvePreset(bind({ preset: "claude" }));
    const before = [...CLI_PRESETS.claude.args];
    result.args.push("extra");
    expect(CLI_PRESETS.claude.args).toEqual(before);
  });

  test("when binding.args is supplied, returned args toEqual(binding.args) but not toBe", () => {
    const binding = bind({ preset: "claude", args: ["-m", "sonnet", "-p", "{{prompt}}"] });
    const result = resolvePreset(binding);
    expect(result.args).toEqual(binding.args!);
    expect(result.args).not.toBe(binding.args);
    // Mutate the returned array — binding.args must be unchanged.
    result.args.push("extra");
    expect(binding.args).toEqual(["-m", "sonnet", "-p", "{{prompt}}"]);
  });
});

describe("resolvePreset — preset 'custom' refusals", () => {
  test("neither command nor args throws with message", () => {
    const b = bind({ preset: "custom" });
    expect(() => resolvePreset(b)).toThrow("preset='custom' requires command and args");
  });

  test("only command (no args) throws with message", () => {
    const b = bind({ preset: "custom", command: "mycli" });
    expect(() => resolvePreset(b)).toThrow("preset='custom' requires command and args");
  });

  test("only args (no command) throws with message", () => {
    const b = bind({ preset: "custom", args: ["arg1"] });
    expect(() => resolvePreset(b)).toThrow("preset='custom' requires command and args");
  });

  test("error message contains the binding name", () => {
    const b = bind({ preset: "custom" });
    expect(() => resolvePreset(b)).toThrow(/cli binding 'test-cli'/);
  });
});

describe("resolvePreset — custom with both command and args", () => {
  test("returns binding values with args as a copy", () => {
    const customArgs = ["arg1", "arg2"];
    const result = resolvePreset(
      bind({ preset: "custom", command: "mycli", args: customArgs, format: "json" }),
    );
    expect(result.command).toBe("mycli");
    expect(result.args).toEqual(customArgs);
    expect(result.args).not.toBe(customArgs);
    expect(result.stream).toBe(false);
    expect(result.versionProbe).toEqual(["--version"]);
    expect(result.format).toBe("json");
  });
});

describe("expandArgs", () => {
  test("replaces {{prompt}} placeholder", () => {
    const result = expandArgs(["-p", "{{prompt}}"], "hi");
    expect(result.args).toEqual(["-p", "hi"]);
    expect(result.promptOnStdin).toBe(false);
  });

  test("args with no placeholder return input with promptOnStdin true", () => {
    const input = ["arg1", "arg2"];
    const result = expandArgs(input, "ignored");
    expect(result.args).toEqual(input);
    expect(result.promptOnStdin).toBe(true);
  });

  test("empty args array returns empty with promptOnStdin true", () => {
    const result = expandArgs([], "any");
    expect(result.args).toEqual([]);
    expect(result.promptOnStdin).toBe(true);
  });

  test("embedded placeholder '--prompt={{prompt}}' is replaced inline", () => {
    const result = expandArgs(["--prompt={{prompt}}"], "hi");
    expect(result.args).toEqual(["--prompt=hi"]);
    expect(result.promptOnStdin).toBe(false);
  });

  test("double placeholder '{{prompt}}{{prompt}}' — only first replaced", () => {
    const result = expandArgs(["{{prompt}}{{prompt}}"], "hi");
    expect(result.args).toEqual(["hi{{prompt}}"]);
    expect(result.promptOnStdin).toBe(false);
  });

  test("two separate elements each holding '{{prompt}}' — both substituted", () => {
    const result = expandArgs(["{{prompt}}", "{{prompt}}"], "hi");
    expect(result.args).toEqual(["hi", "hi"]);
    expect(result.promptOnStdin).toBe(false);
  });

  test("input array is not mutated", () => {
    const input = ["-p", "{{prompt}}"];
    const before = [...input];
    expandArgs(input, "hi");
    expect(input).toEqual(before);
  });

  test("result is a new array reference", () => {
    const input = ["-p", "{{prompt}}"];
    const result = expandArgs(input, "hi");
    expect(result.args).not.toBe(input);
  });
});
