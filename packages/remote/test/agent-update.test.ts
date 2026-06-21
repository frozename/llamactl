import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, createHash as cryptoHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "../src/safe-fs.js";
import {
  handleAgentUpdate,
  runWatchdog,
  type WatchdogConfig,
  type WatchdogDeps,
} from "../src/server/agent-update.js";

/**
 * Agent self-update endpoint. Tests run handleAgentUpdate against a
 * temp "self" file rather than the live process binary, with
 * exitAfter:false so the test runner doesn't get killed by the
 * usual `setTimeout(() => process.exit(0), 200)`.
 */

const BEARER = "agt_test_token_12345";
const TOKEN_HASH = cryptoHash("sha256").update(BEARER).digest("hex");

let tmp = "";
let selfPath = "";
const ORIGINAL_BYTES = Buffer.from("#!/bin/sh\necho v1\n");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "agent-update-"));
  selfPath = join(tmp, "llamactl-agent");
  writeFileSync(selfPath, ORIGINAL_BYTES);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function postReq(body: Uint8Array, opts: { sha?: string; bearer?: string } = {}): Request {
  const sha = opts.sha ?? createHash("sha256").update(body).digest("hex");
  const bearer = opts.bearer ?? BEARER;
  return new Request("http://test/agent/update", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "x-sha256": sha,
      "content-type": "application/octet-stream",
    },
    // `Uint8Array<ArrayBufferLike>` (e.g. a SharedArrayBuffer-backed view)
    // is not assignable to the lib's `BodyInit`, which wants an
    // `ArrayBuffer`-backed view. Copy into a fresh ArrayBuffer-backed
    // Uint8Array — byte-identical payload, satisfies the type.
    body: Uint8Array.from(body),
  });
}

