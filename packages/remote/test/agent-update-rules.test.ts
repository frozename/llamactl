import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import {
  handleAgentUpdate,
  runWatchdog,
  type WatchdogConfig,
  type WatchdogDeps,
} from "../src/server/agent-update.js";

/**
 * Pins of agent-update rules not covered by agent-update.test.ts: the
 * x-sha256 header validation shape, the method → auth → sha check
 * order, the staging cleanup + size bookkeeping, and the exact
 * watchdog probe schedule (grace + intervals, no sleep after the last
 * attempt). Fully hermetic — recorded deps, temp selfPath files, no
 * sleeps, spawns or network.
 */

const BEARER = "agt_rules_token_90210";
const TOKEN_HASH = createHash("sha256").update(BEARER).digest("hex");
const ORIGINAL_BYTES = Buffer.from("#!/bin/sh\necho v1\n");
const WD_HOST = "10.0.0.5";
const WD_PORT = 7843;

let tmp = "";
let selfPath = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "agent-update-rules-"));
  selfPath = join(tmp, "llamactl-agent");
  writeFileSync(selfPath, ORIGINAL_BYTES);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function shaHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function postReq(
  body: Uint8Array,
  opts: { sha?: string; bearer?: string; omitSha?: boolean } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/octet-stream" };
  headers["authorization"] = `Bearer ${opts.bearer ?? BEARER}`;
  if (!opts.omitSha) {
    headers["x-sha256"] = opts.sha ?? shaHex(body);
  }
  return new Request("http://test/agent/update", {
    method: "POST",
    headers,
    body: Uint8Array.from(body),
  });
}

function updateOpts(): { tokenHash: string; selfPath: string; exitAfter: false } {
  return { tokenHash: TOKEN_HASH, selfPath, exitAfter: false };
}

// ---------------------------------------------------------------------------
// runWatchdog — recording deps
// ---------------------------------------------------------------------------

type ProbeStep = boolean | "throw";

interface WatchdogRecorder {
  sleeps: number[];
  probes: [string, number][];
  copies: [string, string][];
  spawns: string[];
  stderrLines: string[];
  deps: WatchdogDeps;
}

function makeRecorder(
  script: ProbeStep[] = [false],
  overrides: Partial<WatchdogDeps> = {},
): WatchdogRecorder {
  const sleeps: number[] = [];
  const probes: [string, number][] = [];
  const copies: [string, string][] = [];
  const spawns: string[] = [];
  const stderrLines: string[] = [];
  let step = 0;
  const deps: WatchdogDeps = {
    probe: (host, port) => {
      probes.push([host, port]);
      const current = script[step] ?? script[script.length - 1] ?? false;
      step += 1;
      if (current === "throw") {
        return Promise.reject(new Error("probe exploded"));
      }
      return Promise.resolve(current);
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    copyFile: (src, dst) => {
      copies.push([src, dst]);
    },
    spawn: (execPath) => {
      spawns.push(execPath);
    },
    stderr: (msg) => {
      stderrLines.push(msg);
    },
    ...overrides,
  };
  return { sleeps, probes, copies, spawns, stderrLines, deps };
}

function wdConfig(overrides: Partial<WatchdogConfig> = {}): WatchdogConfig {
  return {
    selfPath,
    previousPath: `${selfPath}.previous`,
    host: WD_HOST,
    port: WD_PORT,
    ...overrides,
  };
}

describe("runWatchdog — probe schedule", () => {
  test("defaults: grace then seven intervals, eight probes", async () => {
    const rec = makeRecorder();
    await runWatchdog(wdConfig(), rec.deps);
    expect(rec.sleeps).toEqual([8000, 5000, 5000, 5000, 5000, 5000, 5000, 5000]);
    expect(rec.probes).toHaveLength(8);
    for (const [host, port] of rec.probes) {
      expect(host).toBe("10.0.0.5");
      expect(port).toBe(7843);
    }
  });

  test("no sleep after the final attempt", async () => {
    const rec = makeRecorder();
    await runWatchdog(
      wdConfig({ gracePeriodMs: 11, pollIntervalMs: 3, maxPollAttempts: 3 }),
      rec.deps,
    );
    expect(rec.sleeps).toEqual([11, 3, 3]);
    expect(rec.copies).toHaveLength(1);
    expect(rec.spawns).toHaveLength(1);
  });

  test("stops at the first healthy probe", async () => {
    const rec = makeRecorder([false, false, true]);
    await runWatchdog(
      wdConfig({ gracePeriodMs: 20, pollIntervalMs: 6, maxPollAttempts: 8 }),
      rec.deps,
    );
    expect(rec.probes).toHaveLength(3);
    expect(rec.sleeps).toEqual([20, 6, 6]);
    expect(rec.copies).toHaveLength(0);
    expect(rec.spawns).toHaveLength(0);
  });

  test("a probe that throws is not fatal", async () => {
    const rec = makeRecorder(["throw", true]);
    await runWatchdog(wdConfig({ maxPollAttempts: 3 }), rec.deps);
    expect(rec.probes).toHaveLength(2);
    expect(rec.copies).toHaveLength(0);
    expect(rec.spawns).toHaveLength(0);
    expect(rec.stderrLines).toHaveLength(0);
  });

  test("a relaunch that throws is reported, not rethrown", async () => {
    const rec = makeRecorder([false], {
      spawn: () => {
        throw new Error("spawn boom");
      },
    });
    await runWatchdog(
      wdConfig({ gracePeriodMs: 0, pollIntervalMs: 0, maxPollAttempts: 1 }),
      rec.deps,
    );
    expect(rec.copies).toEqual([[`${selfPath}.previous`, selfPath]]);
    expect(rec.stderrLines).toHaveLength(1);
    expect(rec.stderrLines[0]).toContain("relaunch failed");
    expect(rec.stderrLines[0]).toContain("spawn boom");
  });
});

// ---------------------------------------------------------------------------
// handleAgentUpdate — header rules + check order + bookkeeping
// ---------------------------------------------------------------------------

describe("handleAgentUpdate — x-sha256 header rules", () => {
  test("an uppercase digest is accepted and reported lowercase", async () => {
    const newBytes = new Uint8Array(Buffer.from("#!/bin/sh\necho v6-uppercase\n"));
    const lower = shaHex(newBytes);
    const res = await handleAgentUpdate(
      postReq(newBytes, { sha: lower.toUpperCase() }),
      updateOpts(),
    );
    expect(res.status).toBe(200);
    expect(readFileSync(selfPath).toString()).toBe("#!/bin/sh\necho v6-uppercase\n");
    const body = (await res.json()) as { newSha256: string };
    expect(body.newSha256).toBe(lower);
  });

  test("a 63-character hex digest is refused with the JSON envelope", async () => {
    const newBytes = new Uint8Array(Buffer.from("payload-63-chars"));
    const shortSha = shaHex(newBytes).slice(0, 63);
    const res = await handleAgentUpdate(postReq(newBytes, { sha: shortSha }), updateOpts());
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body).toStrictEqual({ ok: false, message: "missing-or-invalid-x-sha256-header" });
    expect(readFileSync(selfPath).toString()).toBe("#!/bin/sh\necho v1\n");
    expect(existsSync(`${selfPath}.previous`)).toBe(false);
  });

  test("a 64-character value containing a non-hex 'g' is refused", async () => {
    const newBytes = new Uint8Array(Buffer.from("payload-64-with-g"));
    const notHexSha = `${shaHex(newBytes).slice(0, 63)}g`;
    const res = await handleAgentUpdate(postReq(newBytes, { sha: notHexSha }), updateOpts());
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body).toStrictEqual({ ok: false, message: "missing-or-invalid-x-sha256-header" });
    expect(readFileSync(selfPath).toString()).toBe("#!/bin/sh\necho v1\n");
    expect(existsSync(`${selfPath}.previous`)).toBe(false);
  });
});

