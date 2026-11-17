import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as nf from "../src/nodeFacts.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

/**
 * #743 — RED tests for the build-stamp API on nodeFacts: compile-time
 * defines (`compiledBuildStamp` / `buildStampDefines`), the resolver
 * (`resolveBuildStamp`) that prefers a compiled stamp and otherwise
 * reports the source checkout's HEAD, and the new `versions` fields.
 * The exports do not exist at base, so they are reached through a
 * namespace cast and every call is guarded by a typeof assertion —
 * failures are assertion failures, never import or link errors.
 */

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BUILT_AT = "2026-11-17T10:00:00.000Z";
const NODE_FACTS_PATH = join(import.meta.dir, "..", "src", "nodeFacts.ts");
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

type BuildStampFields = {
  commit: string | null;
  dirty: boolean | null;
  builtAt: string | null;
};

type BuildStampApi = {
  compiledBuildStamp?: () => BuildStampFields | null;
  buildStampDefines?: (stamp: {
    commit: string;
    dirty: boolean;
    builtAt: string;
  }) => Record<string, string>;
  resolveBuildStamp?: (deps?: {
    compiled?: BuildStampFields | null;
    moduleDir?: string;
    readSourceRevision?: () => string | null;
  }) => BuildStampFields & { installKind: "compiled" | "source" };
};

const stampApi = nf as unknown as BuildStampApi;

const ENTRY_SOURCE = `import { compiledBuildStamp } from ${JSON.stringify(NODE_FACTS_PATH)};
console.log(JSON.stringify(compiledBuildStamp()));
`;

interface BundleRun {
  json: unknown;
  stderr: string;
}

async function bundleAndRun(tmp: string, define?: Record<string, string>): Promise<BundleRun> {
  const entry = join(tmp, "entry.ts");
  const outdir = join(tmp, "out");
  writeFileSync(entry, ENTRY_SOURCE);
  const build = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    outdir,
    ...(define === undefined ? {} : { define }),
  });
  expect(build.success).toBe(true);
  const outFile = build.outputs.find((output) => output.kind === "entry-point")?.path;
  if (typeof outFile !== "string") {
    throw new Error("bundle produced no entry-point output");
  }
  const proc = Bun.spawnSync([process.execPath, outFile]);
  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr);
  expect(proc.exitCode).toBe(0);
  return { json: JSON.parse(stdout) as unknown, stderr };
}

function gitHead(): string {
  return execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

describe("nodeFacts build stamp (#743)", () => {
  test("compiledBuildStamp, buildStampDefines and resolveBuildStamp are exported", () => {
    expect(typeof stampApi.compiledBuildStamp).toBe("function");
    expect(typeof stampApi.buildStampDefines).toBe("function");
    expect(typeof stampApi.resolveBuildStamp).toBe("function");
  });

  test("a bundle built with buildStampDefines reports the stamp", async () => {
    const buildStampDefines = stampApi.buildStampDefines;
    expect(typeof buildStampDefines).toBe("function");
    if (typeof buildStampDefines !== "function") return;
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-buildstamp-"));
    try {
      const stamp = { commit: COMMIT, dirty: true, builtAt: BUILT_AT };
      const run = await bundleAndRun(tmp, buildStampDefines(stamp));
      expect(run.json).toEqual(stamp);
      expect(run.stderr).not.toContain("ReferenceError");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a bundle built without defines reports a null stamp", async () => {
    expect(typeof stampApi.compiledBuildStamp).toBe("function");
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-buildstamp-"));
    try {
      const run = await bundleAndRun(tmp);
      expect(run.json).toBeNull();
      expect(run.stderr).not.toContain("ReferenceError");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("resolveBuildStamp prefers a compiled stamp over the source revision", () => {
    const resolveBuildStamp = stampApi.resolveBuildStamp;
    expect(typeof resolveBuildStamp).toBe("function");
    if (typeof resolveBuildStamp !== "function") return;
    const stamp = resolveBuildStamp({
      compiled: { commit: COMMIT, dirty: false, builtAt: BUILT_AT },
      moduleDir: "/x",
      readSourceRevision: () => "ignored",
    });
    expect(stamp).toEqual({
      commit: COMMIT,
      dirty: false,
      builtAt: BUILT_AT,
      installKind: "compiled",
    });
  });

  test("resolveBuildStamp reports the source HEAD for a checkout", () => {
    const resolveBuildStamp = stampApi.resolveBuildStamp;
    expect(typeof resolveBuildStamp).toBe("function");
    if (typeof resolveBuildStamp !== "function") return;
    const stamp = resolveBuildStamp({
      compiled: null,
      moduleDir: "/repo/packages/core/src",
      readSourceRevision: () => COMMIT,
    });
    expect(stamp).toEqual({
      commit: COMMIT,
      dirty: null,
      builtAt: null,
      installKind: "source",
    });
  });

  test("resolveBuildStamp reports compiled for a bunfs binary without defines", () => {
    const resolveBuildStamp = stampApi.resolveBuildStamp;
    expect(typeof resolveBuildStamp).toBe("function");
    if (typeof resolveBuildStamp !== "function") return;
    const stamp = resolveBuildStamp({
      compiled: null,
      moduleDir: "/$bunfs/root",
      readSourceRevision: () => null,
    });
    expect(stamp.installKind).toBe("compiled");
    expect(stamp.commit).toBeNull();
    expect(stamp.dirty).toBeNull();
    expect(stamp.builtAt).toBeNull();
  });

  test("resolveBuildStamp() with defaults reports this checkout's HEAD", () => {
    const resolveBuildStamp = stampApi.resolveBuildStamp;
    expect(typeof resolveBuildStamp).toBe("function");
    if (typeof resolveBuildStamp !== "function") return;
    const stamp = resolveBuildStamp();
    expect(stamp.installKind).toBe("source");
    expect(stamp.commit).toBe(gitHead());
  });

  test("resolveVersions exposes commit, installKind, dirty and builtAt", () => {
    const versions = nf.resolveVersions() as ReturnType<typeof nf.resolveVersions> & {
      commit?: string | null;
      installKind?: string;
      dirty?: boolean | null;
      builtAt?: string | null;
    };
    expect(versions.commit).toBe(gitHead());
    expect(versions.installKind).toBe("source");
    expect("dirty" in versions).toBe(true);
    expect("builtAt" in versions).toBe(true);
  });
});
