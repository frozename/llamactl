import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as artifacts from "../src/commands/artifacts.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

/**
 * #743 — RED tests for `artifacts build-agent` stamping compiled
 * binaries: the build must resolve the git commit + dirty flag +
 * build time, refuse a dirty tree unless --allow-dirty, and pass the
 * stamp into `bun build` as --define flags. `src` deliberately points
 * at a path that does not exist so the un-injected base build fails
 * fast instead of compiling anything; every assertion is on the
 * injected fakes' recordings or the structured result, so failures
 * are assertion failures — never import, link or spawn errors.
 */

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BUILT_AT = "2026-11-17T10:00:00.000Z";

type BuildStamp = {
  commit: string | null;
  dirty: boolean | null;
  builtAt: string | null;
};

type BuildAgentBinaryDeps = {
  exec: (file: string, args: string[]) => string;
  spawn: (cmd: string[]) => Promise<number>;
  now: () => Date;
};

type BuildAgentBinaryResult = {
  ok: boolean;
  outPath: string;
  code: number;
  reason?: string;
  stamp?: BuildStamp;
};

type BuildAgentBinaryOptions = {
  target: artifacts.Platform;
  src: string | null;
  dir: string;
  allowDirty?: boolean;
  deps?: BuildAgentBinaryDeps;
  signIdentity?: string;
};

type BuildAgentBinaryFn = (
  opts: BuildAgentBinaryOptions,
  deps?: BuildAgentBinaryDeps,
) => Promise<BuildAgentBinaryResult>;

type ParseBuildFlagsFn = (argv: string[]) => {
  allowDirty?: boolean;
  error?: string;
  target?: string;
};

// buildAgentBinary exists at base but lacks the deps/stamp surface;
// parseBuildFlags is new. Both are reached through a namespace cast so
// the suite typechecks before the fix lands.
const api = artifacts as unknown as {
  buildAgentBinary: BuildAgentBinaryFn;
  parseBuildFlags?: ParseBuildFlagsFn;
};

interface FakeDeps {
  deps: BuildAgentBinaryDeps;
  execCalls: { file: string; args: string[] }[];
  spawnCalls: string[][];
}

function makeDeps(status: string, opts?: { failRevParse?: boolean }): FakeDeps {
  const execCalls: { file: string; args: string[] }[] = [];
  const spawnCalls: string[][] = [];
  const deps: BuildAgentBinaryDeps = {
    exec: (file: string, args: string[]): string => {
      execCalls.push({ file, args });
      if (args.includes("rev-parse")) {
        if (opts?.failRevParse === true) throw new Error("git rev-parse failed");
        return `${COMMIT}\n`;
      }
      if (args.includes("status")) {
        // Faithful porcelain simulation: --untracked-files=no is what
        // keeps "??" entries out of the dirty check.
        if (args.includes("--untracked-files=no")) {
          return status
            .split("\n")
            .filter((line) => !line.startsWith("??"))
            .join("\n");
        }
        return status;
      }
      return "";
    },
    spawn: (cmd: string[]): Promise<number> => {
      spawnCalls.push(cmd);
      const outfile = cmd[cmd.indexOf("--outfile") + 1];
      try {
        if (typeof outfile === "string") {
          mkdirSync(dirname(outfile), { recursive: true });
          writeFileSync(outfile, "compiled-bytes");
        }
        return Promise.resolve(0);
      } catch {
        return Promise.resolve(1);
      }
    },
    now: (): Date => new Date(BUILT_AT),
  };
  return { deps, execCalls, spawnCalls };
}

async function tryBuild(
  opts: BuildAgentBinaryOptions,
  deps: BuildAgentBinaryDeps,
): Promise<BuildAgentBinaryResult> {
  try {
    // deps travels both ways so the suite pins the behavior regardless of
    // whether the fix threads it through the options bag or a second
    // parameter — whichever lands, the fakes are what run.
    return await api.buildAgentBinary({ ...opts, deps }, deps);
  } catch {
    return { ok: false, outPath: "", code: 1 };
  }
}

function defineArgs(cmd: readonly string[]): string[] {
  return cmd.flatMap((arg, index): string[] => {
    if (arg === "--define") {
      const value = cmd[index + 1];
      return value === undefined ? [] : [value];
    }
    return arg.startsWith("--define=") ? [arg.slice("--define=".length)] : [];
  });
}

