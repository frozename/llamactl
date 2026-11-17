import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as artifacts from "../src/commands/artifacts.js";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../src/safe-fs.js";

/**
 * #744 — RED tests for `artifacts build-agent` producing versioned
 * per-commit binaries: output lands in `agent/<platform>/<commit12>`
 * (plus `-dirty`), a sibling temp file is compiled then renamed into
 * place, `manifest.json` records platform/commit/dirty/sha256/builtAt/
 * bun/signIdentity, the top-level `llamactl-agent` is repointed to the
 * versioned binary, and `current` is written last. `list`/`prune`
 * surface builds alongside releases. `src` points at a path that does
 * not exist so nothing real compiles; every assertion is on injected
 * fakes or the temp dir — failures are assertion failures, never
 * import, link or spawn errors.
 */

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BUILT_AT = "2026-11-17T10:00:00.000Z";
const PLATFORM = "linux-x64";

type BuildStamp = {
  commit: string;
  dirty: boolean;
  builtAt: string;
};

type BuildAgentBinaryDeps = {
  exec: (file: string, args: string[]) => string;
  spawn: (cmd: string[]) => Promise<number>;
  now: () => Date;
  codesign?: (binaryPath: string, identity: string) => Promise<number>;
};

type BuildAgentBinaryResult = {
  ok: boolean;
  outPath: string;
  code: number;
  reason?: string;
  signCode?: number;
  stamp?: BuildStamp;
};

type BuildAgentBinaryOptions = {
  target: string;
  src: string | null;
  dir: string;
  allowDirty?: boolean;
  signIdentity?: string;
  deps?: BuildAgentBinaryDeps;
};

type AgentBuildManifest = {
  platform: string;
  commit: string;
  dirty: boolean;
  sha256: string;
  builtAt: string;
  bun: string;
  signIdentity: string | null;
};

// The versioned-build surface is new at base; buildAgentBinary exists
// but writes the top-level path directly and knows nothing about
// manifests, the current pointer or deps.codesign. The namespace cast
// keeps the suite link-clean pre-fix.
const api = artifacts as unknown as {
  agentBinaryPath: (platform: string, dir: string) => string;
  buildAgentBinary: (
    opts: BuildAgentBinaryOptions,
    deps?: BuildAgentBinaryDeps,
  ) => Promise<BuildAgentBinaryResult>;
  runArtifacts: (argv: string[]) => Promise<number>;
};

let tmp = "";
let savedArtifactsDir: string | undefined;

function sha256hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function platformDir(): string {
  return join(tmp, "agent", PLATFORM);
}

function buildDir(name: string): string {
  return join(platformDir(), name);
}

function currentPath(): string {
  return join(platformDir(), "current");
}

function seedBuild(name: string, bytes: string, commit: string = COMMIT): void {
  const bdir = buildDir(name);
  mkdirSync(bdir, { recursive: true });
  writeFileSync(join(bdir, "llamactl-agent"), bytes);
  writeFileSync(
    join(bdir, "manifest.json"),
    JSON.stringify({
      platform: PLATFORM,
      commit,
      dirty: false,
      sha256: sha256hex(bytes),
      builtAt: BUILT_AT,
      bun: "1.4.3",
      signIdentity: null,
    }),
  );
}

function seedRelease(tag: string, bytes: string): void {
  const rdir = join(platformDir(), "versions", tag);
  mkdirSync(rdir, { recursive: true });
  writeFileSync(join(rdir, "llamactl-agent"), bytes);
}

function seedCurrent(name: string): void {
  mkdirSync(platformDir(), { recursive: true });
  writeFileSync(currentPath(), `${name}\n`);
}

function readManifest(path: string): AgentBuildManifest | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AgentBuildManifest;
  } catch {
    return null;
  }
}

function outfileOf(cmd: readonly string[]): string | undefined {
  const idx = cmd.indexOf("--outfile");
  if (idx >= 0) return cmd[idx + 1];
  const inline = cmd.find((arg) => arg.startsWith("--outfile="));
  return inline?.slice("--outfile=".length);
}

interface FakeDeps {
  deps: BuildAgentBinaryDeps;
  execCalls: { file: string; args: string[] }[];
  spawnCalls: string[][];
  codesignCalls: { path: string; identity: string }[];
}

