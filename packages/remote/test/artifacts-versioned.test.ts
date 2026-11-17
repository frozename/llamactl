import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as infraFetch from "../src/infra/artifacts-fetch.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "../src/safe-fs.js";
import * as serverArtifacts from "../src/server/artifacts.js";

/**
 * #744 — RED tests for versioned per-commit agent artifacts. Builds land
 * under `agent/<platform>/<commit12>[-dirty]/` with a `manifest.json`, a
 * `current` pointer file selects the served build, GET/HEAD expose
 * `x-sha256` + `x-llamactl-commit`, and list/prune/fetch understand
 * per-commit builds alongside `versions/<tag>/` releases. Everything is
 * seeded by hand under a temp dir and reached through namespace casts so
 * the suite typechecks before the fix lands — every failure is an
 * assertion failure, never an import, link or spawn error.
 */

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BUILT_AT = "2026-11-17T10:00:00.000Z";
const PLATFORM = "linux-x64";
const BUILD_NAME = "0123456789ab";

type ArtifactFetcher = (
  url: string,
  opts?: { accept?: string; timeoutMs?: number },
) => Promise<{
  ok: boolean;
  status: number;
  body: Uint8Array;
  text: () => string;
}>;

type InstalledAgentVersion = {
  target: string;
  tag: string;
  path: string;
  bytes: number;
  mtimeMs: number;
  active: boolean;
  kind?: string;
  commit?: string | null;
};

type PrunedAgentVersion = {
  target: string;
  tag: string;
  path: string;
  bytes: number;
  mtimeMs: number;
};

type PruneAgentArtifactsResult = {
  inspected: InstalledAgentVersion[];
  candidates: PrunedAgentVersion[];
  removed: PrunedAgentVersion[];
  executed: boolean;
  keep: number;
};

type FetchAgentReleaseResult =
  | {
      ok: true;
      version: string;
      target: string;
      path: string;
      sha256: string;
      bytes: number;
      signature: unknown;
    }
  | { ok: false; reason: string; message: string; detail?: unknown };

// The versioned-build surface is new at base; the functions exist but
// their contracts (manifest fields, kind/commit columns, current-pointer
// semantics) do not. Cast keeps the suite link-clean pre-fix.
const fetchApi = infraFetch as unknown as {
  agentAssetShaUrl: (repo: string, tag: string, target: string) => string;
  agentAssetUrl: (repo: string, tag: string, target: string) => string;
  fetchAgentRelease: (opts: {
    repo: string;
    version: string;
    target: string;
    artifactsDir?: string;
    fetcher?: ArtifactFetcher;
    verifySig?: "skip" | "best-effort" | "require";
  }) => Promise<FetchAgentReleaseResult>;
  listAgentVersions: (opts?: { artifactsDir?: string; target?: string }) => InstalledAgentVersion[];
  pruneAgentArtifacts: (opts?: {
    artifactsDir?: string;
    target?: string;
    keep?: number;
    execute?: boolean;
  }) => PruneAgentArtifactsResult;
};

const serverApi = serverArtifacts as unknown as {
  handleArtifact: (req: Request, url: URL, opts?: { artifactsDir?: string }) => Response;
};

let dir = "";
let savedArtifactsDir: string | undefined;

function sha256hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function platformDir(): string {
  return join(dir, "agent", PLATFORM);
}

function buildDir(name: string): string {
  return join(platformDir(), name);
}

function currentPath(): string {
  return join(platformDir(), "current");
}