describe("artifacts build-agent build stamp (#743)", () => {
  let tmp = "";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "llamactl-artifacts-stamp-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const src = (): string => join(tmp, "fake/packages/cli/src/bin.ts");

  test("dirty tree without allowDirty is refused before the build spawns", async () => {
    const fake = makeDeps(" M foo.ts\n");
    const result = await tryBuild({ target: "linux-x64", src: src(), dir: tmp }, fake.deps);
    expect(result.ok).toBe(false);
    expect(fake.spawnCalls).toHaveLength(0);
    expect(result.reason ?? "").toMatch(/dirty/);
    expect(result.reason ?? "").toContain("--allow-dirty");
    expect(result.reason ?? "").toContain("install-launchd --binary");
  });

  test("dirty tree with allowDirty compiles with the stamp defines", async () => {
    const fake = makeDeps(" M foo.ts\n");
    const result = await tryBuild(
      { target: "linux-x64", src: src(), dir: tmp, allowDirty: true },
      fake.deps,
    );
    expect(result.ok).toBe(true);
    expect(fake.spawnCalls).toHaveLength(1);
    const cmd = fake.spawnCalls[0]!;
    expect(cmd).toContain("--compile");
    expect(cmd).toContain("--target=bun-linux-x64");
    const defines = defineArgs(cmd);
    expect(defines).toContain(`__BUILD_STAMP_COMMIT__="${COMMIT}"`);
    expect(defines).toContain("__BUILD_STAMP_DIRTY__=true");
    expect(defines).toContain(`__BUILD_STAMP_BUILT_AT__="${BUILT_AT}"`);
    expect(cmd).toContain(src());
    expect(cmd).toContain("--outfile");
    const outfile = cmd[cmd.indexOf("--outfile") + 1] ?? "";
    expect(dirname(outfile)).toBe(join(tmp, "agent", "linux-x64", `${COMMIT.slice(0, 12)}-dirty`));
    expect(result.outPath).toBe(
      join(tmp, "agent", "linux-x64", `${COMMIT.slice(0, 12)}-dirty`, "llamactl-agent"),
    );
    expect(result.stamp).toEqual({ commit: COMMIT, dirty: true, builtAt: BUILT_AT });
  });

  test("clean tree compiles with __BUILD_STAMP_DIRTY__=false", async () => {
    const fake = makeDeps("");
    const result = await tryBuild({ target: "linux-x64", src: src(), dir: tmp }, fake.deps);
    expect(result.ok).toBe(true);
    expect(fake.spawnCalls).toHaveLength(1);
    expect(defineArgs(fake.spawnCalls[0]!)).toContain("__BUILD_STAMP_DIRTY__=false");
    expect(result.stamp).toEqual({ commit: COMMIT, dirty: false, builtAt: BUILT_AT });
  });

  test("untracked files are ignored via --untracked-files=no", async () => {
    const fake = makeDeps("?? newfile.ts\n");
    const result = await tryBuild({ target: "linux-x64", src: src(), dir: tmp }, fake.deps);
    expect(result.ok).toBe(true);
    const statusCall = fake.execCalls.find((call) => call.args.includes("status"));
    expect(statusCall).toBeDefined();
    expect(statusCall?.args ?? []).toContain("--porcelain");
    expect(statusCall?.args ?? []).toContain("--untracked-files=no");
    expect(defineArgs(fake.spawnCalls[0]!)).toContain("__BUILD_STAMP_DIRTY__=false");
  });

  test("rev-parse failure refuses with a commit reason", async () => {
    const fake = makeDeps("", { failRevParse: true });
    const result = await tryBuild({ target: "linux-x64", src: src(), dir: tmp }, fake.deps);
    expect(result.ok).toBe(false);
    expect(fake.spawnCalls).toHaveLength(0);
    expect(result.reason ?? "").toMatch(/commit/);
  });

  test("parseBuildFlags accepts --allow-dirty", () => {
    const parseBuildFlags = api.parseBuildFlags;
    expect(typeof parseBuildFlags).toBe("function");
    if (typeof parseBuildFlags !== "function") return;
    const flagged = parseBuildFlags(["--allow-dirty", "--target=linux-x64"]);
    expect(flagged.allowDirty).toBe(true);
    const plain = parseBuildFlags(["--target=linux-x64"]);
    expect(Boolean(plain.allowDirty)).toBe(false);
  });
});
