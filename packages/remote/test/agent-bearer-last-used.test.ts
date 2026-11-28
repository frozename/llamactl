/**
 * #218 — persistence of per-bearer last use. The agent records every
 * admitted bearer under its audit label, keeps the map in a 0600 JSON
 * file beside agent.yaml, throttles rewrites of an already-persisted
 * label, and seeds the last-used gauge from that file at startup. The
 * file and every failure note carry labels and paths only — never a
 * token or a hash.
 */
import * as agentConfigMod from "@llamactl/core/config/agent-config";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "../src/safe-fs.js";
import * as authMod from "../src/server/auth.js";
import { type RunningAgent, startAgentServer } from "../src/server/serve.js";

interface BearerAuthRecord {
  tokenName: string;
  method: string;
  pathname: string;
}

type BearerLastUsedMap = Record<string, string>;

interface BearerLastUsedRecorder {
  record: (label: string) => void;
  snapshot: () => BearerLastUsedMap;
}

type BearerLastUsedPath = (dir: string) => string;
type ReadBearerLastUsed = (path: string) => BearerLastUsedMap;
type BearerLastUsedRecorderFactory = (
  path: string,
  options?: { now?: () => number; flushIntervalMs?: number },
) => BearerLastUsedRecorder;

const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMACTL_CONFIG",
  "LLAMA_CPP_HOST",
  "LLAMA_CPP_PORT",
] as const;

function agentConfigExport(name: string): unknown {
  return (agentConfigMod as unknown as Record<string, unknown>)[name];
}

// Looked up by name so this file still loads on a base without the export (RED).
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function requireAgentConfigFn<T>(name: string): T {
  const fn = agentConfigExport(name);
  expect(typeof fn).toBe("function");
  return fn as T;
}