describe("handleAgentUpdate — check order", () => {
  test("the method gate runs before auth", async () => {
    const req = new Request("http://test/agent/update", { method: "PUT" });
    const res = await handleAgentUpdate(req, updateOpts());
    expect(res.status).toBe(405);
  });

  test("auth runs before sha validation", async () => {
    const newBytes = new Uint8Array(Buffer.from("payload-order"));
    const res = await handleAgentUpdate(
      postReq(newBytes, { bearer: "wrong-bearer", omitSha: true }),
      updateOpts(),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("the empty-body refusal is a JSON envelope", async () => {
    const empty = new Uint8Array(0);
    const res = await handleAgentUpdate(postReq(empty, { sha: shaHex(empty) }), updateOpts());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body).toStrictEqual({ ok: false, message: "empty-body" });
    expect(readFileSync(selfPath).toString()).toBe("#!/bin/sh\necho v1\n");
  });
});

describe("handleAgentUpdate — result bookkeeping", () => {
  test("reports old and new sizes and cleans up the staging file", async () => {
    const newBytes = new Uint8Array(Buffer.from("v2-payload-of-a-different-length"));
    expect(ORIGINAL_BYTES.length).toBe(18);
    const res = await handleAgentUpdate(postReq(newBytes), updateOpts());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { oldSize: number; newSize: number };
    expect(body.oldSize).toBe(18);
    expect(body.newSize).toBe(newBytes.length);
    expect(existsSync(join(dirname(selfPath), ".llamactl-agent.staging"))).toBe(false);
  });
});

describe("handleAgentUpdate — watchdog config forwarding", () => {
  test("tuning values are forwarded to the watchdog config", async () => {
    const newBytes = new Uint8Array(Buffer.from("#!/bin/sh\necho v12\n"));
    const captured: WatchdogConfig[] = [];
    const res = await handleAgentUpdate(postReq(newBytes), {
      ...updateOpts(),
      watchdog: {
        host: "127.0.0.1",
        port: 7843,
        gracePeriodMs: 1,
        pollIntervalMs: 2,
        maxPollAttempts: 3,
      },
      _spawnWatchdog: (cfg): void => {
        captured.push(cfg);
      },
    });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toStrictEqual({
      selfPath,
      previousPath: `${selfPath}.previous`,
      host: "127.0.0.1",
      port: 7843,
      gracePeriodMs: 1,
      pollIntervalMs: 2,
      maxPollAttempts: 3,
    });
  });

  test("unset tuning keys are omitted, not present as undefined", async () => {
    const newBytes = new Uint8Array(Buffer.from("#!/bin/sh\necho v13\n"));
    const captured: WatchdogConfig[] = [];
    const res = await handleAgentUpdate(postReq(newBytes), {
      ...updateOpts(),
      watchdog: { host: "10.0.0.9", port: 7843 },
      _spawnWatchdog: (cfg): void => {
        captured.push(cfg);
      },
    });
    expect(res.status).toBe(200);
    const cfg = captured[0];
    if (cfg === undefined) {
      throw new Error("watchdog config was not captured");
    }
    expect(Object.keys(cfg).sort()).toEqual(["host", "port", "previousPath", "selfPath"]);
  });
});
