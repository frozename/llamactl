import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveVersionInfo, runVersion } from "../src/commands/version.js";
import { captureProcessStreams, makeTempRuntime, runCli } from "./helpers.js";

const FAKE_MODULE_DIR = "/fake/repo/packages/cli/src/commands";
const FAKE_EXISTS_FN = (p: string): boolean => p === "/fake/repo/.git";

interface ExecCall {
  file: string;
  args: string[];
}

function stubExec(behavior: "ok" | "throws" | "empty"): {
  calls: ExecCall[];
  exec: (file: string, args: string[]) => string;
} {
  const calls: ExecCall[] = [];
  const exec = (file: string, args: string[]): string => {
    calls.push({ file, args });
    if (behavior === "throws") throw new Error("git not found");
    if (behavior === "empty") return "";
    return "a16696a\t2026-10-21\n";
  };
  return { calls, exec };
}

describe("resolveVersionInfo", () => {
  test("checkout with readable git log exposes commit + date", () => {
    const { exec } = stubExec("ok");
    const info = resolveVersionInfo({
      version: "0.0.0",
      moduleDir: FAKE_MODULE_DIR,
      exec,
      existsFn: FAKE_EXISTS_FN,
    });
    expect(info).toEqual({
      version: "0.0.0",
      source: true,
      commit: "a16696a",
      commitDate: "2026-10-21",
    });
  });

  test("no checkout skips git entirely", () => {
    const { calls, exec } = stubExec("ok");
    const info = resolveVersionInfo({
      version: "0.0.0",
      moduleDir: FAKE_MODULE_DIR,
      exec,
      existsFn: () => false,
    });
    expect(info).toEqual({
      version: "0.0.0",
      source: false,
      commit: null,
      commitDate: null,
    });
    expect(calls.length).toBe(0);
  });

  test("git failure degrades to source-only", () => {
    const { exec } = stubExec("throws");
    const info = resolveVersionInfo({
      version: "0.0.0",
      moduleDir: FAKE_MODULE_DIR,
      exec,
      existsFn: FAKE_EXISTS_FN,
    });
    expect(info.commit).toBeNull();
    expect(info.commitDate).toBeNull();
    expect(info.source).toBe(true);
  });

  test("empty git output degrades to source-only", () => {
    const { exec } = stubExec("empty");
    const info = resolveVersionInfo({
      version: "0.0.0",
      moduleDir: FAKE_MODULE_DIR,
      exec,
      existsFn: FAKE_EXISTS_FN,
    });
    expect(info.commit).toBeNull();
    expect(info.commitDate).toBeNull();
  });
});

describe("llamactl --version", () => {
  test("checkout prints version with sha and date", async () => {
    const { calls, exec } = stubExec("ok");
    const { result, stdout, stderr } = await captureProcessStreams(() =>
      runVersion([], {
        version: "0.0.0",
        moduleDir: FAKE_MODULE_DIR,
        exec,
        existsFn: FAKE_EXISTS_FN,
      }),
    );
    expect(result).toBe(0);
    expect(stdout).toBe("llamactl 0.0.0 (a16696a, 2026-10-21, source)\n");
    expect(stderr).toBe("");
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({
      file: "git",
      args: ["-C", "/fake/repo", "log", "-1", "--format=%h%x09%cs"],
    });
  });

  test("no checkout prints bare version", async () => {
    const { calls, exec } = stubExec("ok");
    const { result, stdout } = await captureProcessStreams(() =>
      runVersion([], {
        version: "0.0.0",
        moduleDir: FAKE_MODULE_DIR,
        exec,
        existsFn: () => false,
      }),
    );
    expect(result).toBe(0);
    expect(stdout).toBe("llamactl 0.0.0\n");
    expect(calls.length).toBe(0);
  });

  test("checkout with git failure prints (source)", async () => {
    const { exec } = stubExec("throws");
    const { result, stdout } = await captureProcessStreams(() =>
      runVersion([], {
        version: "0.0.0",
        moduleDir: FAKE_MODULE_DIR,
        exec,
        existsFn: FAKE_EXISTS_FN,
      }),
    );
    expect(result).toBe(0);
    expect(stdout).toBe("llamactl 0.0.0 (source)\n");
  });

  test("--json in a checkout emits full record", async () => {
    const { exec } = stubExec("ok");
    const { result, stdout } = await captureProcessStreams(() =>
      runVersion(["--json"], {
        version: "0.0.0",
        moduleDir: FAKE_MODULE_DIR,
        exec,
        existsFn: FAKE_EXISTS_FN,
      }),
    );
    expect(result).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      version: "0.0.0",
      source: true,
      commit: "a16696a",
      commitDate: "2026-10-21",
    });
  });

  test("--json with no checkout emits nulls", async () => {
    const { exec } = stubExec("ok");
    const { result, stdout } = await captureProcessStreams(() =>
      runVersion(["--json"], {
        version: "0.0.0",
        moduleDir: FAKE_MODULE_DIR,
        exec,
        existsFn: () => false,
      }),
    );
    expect(result).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      version: "0.0.0",
      source: false,
      commit: null,
      commitDate: null,
    });
  });

  test("unknown flag exits 1", async () => {
    const { exec } = stubExec("ok");
    const { result, stdout, stderr } = await captureProcessStreams(() =>
      runVersion(["--bogus"], {
        version: "0.0.0",
        moduleDir: FAKE_MODULE_DIR,
        exec,
        existsFn: FAKE_EXISTS_FN,
      }),
    );
    expect(result).toBe(1);
    expect(stderr).toContain("Unknown flag for version: --bogus");
    expect(stdout).toBe("");
  });
});