/** Run fn with stderr captured; resolves to what it wrote. */
async function captureStderr(fn: () => void | Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return buf;
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

describe("bearer last-used persistence", () => {
  const originalEnv = { ...process.env };
  let dir: string;
  let server: RunningAgent;
  let list: authMod.NamedBearerToken[];
  let records: BearerAuthRecord[];
  const primary = authMod.generateToken();
  const named = authMod.generateToken();

  const push = (record: BearerAuthRecord): void => {
    records.push(record);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-bearer-last-used-"));
    process.env["DEV_STORAGE"] = dir;
    process.env["LOCAL_AI_RUNTIME_DIR"] = join(dir, "runtime");
    process.env["LLAMACTL_CONFIG"] = join(dir, "no-kubeconfig");
    list = [];
    records = [];
    server = startAgentServer({
      tokenHash: primary.hash,
      bearerTokens: (): authMod.NamedBearerToken[] => list,
      onAuthenticated: push,
    });
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = originalEnv[key]!;
    }
  });

  function get(pathname: string, token: string): Promise<Response> {
    return server.handleRequest!(
      new Request(`http://x${pathname}`, { headers: { authorization: `Bearer ${token}` } }),
      { address: "192.168.1.50", port: 1, family: "IPv4" },
    );
  }

  async function restartWithLastUsed(bearerLastUsed: BearerLastUsedRecorder): Promise<void> {
    await server.stop();
    server = startAgentServer({
      tokenHash: primary.hash,
      bearerTokens: () => list,
      onAuthenticated: push,
      bearerLastUsed,
    });
  }

  test("bearerLastUsedPath names bearer-last-used.json in the agent dir", () => {
    const bearerLastUsedPath = requireAgentConfigFn<BearerLastUsedPath>("bearerLastUsedPath");
    expect(agentConfigExport("BEARER_LAST_USED_FILE")).toBe("bearer-last-used.json");
    expect(bearerLastUsedPath(dir)).toBe(join(dir, "bearer-last-used.json"));
  });

  test("the recorder persists a first use at once and rewrites a label only after the flush interval", () => {
    const bearerLastUsedRecorder =
      requireAgentConfigFn<BearerLastUsedRecorderFactory>("bearerLastUsedRecorder");
    const readBearerLastUsed = requireAgentConfigFn<ReadBearerLastUsed>("readBearerLastUsed");
    const path = join(dir, "bearer-last-used.json");
    const t0 = Date.parse("2026-01-02T03:04:05.000Z");
    const iso = (ms: number): string => new Date(ms).toISOString();
    let nowMs = t0;
    const recorder = bearerLastUsedRecorder(path, {
      now: () => nowMs,
      flushIntervalMs: 60_000,
    });

    expect(recorder.snapshot()).toEqual({});

    recorder.record("ci");
    expect(readBearerLastUsed(path)).toEqual({ ci: iso(t0) });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ci: iso(t0) });

    nowMs = t0 + 1000;
    recorder.record("ci");
    expect(readBearerLastUsed(path)).toEqual({ ci: iso(t0) });
    expect(recorder.snapshot()["ci"]).toBe(iso(t0 + 1000));

    nowMs = t0 + 2000;
    recorder.record("ops");
    expect(readBearerLastUsed(path)).toEqual({ ci: iso(t0 + 1000), ops: iso(t0 + 2000) });

    nowMs = t0 + 61_000;
    recorder.record("ci");
    expect(readBearerLastUsed(path)).toEqual({ ci: iso(t0 + 61_000), ops: iso(t0 + 2000) });

    expect(statSync(path).mode & 0o777).toBe(0o600);

    expect(() => {
      recorder.record("bad name!");
    }).not.toThrow();
    expect(readBearerLastUsed(path)).toEqual({ ci: iso(t0 + 61_000), ops: iso(t0 + 2000) });
    expect(recorder.snapshot()).toEqual({ ci: iso(t0 + 61_000), ops: iso(t0 + 2000) });
  });

  test("readBearerLastUsed returns {} for a missing, malformed or wrong-shaped file and keeps only valid labels and dates", () => {
    const readBearerLastUsed = requireAgentConfigFn<ReadBearerLastUsed>("readBearerLastUsed");
    const bearerLastUsedRecorder =
      requireAgentConfigFn<BearerLastUsedRecorderFactory>("bearerLastUsedRecorder");
    const path = join(dir, "bearer-last-used.json");
    const stamp = "2026-01-01T00:00:00.000Z";
    writeFileSync(
      path,
      JSON.stringify({
        ci: stamp,
        "named:default": stamp,
        default: stamp,
        "bad name!": stamp,
        x: "not-a-date",
        y: 5,
      }),
      "utf8",
    );
    const expected = { ci: stamp, "named:default": stamp, default: stamp };
    expect(readBearerLastUsed(path)).toEqual(expected);

    expect(readBearerLastUsed(join(dir, "missing.json"))).toEqual({});
    const malformed = join(dir, "malformed.json");
    writeFileSync(malformed, "{not json", "utf8");
    expect(readBearerLastUsed(malformed)).toEqual({});
    const array = join(dir, "array.json");
    writeFileSync(array, "[]", "utf8");
    expect(readBearerLastUsed(array)).toEqual({});
    const nullFile = join(dir, "null.json");
    writeFileSync(nullFile, "null", "utf8");
    expect(readBearerLastUsed(nullFile)).toEqual({});

    const t0 = Date.parse("2026-01-02T03:04:05.000Z");
    expect(bearerLastUsedRecorder(path, { now: () => t0 }).snapshot()).toEqual(
      readBearerLastUsed(path),
    );
  });

  test("a failed write never throws and notes only the path, retrying after the interval", async () => {
    const bearerLastUsedRecorder =
      requireAgentConfigFn<BearerLastUsedRecorderFactory>("bearerLastUsedRecorder");
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    const path = join(blocker, "bearer-last-used.json");
    const t0 = Date.parse("2026-01-02T03:04:05.000Z");
    const iso = (ms: number): string => new Date(ms).toISOString();
    let nowMs = t0;
    const recorder = bearerLastUsedRecorder(path, {
      now: () => nowMs,
      flushIntervalMs: 60_000,
    });

    const first = await captureStderr(() => {
      expect(() => {
        recorder.record("ci");
      }).not.toThrow();
    });
    const firstLines = nonEmptyLines(first);
    expect(firstLines).toHaveLength(1);
    expect(firstLines[0]).toContain(path);

    const quiet = await captureStderr(() => {
      nowMs = t0;
      expect(() => {
        recorder.record("ci");
      }).not.toThrow();
      nowMs = t0 + 1000;
      expect(() => {
        recorder.record("ci");
      }).not.toThrow();
    });
    expect(nonEmptyLines(quiet)).toEqual([]);
    expect(recorder.snapshot()["ci"]).toBe(iso(t0 + 1000));

    nowMs = t0 + 60_000;
    const retry = await captureStderr(() => {
      expect(() => {
        recorder.record("ci");
      }).not.toThrow();
    });
    const retryLines = nonEmptyLines(retry);
    expect(retryLines).toHaveLength(1);
    expect(retryLines[0]).toContain(path);

    for (const line of [...firstLines, ...retryLines]) {
      expect(line).not.toContain("ll_agt_");
    }
  });

  test("the server hands each admitted bearer label to bearerLastUsed.record, never a refused one, and a throwing record still admits", async () => {
    list.push({ name: "lu-ci", tokenHash: named.hash });
    const labels: string[] = [];
    await restartWithLastUsed({
      record: (label: string): void => {
        labels.push(label);
      },
      snapshot: () => ({}),
    });

    expect((await get("/metrics", primary.token)).status).toBe(200);
    expect((await get("/metrics", named.token)).status).toBe(200);
    expect((await get("/metrics", authMod.generateToken().token)).status).toBe(401);
    expect(labels).toEqual(["default", "lu-ci"]);

    await restartWithLastUsed({
      record: (): void => {
        throw new Error("sink down");
      },
      snapshot: () => ({}),
    });
    let status = 0;
    let body = "";
    const captured = await captureStderr(async () => {
      const res = await get("/metrics", primary.token);
      status = res.status;
      body = await res.text();
    });
    expect(status).toBe(200);
    for (const secret of [primary.token, primary.hash, named.token, named.hash]) {
      expect(captured + body).not.toContain(secret);
    }
  });

  test("the server seeds last-used gauges from the snapshot at start without counting requests", async () => {
    await restartWithLastUsed({
      record: (): void => undefined,
      snapshot: () => ({
        "lu-seed-a": "2026-01-02T03:04:05.000Z",
        "lu-seed-b": "2026-01-02T03:04:05.500Z",
        "lu-seed-bad": "nope",
      }),
    });

    const scrape = await get("/metrics", primary.token);
    expect(scrape.status).toBe(200);
    const text = await scrape.text();
    expect(text).toMatch(
      /^llamactl_agent_bearer_last_used_timestamp_seconds\{[^}]*token="lu-seed-a"[^}]*\} 1767323045$/m,
    );
    expect(text).toMatch(
      /^llamactl_agent_bearer_last_used_timestamp_seconds\{[^}]*token="lu-seed-b"[^}]*\} 1767323045\.5$/m,
    );
    expect(text).not.toMatch(/token="lu-seed-bad"/);
    expect(text).not.toMatch(/^llamactl_agent_bearer_requests_total\{[^}]*token="lu-seed-a"/m);

    let startError: unknown;
    try {
      await restartWithLastUsed({
        record: (): void => undefined,
        snapshot: (): BearerLastUsedMap => {
          throw new Error("snapshot down");
        },
      });
    } catch (err) {
      startError = err;
    }
    expect(startError).toBeUndefined();
    expect((await get("/metrics", primary.token)).status).toBe(200);
  });
});