describe("handleAgentUpdate — happy path", () => {
  test("swaps the binary, snapshots .previous, returns the hash diff", async () => {
    const newBytes = new Uint8Array(Buffer.from("#!/bin/sh\necho v2-newer\n"));
    const res = await handleAgentUpdate(postReq(newBytes), {
      tokenHash: TOKEN_HASH,
      selfPath,
      exitAfter: false,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      oldSha256: string;
      newSha256: string;
      installedAt: string;
      previousAt: string;
    };
    expect(body.ok).toBe(true);
    expect(body.installedAt).toBe(selfPath);
    expect(body.previousAt).toBe(`${selfPath}.previous`);
    // installedAt now contains the new bytes
    expect(readFileSync(selfPath).toString()).toBe("#!/bin/sh\necho v2-newer\n");
    // previousAt contains the original bytes
    expect(readFileSync(body.previousAt).toString()).toBe("#!/bin/sh\necho v1\n");
    // Hashes match
    expect(body.newSha256).toBe(createHash("sha256").update(newBytes).digest("hex"));
    expect(body.oldSha256).toBe(createHash("sha256").update(ORIGINAL_BYTES).digest("hex"));
    // Binary is executable
    const mode = statSync(selfPath).mode & 0o777;
    expect(mode & 0o100).toBe(0o100); // user-x bit set
  });

  test("does NOT re-prompt sha256 if header matches", async () => {
    const newBytes = new Uint8Array(Buffer.from("a different binary"));
    const sha = createHash("sha256").update(newBytes).digest("hex");
    const res = await handleAgentUpdate(postReq(newBytes, { sha }), {
      tokenHash: TOKEN_HASH,
      selfPath,
      exitAfter: false,
    });
    expect(res.status).toBe(200);
  });
});

describe("handleAgentUpdate — auth + integrity", () => {
  test("rejects missing bearer with 401", async () => {
    const req = new Request("http://test/agent/update", {
      method: "POST",
      headers: { "x-sha256": createHash("sha256").update("x").digest("hex") },
      body: Buffer.from("x"),
    });
    const res = await handleAgentUpdate(req, { tokenHash: TOKEN_HASH, selfPath, exitAfter: false });
    expect(res.status).toBe(401);
  });

  test("rejects wrong bearer with 401", async () => {
    const res = await handleAgentUpdate(
      postReq(new Uint8Array(Buffer.from("x")), { bearer: "wrong" }),
      { tokenHash: TOKEN_HASH, selfPath, exitAfter: false },
    );
    expect(res.status).toBe(401);
  });

  test("rejects missing X-Sha256 with 400", async () => {
    const req = new Request("http://test/agent/update", {
      method: "POST",
      headers: { authorization: `Bearer ${BEARER}` },
      body: Buffer.from("x"),
    });
    const res = await handleAgentUpdate(req, { tokenHash: TOKEN_HASH, selfPath, exitAfter: false });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("x-sha256");
  });

  test("rejects sha256 mismatch with 400 + does NOT swap", async () => {
    const newBytes = new Uint8Array(Buffer.from("mismatched-payload"));
    const wrongSha = createHash("sha256").update("something else").digest("hex");
    const res = await handleAgentUpdate(postReq(newBytes, { sha: wrongSha }), {
      tokenHash: TOKEN_HASH,
      selfPath,
      exitAfter: false,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("sha256-mismatch");
    // Original binary untouched
    expect(readFileSync(selfPath).toString()).toBe("#!/bin/sh\necho v1\n");
    // No .previous created
    expect(existsSync(`${selfPath}.previous`)).toBe(false);
  });

  test("rejects empty body with 400", async () => {
    const empty = new Uint8Array(0);
    const sha = createHash("sha256").update(empty).digest("hex");
    const res = await handleAgentUpdate(postReq(empty, { sha }), {
      tokenHash: TOKEN_HASH,
      selfPath,
      exitAfter: false,
    });
    expect(res.status).toBe(400);
  });

  test("rejects non-POST methods with 405", async () => {
    const req = new Request("http://test/agent/update", { method: "GET" });
    const res = await handleAgentUpdate(req, { tokenHash: TOKEN_HASH, selfPath, exitAfter: false });
    expect(res.status).toBe(405);
  });
});

describe("handleAgentUpdate — selfPath errors", () => {
  test("returns 500 when selfPath is missing", async () => {
    const newBytes = new Uint8Array(Buffer.from("payload"));
    const res = await handleAgentUpdate(postReq(newBytes), {
      tokenHash: TOKEN_HASH,
      selfPath: join(tmp, "does-not-exist"),
      exitAfter: false,
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("selfPath");
  });

  test("round-trips two sequential updates — second sees the first as old", async () => {
    const v2 = new Uint8Array(Buffer.from("binary-v2"));
    await handleAgentUpdate(postReq(v2), {
      tokenHash: TOKEN_HASH,
      selfPath,
      exitAfter: false,
    });
    const v3 = new Uint8Array(Buffer.from("binary-v3-bigger"));
    const res = await handleAgentUpdate(postReq(v3), {
      tokenHash: TOKEN_HASH,
      selfPath,
      exitAfter: false,
    });
    const body = (await res.json()) as { oldSha256: string; newSha256: string };
    expect(body.oldSha256).toBe(createHash("sha256").update(v2).digest("hex"));
    expect(body.newSha256).toBe(createHash("sha256").update(v3).digest("hex"));
    // .previous now contains v2 (overwritten from the original)
    expect(readFileSync(`${selfPath}.previous`).toString()).toBe("binary-v2");
  });
});

// `copyFileSync` import is referenced indirectly by handleAgentUpdate;
// we keep the import to make sure the test runner sees the same node:fs
// surface the implementation uses.
void copyFileSync;

// ---------------------------------------------------------------------------
// runWatchdog — unit tests for the injectable watchdog logic
// ---------------------------------------------------------------------------

const WD_BASE: WatchdogConfig = {
  selfPath: "/tmp/wdtest-agent",
  previousPath: "/tmp/wdtest-agent.previous",
  host: "127.0.0.1",
  port: 7843,
  gracePeriodMs: 0,
  pollIntervalMs: 0,
  maxPollAttempts: 1,
};

function makeDeps(overrides: Partial<WatchdogDeps> = {}): {
  copyFileCalls: [string, string][];
  spawnCalls: string[];
  stderrLines: string[];
  deps: WatchdogDeps;
} {
  const copyFileCalls: [string, string][] = [];
  const spawnCalls: string[] = [];
  const stderrLines: string[] = [];
  const base: WatchdogDeps = {
    probe: () => Promise.resolve(false),
    sleep: () => Promise.resolve(),
    copyFile: (src, dst) => {
      copyFileCalls.push([src, dst]);
    },
    spawn: (p) => {
      spawnCalls.push(p);
    },
    stderr: (msg) => {
      stderrLines.push(msg);
    },
  };
  return { copyFileCalls, spawnCalls, stderrLines, deps: { ...base, ...overrides } };
}

describe("runWatchdog", () => {
  test("probe returns true within attempts → clean exit, no restore/relaunch", async () => {
    const { copyFileCalls, spawnCalls, deps } = makeDeps({ probe: () => Promise.resolve(true) });
    await runWatchdog({ ...WD_BASE, maxPollAttempts: 3 }, deps);
    expect(copyFileCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
  });

  test("probe always false → restores .previous over selfPath and relaunches", async () => {
    const { copyFileCalls, spawnCalls, deps } = makeDeps();
    await runWatchdog(WD_BASE, deps);
    expect(copyFileCalls).toEqual([["/tmp/wdtest-agent.previous", "/tmp/wdtest-agent"]]);
    expect(spawnCalls).toEqual(["/tmp/wdtest-agent"]);
  });

  test("restore throws → spawn still called, error does not propagate", async () => {
    const { spawnCalls, stderrLines, deps } = makeDeps({
      copyFile: () => {
        throw new Error("disk full");
      },
    });
    let threw = false;
    try {
      await runWatchdog(WD_BASE, deps);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(spawnCalls).toEqual(["/tmp/wdtest-agent"]);
    expect(stderrLines.some((l) => l.includes("restore"))).toBe(true);
  });
});

describe("handleAgentUpdate — watchdog spawn integration", () => {
  test("calls _spawnWatchdog with correct config when watchdog option is set", async () => {
    const newBytes = new Uint8Array(Buffer.from("#!/bin/sh\necho v2\n"));
    let spawnedConfig: WatchdogConfig | undefined;
    const res = await handleAgentUpdate(postReq(newBytes), {
      tokenHash: TOKEN_HASH,
      selfPath,
      exitAfter: false,
      watchdog: { host: "127.0.0.1", port: 7843 },
      _spawnWatchdog: (cfg) => {
        spawnedConfig = cfg;
      },
    });
    expect(res.status).toBe(200);
    expect(spawnedConfig).toBeDefined();
    expect(spawnedConfig!.host).toBe("127.0.0.1");
    expect(spawnedConfig!.port).toBe(7843);
    expect(spawnedConfig!.selfPath).toBe(selfPath);
    expect(spawnedConfig!.previousPath).toBe(`${selfPath}.previous`);
  });

  test("does NOT call _spawnWatchdog when watchdog option is absent", async () => {
    const newBytes = new Uint8Array(Buffer.from("#!/bin/sh\necho v2\n"));
    let spawnCalled = false;
    const res = await handleAgentUpdate(postReq(newBytes), {
      tokenHash: TOKEN_HASH,
      selfPath,
      exitAfter: false,
      _spawnWatchdog: () => {
        spawnCalled = true;
      },
    });
    expect(res.status).toBe(200);
    expect(spawnCalled).toBe(false);
  });
});