// #743: VersionDeps gains `buildStamp`; a compiled stamp wins over any
// checkout probe and short-circuits git entirely.
interface StampVersionDeps {
  version: string;
  moduleDir: string;
  exec: (file: string, args: string[]) => string;
  existsFn: (p: string) => boolean;
  buildStamp: { commit: string; dirty: boolean; builtAt: string };
}

const BUILD_STAMP = {
  commit: "0123456789abcdef0123456789abcdef01234567",
  dirty: false,
  builtAt: "2026-11-17T10:00:00.000Z",
};

function stampDeps(
  exec: (file: string, args: string[]) => string,
  existsFn: (p: string) => boolean,
  buildStamp: { commit: string; dirty: boolean; builtAt: string },
): StampVersionDeps {
  return { version: "0.0.0", moduleDir: FAKE_MODULE_DIR, exec, existsFn, buildStamp };
}

describe("llamactl --version (compiled build stamp)", () => {
  test("compiled stamp prints short commit, build time and install kind", async () => {
    const { calls, exec } = stubExec("ok");
    const { result, stdout, stderr } = await captureProcessStreams(() =>
      runVersion(
        [],
        stampDeps(exec, () => false, BUILD_STAMP),
      ),
    );
    expect(result).toBe(0);
    expect(stdout).toBe(
      "llamactl 0.0.0 (0123456789ab, built 2026-11-17T10:00:00.000Z, compiled)\n",
    );
    expect(stderr).toBe("");
    expect(calls).toHaveLength(0);
  });

  test("dirty compiled stamp marks the commit -dirty", async () => {
    const { calls, exec } = stubExec("ok");
    const { result, stdout } = await captureProcessStreams(() =>
      runVersion(
        [],
        stampDeps(exec, () => false, { ...BUILD_STAMP, dirty: true }),
      ),
    );
    expect(result).toBe(0);
    expect(stdout).toBe(
      "llamactl 0.0.0 (0123456789ab-dirty, built 2026-11-17T10:00:00.000Z, compiled)\n",
    );
    expect(calls).toHaveLength(0);
  });

  test("--json emits the compiled stamp fields", async () => {
    const { exec } = stubExec("ok");
    const { result, stdout } = await captureProcessStreams(() =>
      runVersion(
        ["--json"],
        stampDeps(exec, () => false, BUILD_STAMP),
      ),
    );
    expect(result).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      version: "0.0.0",
      source: false,
      commit: "0123456789abcdef0123456789abcdef01234567",
      commitDate: null,
      dirty: false,
      builtAt: "2026-11-17T10:00:00.000Z",
    });
  });

  test("compiled stamp wins even when a checkout is present", async () => {
    const { calls, exec } = stubExec("ok");
    const { result, stdout } = await captureProcessStreams(() =>
      runVersion([], stampDeps(exec, FAKE_EXISTS_FN, BUILD_STAMP)),
    );
    expect(result).toBe(0);
    expect(stdout).toBe(
      "llamactl 0.0.0 (0123456789ab, built 2026-11-17T10:00:00.000Z, compiled)\n",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("llamactl --version (e2e)", () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  beforeEach(() => {
    temp = makeTempRuntime();
  });
  afterEach(() => {
    temp.cleanup();
  });

  test("--version exits 0 and prints the version", () => {
    const r = runCli(["--version"], temp.env);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^llamactl \S+/);
    expect(r.stderr).not.toContain("Unknown command");
  });

  test("version subcommand behaves the same", () => {
    const r = runCli(["version"], temp.env);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^llamactl \S+/);
    expect(r.stderr).not.toContain("Unknown command");
  });

  test("--version --json parses", () => {
    const r = runCli(["--version", "--json"], temp.env);
    expect(r.code).toBe(0);
    const parsed: unknown = JSON.parse(r.stdout);
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();
    const record = parsed as Record<string, unknown>;
    expect(typeof record["version"]).toBe("string");
  });
});