function makeDeps(
  status: string,
  opts?: { spawnWrite?: boolean; spawnCode?: number; codesignCode?: number },
): FakeDeps {
  const execCalls: { file: string; args: string[] }[] = [];
  const spawnCalls: string[][] = [];
  const codesignCalls: { path: string; identity: string }[] = [];
  const deps: BuildAgentBinaryDeps = {
    exec: (file: string, args: string[]): string => {
      execCalls.push({ file, args });
      if (args.includes("rev-parse")) return `${COMMIT}\n`;
      if (args.includes("status")) {
        // Faithful porcelain simulation: --untracked-files=no keeps
        // "??" entries out of the dirty check.
        if (args.includes("--untracked-files=no")) {
          return status
            .split("\n")
            .filter((line) => !line.startsWith("??"))
            .join("\n");
        }
        return status;
      }
      if (args.includes("--version")) return "1.4.3\n";
      return "";
    },
    spawn: (cmd: string[]): Promise<number> => {
      spawnCalls.push(cmd);
      const outfile = outfileOf(cmd);
      try {
        if (typeof outfile === "string" && opts?.spawnWrite !== false) {
          mkdirSync(dirname(outfile), { recursive: true });
          writeFileSync(outfile, "compiled-bytes");
        }
        return Promise.resolve(opts?.spawnCode ?? 0);
      } catch {
        return Promise.resolve(1);
      }
    },
    now: (): Date => new Date(BUILT_AT),
    codesign: (binaryPath: string, identity: string): Promise<number> => {
      codesignCalls.push({ path: binaryPath, identity });
      appendFileSync(binaryPath, "-signed");
      return Promise.resolve(opts?.codesignCode ?? 0);
    },
  };
  return { deps, execCalls, spawnCalls, codesignCalls };
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

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const spy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    const code = await fn();
    return { code, out: chunks.join("") };
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-artifacts-build-"));
  savedArtifactsDir = process.env["LLAMACTL_ARTIFACTS_DIR"];
  process.env["LLAMACTL_ARTIFACTS_DIR"] = tmp;
});