function seedBuild(
  name: string,
  bytes: string,
  opts?: { commit?: string; dirty?: boolean; mtimeMs?: number },
): void {
  const bdir = buildDir(name);
  mkdirSync(bdir, { recursive: true });
  const bin = join(bdir, "llamactl-agent");
  writeFileSync(bin, bytes);
  writeFileSync(
    join(bdir, "manifest.json"),
    JSON.stringify({
      platform: PLATFORM,
      commit: opts?.commit ?? COMMIT,
      dirty: opts?.dirty ?? false,
      sha256: sha256hex(bytes),
      builtAt: BUILT_AT,
      bun: "1.4.3",
      signIdentity: null,
    }),
  );
  if (opts?.mtimeMs !== undefined) {
    const s = opts.mtimeMs / 1000;
    utimesSync(bin, s, s);
  }
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

function seedLegacyTopLevel(bytes: string): void {
  mkdirSync(platformDir(), { recursive: true });
  writeFileSync(join(platformDir(), "llamactl-agent"), bytes);
}

async function call(
  method: "GET" | "HEAD",
): Promise<{ status: number; headers: Headers; body: string }> {
  const req = new Request(`http://agent/artifacts/agent/${PLATFORM}`, { method });
  const res = serverApi.handleArtifact(req, new URL(req.url), { artifactsDir: dir });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

function stubFetcher(
  responses: Record<string, { ok: boolean; status: number; body: Uint8Array }>,
): { fetcher: ArtifactFetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: ArtifactFetcher = async (url) => {
    await Promise.resolve();
    calls.push(url);
    const r = responses[url];
    if (!r) {
      throw new Error(`unexpected url: ${url}`);
    }
    return {
      ok: r.ok,
      status: r.status,
      body: r.body,
      text: () => new TextDecoder().decode(r.body),
    };
  };
  return { fetcher, calls };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llamactl-artifacts-versioned-"));
  savedArtifactsDir = process.env["LLAMACTL_ARTIFACTS_DIR"];
  process.env["LLAMACTL_ARTIFACTS_DIR"] = dir;
});

afterEach(() => {
  if (savedArtifactsDir === undefined) {
    delete process.env["LLAMACTL_ARTIFACTS_DIR"];
  } else {
    process.env["LLAMACTL_ARTIFACTS_DIR"] = savedArtifactsDir;
  }
  savedArtifactsDir = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("handleArtifact current pointer (#744)", () => {
  function seedPointerFixture(): string {
    seedBuild(BUILD_NAME, "new-bytes");
    seedCurrent(BUILD_NAME);
    seedLegacyTopLevel("old-bytes");
    return sha256hex("new-bytes");
  }

  test("GET serves the current build with sha256 + commit headers", async () => {
    const sha = seedPointerFixture();
    const { status, headers, body } = await call("GET");
    expect(status).toBe(200);
    expect(body).toBe("new-bytes");
    expect(headers.get("content-length")).toBe("9");
    expect(headers.get("x-sha256")).toBe(sha);
    expect(headers.get("x-llamactl-commit")).toBe(COMMIT);
  });

  test("HEAD serves the same headers with an empty body", async () => {
    const sha = seedPointerFixture();
    const { status, headers, body } = await call("HEAD");
    expect(status).toBe(200);
    expect(body).toBe("");
    expect(headers.get("x-sha256")).toBe(sha);
    expect(headers.get("x-llamactl-commit")).toBe(COMMIT);
  });

  test("invalid current name returns 500 instead of falling back", async () => {
    seedPointerFixture();
    writeFileSync(currentPath(), "../../etc\n");
    const { status, body } = await call("GET");
    expect(status).toBe(500);
    expect(body).toContain("invalid current pointer");
    expect(body).not.toContain("old-bytes");
  });

  test("valid current name with a missing build returns 500 naming it", async () => {
    seedPointerFixture();
    writeFileSync(currentPath(), "aaaaaaaaaaaa\n");
    const { status, body } = await call("GET");
    expect(status).toBe(500);
    expect(body).toContain("aaaaaaaaaaaa");
    expect(body).toContain("missing");
  });
});

describe("listAgentVersions + pruneAgentArtifacts build entries (#744)", () => {
  test("lists per-commit builds alongside releases, active from current", () => {
    seedBuild(BUILD_NAME, "new-bytes");
    seedCurrent(BUILD_NAME);
    seedRelease("v0.5.0", "release-bytes");

    const list = fetchApi.listAgentVersions({ artifactsDir: dir, target: PLATFORM });
    expect(list).toContainEqual(
      expect.objectContaining({
        tag: BUILD_NAME,
        kind: "build",
        commit: COMMIT,
        active: true,
      }) as InstalledAgentVersion,
    );
    expect(list).toContainEqual(
      expect.objectContaining({
        tag: "v0.5.0",
        kind: "release",
        active: false,
      }) as InstalledAgentVersion,
    );
  });

  test("prune flags non-current builds and execute removes only those", () => {
    seedBuild(BUILD_NAME, "new-bytes", { mtimeMs: 1_700_000_000_000 });
    seedBuild("bbbbbbbbbbbb", "b-bytes", {
      commit: "b".repeat(40),
      mtimeMs: 1_700_000_100_000,
    });
    seedBuild("cccccccccccc", "c-bytes", {
      commit: "c".repeat(40),
      mtimeMs: 1_700_000_200_000,
    });
    seedCurrent(BUILD_NAME);

    const dry = fetchApi.pruneAgentArtifacts({ artifactsDir: dir, keep: 0, target: PLATFORM });
    expect(dry.candidates.map((c) => c.tag).sort()).toEqual(["bbbbbbbbbbbb", "cccccccccccc"]);

    const result = fetchApi.pruneAgentArtifacts({
      artifactsDir: dir,
      keep: 0,
      target: PLATFORM,
      execute: true,
    });
    expect(result.executed).toBe(true);
    expect(existsSync(buildDir("bbbbbbbbbbbb"))).toBe(false);
    expect(existsSync(buildDir("cccccccccccc"))).toBe(false);
    expect(existsSync(join(buildDir(BUILD_NAME), "llamactl-agent"))).toBe(true);
    expect(existsSync(join(buildDir(BUILD_NAME), "manifest.json"))).toBe(true);
  });

  test("without current, the top-level symlink marks the matching build active", () => {
    seedBuild(BUILD_NAME, "new-bytes");
    seedBuild("bbbbbbbbbbbb", "b-bytes", { commit: "b".repeat(40) });
    mkdirSync(platformDir(), { recursive: true });
    symlinkSync(
      join(buildDir(BUILD_NAME), "llamactl-agent"),
      join(platformDir(), "llamactl-agent"),
    );

    const list = fetchApi.listAgentVersions({ artifactsDir: dir, target: PLATFORM });
    expect(list).toContainEqual(
      expect.objectContaining({
        tag: BUILD_NAME,
        kind: "build",
        active: true,
      }) as InstalledAgentVersion,
    );

    const plan = fetchApi.pruneAgentArtifacts({ artifactsDir: dir, keep: 0, target: PLATFORM });
    expect(plan.candidates.map((c) => c.tag).sort()).toEqual(["bbbbbbbbbbbb"]);
  });
});

describe("fetchAgentRelease current pointer (#744)", () => {
  test("fetched release replaces a stale current pointer end-to-end", async () => {
    seedBuild(BUILD_NAME, "new-bytes");
    seedCurrent(BUILD_NAME);
    seedLegacyTopLevel("old-bytes");

    const binBytes = "release-bytes";
    const sha = sha256hex(binBytes);
    const repo = "frozename/llamactl";
    const tag = "v0.9.0";
    const { fetcher } = stubFetcher({
      [fetchApi.agentAssetUrl(repo, tag, PLATFORM)]: {
        ok: true,
        status: 200,
        body: new TextEncoder().encode(binBytes),
      },
      [fetchApi.agentAssetShaUrl(repo, tag, PLATFORM)]: {
        ok: true,
        status: 200,
        body: new TextEncoder().encode(`${sha}  llamactl-agent-${PLATFORM}\n`),
      },
    });
    const result = await fetchApi.fetchAgentRelease({
      repo,
      version: tag,
      target: PLATFORM,
      artifactsDir: dir,
      fetcher,
    });
    expect(result.ok).toBe(true);
    expect(existsSync(currentPath())).toBe(false);
    const { body } = await call("GET");
    expect(body).toBe("release-bytes");
  });
});

describe("publish/serve never pair new bytes with an old x-sha256 (#744)", () => {
  type PublishApi = {
    publishAgentBuild: (input: {
      artifactsDir: string;
      platform: string;
      name: string;
      manifest: Record<string, unknown>;
      stagedBinary?: string;
    }) => { ok: true } | { ok: false; message: string };
  };
  const publishApi = infraFetch as unknown as PublishApi;

  function manifestFor(bytes: string): Record<string, unknown> {
    return {
      platform: PLATFORM,
      commit: COMMIT,
      dirty: false,
      sha256: sha256hex(bytes),
      builtAt: BUILT_AT,
      bun: "1.4.3",
      signIdentity: null,
    };
  }

  test("GET and HEAD refuse bytes whose sha256 differs from the manifest", async () => {
    // The window between the binary rename and the manifest rename of a
    // same-name rebuild: new bytes on disk, old manifest beside them.
    seedBuild(BUILD_NAME, "old-bytes");
    seedCurrent(BUILD_NAME);
    writeFileSync(join(buildDir(BUILD_NAME), "llamactl-agent"), "new-bytes");

    for (const method of ["GET", "HEAD"] as const) {
      const { status, headers, body } = await call(method);
      expect(status).toBe(503);
      expect(headers.get("retry-after")).toBe("1");
      expect(headers.get("x-sha256")).toBeNull();
      expect(body).not.toContain("new-bytes");
    }
  });

  test("a same-name republish with a staged binary serves matching bytes + header", async () => {
    seedBuild(BUILD_NAME, "old-bytes");
    seedCurrent(BUILD_NAME);
    const staged = join(buildDir(BUILD_NAME), "llamactl-agent.partial-test");
    writeFileSync(staged, "new-bytes");

    const published = publishApi.publishAgentBuild({
      artifactsDir: dir,
      platform: PLATFORM,
      name: BUILD_NAME,
      manifest: manifestFor("new-bytes"),
      stagedBinary: staged,
    });
    expect(published).toEqual({ ok: true });
    expect(existsSync(staged)).toBe(false);
    const leftovers = readdirSync(buildDir(BUILD_NAME)).filter((f) => f.includes(".partial-"));
    expect(leftovers).toEqual([]);

    const { status, headers, body } = await call("GET");
    expect(status).toBe(200);
    expect(body).toBe("new-bytes");
    expect(headers.get("x-sha256")).toBe(sha256hex("new-bytes"));
  });

  test("a missing staged binary publishes nothing", async () => {
    seedBuild(BUILD_NAME, "old-bytes");
    seedCurrent(BUILD_NAME);
    const published = publishApi.publishAgentBuild({
      artifactsDir: dir,
      platform: PLATFORM,
      name: BUILD_NAME,
      manifest: manifestFor("new-bytes"),
      stagedBinary: join(buildDir(BUILD_NAME), "llamactl-agent.partial-absent"),
    });
    expect(published.ok).toBe(false);
    const { status, headers, body } = await call("GET");
    expect(status).toBe(200);
    expect(body).toBe("old-bytes");
    expect(headers.get("x-sha256")).toBe(sha256hex("old-bytes"));
  });
});
