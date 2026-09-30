import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { runProcess } from "@novaproto/exec-primitives";

const CONSUMER_DIR = new URL("..", import.meta.url);
const PKG = "@novaproto/exec-primitives";
const VER = "0.1.0";

describe("@novaproto/exec-primitives registry pin", () => {
  test("manifest pins the exact published version in devDependencies", () => {
    const manifest = JSON.parse(
      readFileSync(join(new URL("src", CONSUMER_DIR).pathname, "..", "package.json"), "utf8"),
    ) as { devDependencies: Record<string, string> };
    expect(manifest.devDependencies[PKG]).toBe(VER);
  });

  test("bun.lock records the registry resolution and published integrity", () => {
    const lock = readFileSync(
      join(new URL("src", CONSUMER_DIR).pathname, "..", "bun.lock"),
      "utf8",
    );
    const expected = `"${PKG}": ["${PKG}@${VER}", "", {}, "sha512-vhE+TfXrPQZOlsB8/PoF9vYuAZgF4GwXzFK3yvA5sfx0kLDX5ANvh1To00T9NjC4yTKeSPwJYGEaZtOncUE0Ew=="]`;
    expect(lock).toContain(expected);
  });

  test("resolves to the installed registry copy inside this consumer", () => {
    const resolved = import.meta.resolve(PKG);
    const real = realpathSync(new URL(resolved));
    const consumerReal = realpathSync(CONSUMER_DIR);
    expect(real.startsWith(consumerReal)).toBe(true);
    expect(real.includes("node_modules")).toBe(true);
  });

  test("runs a real process through the published supervisor", async () => {
    const result = await runProcess({
      command: "/bin/sh",
      args: ["-c", "printf parity-ok"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      signal: new AbortController().signal,
      cancelGraceMs: 250,
      watchdogMs: 120_000,
      stdin: "ignore",
    });
    expect(result.stdout).toBe("parity-ok");
    expect(result.exit.outcome).toBe("exited");
    expect(result.exit.code).toBe(0);
  });
});