afterEach(() => {
  if (savedArtifactsDir === undefined) {
    delete process.env["LLAMACTL_ARTIFACTS_DIR"];
  } else {
    process.env["LLAMACTL_ARTIFACTS_DIR"] = savedArtifactsDir;
  }
  savedArtifactsDir = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

const src = (): string => join(tmp, "fake/packages/cli/src/bin.ts");

describe("artifacts build-agent versioned output (#744)", () => {
  test("clean build publishes versioned binary + manifest + current", async () => {
    const fake = makeDeps("");
    const result = await tryBuild({ target: PLATFORM, src: src(), dir: tmp }, fake.deps);
    const build = buildDir("0123456789ab");
    const bin = join(build, "llamactl-agent");
    expect(result.ok).toBe(true);
    expect(result.outPath).toBe(bin);
    expect(fake.spawnCalls).toHaveLength(1);
    const outfile = outfileOf(fake.spawnCalls[0]!);
    expect(outfile).toBeDefined();
    if (outfile === undefined) return;
    expect(dirname(outfile)).toBe(build);
    expect(readdirSync(build).sort()).toEqual(["llamactl-agent", "manifest.json"]);
    expect(readManifest(join(build, "manifest.json"))).toEqual({
      platform: PLATFORM,
      commit: COMMIT,
      dirty: false,
      sha256: sha256hex("compiled-bytes"),
      builtAt: BUILT_AT,
      bun: "1.4.3",
      signIdentity: null,
    });
    expect(readFileSync(currentPath(), "utf8").trim()).toBe("0123456789ab");
    expect(readFileSync(api.agentBinaryPath(PLATFORM, tmp), "utf8")).toBe("compiled-bytes");
  });

  test("dirty build with allowDirty lands in a -dirty dir and repoints current", async () => {
    const fake = makeDeps(" M foo.ts\n");
    const result = await tryBuild(
      { target: PLATFORM, src: src(), dir: tmp, allowDirty: true },
      fake.deps,
    );
    const build = buildDir("0123456789ab-dirty");
    expect(result.ok).toBe(true);
    expect(result.outPath).toBe(join(build, "llamactl-agent"));
    const manifest = readManifest(join(build, "manifest.json"));
    expect(manifest).not.toBeNull();
    if (manifest === null) return;
    expect(manifest.dirty).toBe(true);
    expect(readFileSync(currentPath(), "utf8").trim()).toBe("0123456789ab-dirty");
  });

  test("failed compile keeps the previous current and writes no manifest", async () => {
    mkdirSync(platformDir(), { recursive: true });
    writeFileSync(currentPath(), "aaaaaaaaaaaa\n");
    const fake = makeDeps("", { spawnWrite: false, spawnCode: 1 });
    const result = await tryBuild({ target: PLATFORM, src: src(), dir: tmp }, fake.deps);
    const build = buildDir("0123456789ab");
    expect(result.ok).toBe(false);
    expect(result.outPath).toBe(join(build, "llamactl-agent"));
    expect(fake.spawnCalls).toHaveLength(1);
    const outfile = outfileOf(fake.spawnCalls[0]!);
    expect(outfile).toBeDefined();
    if (outfile === undefined) return;
    expect(dirname(outfile)).toBe(build);
    expect(readFileSync(currentPath(), "utf8").trim()).toBe("aaaaaaaaaaaa");
    expect(readManifest(join(build, "manifest.json"))).toBeNull();
  });

  test("compile that produces no binary is a failure, not a publish", async () => {
    const fake = makeDeps("", { spawnWrite: false });
    const result = await tryBuild({ target: PLATFORM, src: src(), dir: tmp }, fake.deps);
    expect(result.ok).toBe(false);
    expect(result.reason ?? "").toContain("produced no binary");
    expect(existsSync(currentPath())).toBe(false);
  });

  test("darwin build signs the versioned binary before hashing + manifest", async () => {
    const identity = "Apple Development: Test (TEAM1234)";
    const fake = makeDeps("");
    const result = await tryBuild(
      { target: "darwin-arm64", src: src(), dir: tmp, signIdentity: identity },
      fake.deps,
    );
    const build = join(tmp, "agent", "darwin-arm64", "0123456789ab");
    expect(result.ok).toBe(true);
    expect(fake.codesignCalls).toHaveLength(1);
    const signed = fake.codesignCalls[0]!;
    expect(dirname(signed.path)).toBe(build);
    expect(signed.identity).toBe(identity);
    const manifest = readManifest(join(build, "manifest.json"));
    expect(manifest).not.toBeNull();
    if (manifest === null) return;
    expect(manifest.sha256).toBe(sha256hex("compiled-bytes-signed"));
    expect(manifest.signIdentity).toBe(identity);
    expect(readFileSync(join(build, "llamactl-agent"), "utf8")).toBe("compiled-bytes-signed");
  });

  test("codesign failure still publishes with signIdentity null", async () => {
    const identity = "Apple Development: Test (TEAM1234)";
    const fake = makeDeps("", { codesignCode: 1 });
    const result = await tryBuild(
      { target: "darwin-arm64", src: src(), dir: tmp, signIdentity: identity },
      fake.deps,
    );
    const build = join(tmp, "agent", "darwin-arm64", "0123456789ab");
    expect(result.ok).toBe(true);
    expect(result.signCode).toBe(1);
    expect(fake.codesignCalls).toHaveLength(1);
    const manifest = readManifest(join(build, "manifest.json"));
    expect(manifest).not.toBeNull();
    if (manifest === null) return;
    expect(manifest.signIdentity).toBeNull();
  });
});

describe("artifacts list + prune versioned builds (#744)", () => {
  function seedListFixture(): void {
    seedBuild("0123456789ab", "new-bytes");
    seedBuild("bbbbbbbbbbbb", "b-bytes", "b".repeat(40));
    seedRelease("v0.5.0", "release-bytes");
    seedCurrent("0123456789ab");
  }

  test("list shows builds and releases with the active marker", async () => {
    seedListFixture();
    const { code, out } = await captureStdout(() => api.runArtifacts(["list", `--dir=${tmp}`]));
    expect(code).toBe(0);
    expect(out).toMatch(/^\* linux-x64\t0123456789ab\t0123456789ab\t/m);
    expect(out).toMatch(/^ {2}linux-x64\tbbbbbbbbbbbb\t/m);
    expect(out).toMatch(/^ {2}linux-x64\tv0\.5\.0\t-\t/m);
  });

  test("prune dry-run lists non-active builds, never the current one", async () => {
    seedListFixture();
    const { code, out } = await captureStdout(() =>
      api.runArtifacts(["prune", `--dir=${tmp}`, "--target=linux-x64", "--keep=0"]),
    );
    expect(code).toBe(0);
    expect(out).toMatch(/WOULD\s*\tlinux-x64\tbbbbbbbbbbbb/);
    expect(out).not.toContain("\t0123456789ab\t");
  });
});

describe("artifacts build-agent pointer ordering (#744)", () => {
  test("relink failure keeps the previous current pointer", async () => {
    mkdirSync(platformDir(), { recursive: true });
    writeFileSync(currentPath(), "aaaaaaaaaaaa\n");
    const topLevel = api.agentBinaryPath(PLATFORM, tmp);
    mkdirSync(topLevel, { recursive: true });
    writeFileSync(join(topLevel, "occupied"), "x");
    const fake = makeDeps("");
    const result = await tryBuild({ target: PLATFORM, src: src(), dir: tmp }, fake.deps);
    expect(result.ok).toBe(false);
    expect(result.reason ?? "").toContain("failed to update top-level pointer");
    expect(readFileSync(currentPath(), "utf8").trim()).toBe("aaaaaaaaaaaa");
  });
});

describe("codesign identifier is explicit (#744)", () => {
  test("codesignBinary passes --identifier llamactl-agent regardless of file name", async () => {
    const signApi = artifacts as unknown as {
      codesignBinary: (
        binaryPath: string,
        identity: string,
        run?: (cmd: string[]) => Promise<number>,
      ) => Promise<number>;
    };
    const seen: string[][] = [];
    const tmpName = join(tmp, "llamactl-agent.partial-1-2");
    const code = await signApi.codesignBinary(tmpName, "Apple Development: Test", (cmd) => {
      seen.push(cmd);
      return Promise.resolve(0);
    });
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    const cmd = seen[0]!;
    const idx = cmd.indexOf("--identifier");
    expect(idx).toBeGreaterThan(-1);
    expect(cmd[idx + 1]).toBe("llamactl-agent");
    expect(cmd.at(-1)).toBe(tmpName);
  });
});
