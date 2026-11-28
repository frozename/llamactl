/**
 * #218 — token rename/revoke must keep bearer-last-used.json coherent:
 * renames carry the source label's use, revoke prunes dead labels, and a
 * running recorder must not resurrect labels the CLI removed. Fixtures
 * write agent.yaml directly: no cert generation, no openssl, no network
 * and no live agent state. Output must never carry a token or a hash.
 */
import { agentConfig as agentConfigMod, auth } from "@llamactl/remote";
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgent } from "../src/commands/agent.js";
import fs from "../src/safe-fs.js";
import { parseJsonArray } from "./helpers.js";

type BearerLastUsedMap = Record<string, string>;
type ReadBearerLastUsed = (path: string) => BearerLastUsedMap;
type BearerLastUsedRecorderFactory = (
  path: string,
  options?: { now?: () => number; flushIntervalMs?: number },
) => {
  record: (label: string) => void;
  snapshot: () => BearerLastUsedMap;
};

let stdoutBuf = "";
let stderrBuf = "";
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;

function capture(): void {
  stdoutBuf = "";
  stderrBuf = "";
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array): true => {
    stdoutBuf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): true => {
    stderrBuf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
}

function restore(): void {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
}

const dirs: string[] = [];

function newAgentDir(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), "agent-token-lu-rr-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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

function bearerEntry(name: string, createdAt: string): Record<string, string> {
  return {
    name,
    tokenHash: auth.hashToken(`${name}-fixture`),
    createdAt,
  };
}

function writeAgentConfig(dir: string, bearerTokens: readonly Record<string, string>[]): void {
  agentConfigMod.saveAgentConfig(
    {
      apiVersion: "llamactl/v1",
      kind: "AgentConfig",
      bindHost: "127.0.0.1",
      port: 7843,
      certPath: join(dir, "agent.crt"),
      keyPath: join(dir, "agent.key"),
      tokenHash: auth.hashToken("primary-fixture"),
      fingerprint: `sha256:${"b".repeat(64)}`,
      bearerTokens: [...bearerTokens],
    },
    join(dir, "agent.yaml"),
  );
}

function writeLastUsed(path: string, lastUsed: BearerLastUsedMap): void {
  fs.writeFileSync(path, `${JSON.stringify(lastUsed)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(path, 0o600);
}

function expectOutputClean(entries: readonly Record<string, string>[]): void {
  const output = stdoutBuf + stderrBuf;
  expect(output).not.toContain("ll_agt_");
  expect(output).not.toContain("tokenHash");
  for (const entry of entries) {
    const tokenHash = entry["tokenHash"];
    if (tokenHash !== undefined) expect(output).not.toContain(tokenHash);
  }
}

async function runTokenCommand(
  args: readonly string[],
  entries: readonly Record<string, string>[],
): Promise<number> {
  stdoutBuf = "";
  stderrBuf = "";
  const code = await runAgent([...args]);
  expectOutputClean(entries);
  return code;
}

async function listJson(
  dir: string,
  entries: readonly Record<string, string>[],
): Promise<unknown[]> {
  expect(await runTokenCommand(["token", "list", `--dir=${dir}`, "--json"], entries)).toBe(0);
  return parseJsonArray(stdoutBuf.trim());
}

describe("agent token rename/revoke last-used coherence", () => {
  test("rename carries last use to the new label", async () => {
    capture();
    try {
      const dir = newAgentDir();
      const entries = [bearerEntry("ci", "2026-01-01T00:00:00.000Z")];
      writeAgentConfig(dir, entries);
      const path = join(dir, "bearer-last-used.json");
      writeLastUsed(path, {
        ci: "2026-01-05T00:00:00.000Z",
        default: "2026-01-07T00:00:00.000Z",
      });

      expect(await runTokenCommand(["token", "rename", "ci", "ops", `--dir=${dir}`], entries)).toBe(
        0,
      );
      expect(await listJson(dir, entries)).toEqual([
        {
          name: "ops",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastUsedAt: "2026-01-05T00:00:00.000Z",
        },
      ]);

      const readBearerLastUsed = requireAgentConfigFn<ReadBearerLastUsed>("readBearerLastUsed");
      expect(readBearerLastUsed(path)).toEqual({
        ops: "2026-01-05T00:00:00.000Z",
        default: "2026-01-07T00:00:00.000Z",
      });
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      restore();
    }
  });

  test("rename onto a revoked predecessor's name does not inherit its activity", async () => {
    capture();
    try {
      const dir = newAgentDir();
      const entries = [bearerEntry("ci", "2026-01-01T00:00:00.000Z")];
      writeAgentConfig(dir, entries);
      writeLastUsed(join(dir, "bearer-last-used.json"), {
        ci: "2026-01-05T00:00:00.000Z",
        old: "2026-02-01T00:00:00.000Z",
      });

      expect(await runTokenCommand(["token", "rename", "ci", "old", `--dir=${dir}`], entries)).toBe(
        0,
      );
      expect(await listJson(dir, entries)).toEqual([
        {
          name: "old",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastUsedAt: "2026-01-05T00:00:00.000Z",
        },
      ]);

      const secondDir = newAgentDir();
      const secondEntries = [bearerEntry("idle", "2026-01-01T00:00:00.000Z")];
      writeAgentConfig(secondDir, secondEntries);
      const secondPath = join(secondDir, "bearer-last-used.json");
      writeLastUsed(secondPath, { gone: "2026-02-01T00:00:00.000Z" });

      expect(
        await runTokenCommand(
          ["token", "rename", "idle", "gone", `--dir=${secondDir}`],
          secondEntries,
        ),
      ).toBe(0);
      const rows = await listJson(secondDir, secondEntries);
      expect(rows).toEqual([{ name: "gone", createdAt: "2026-01-01T00:00:00.000Z" }]);
      expect(Object.hasOwn(rows[0] as object, "lastUsedAt")).toBe(false);

      const readBearerLastUsed = requireAgentConfigFn<ReadBearerLastUsed>("readBearerLastUsed");
      expect(readBearerLastUsed(secondPath)["gone"]).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("revoke prunes the revoked and stale labels but keeps the primary", async () => {
    capture();
    try {
      const dir = newAgentDir();
      const entries = [
        bearerEntry("ci", "2026-01-01T00:00:00.000Z"),
        bearerEntry("ops", "2026-01-01T00:00:00.000Z"),
      ];
      writeAgentConfig(dir, entries);
      const path = join(dir, "bearer-last-used.json");
      writeLastUsed(path, {
        ci: "2026-01-05T00:00:00.000Z",
        ops: "2026-01-06T00:00:00.000Z",
        default: "2026-01-07T00:00:00.000Z",
        "stale-x": "2026-01-04T00:00:00.000Z",
      });

      expect(await runTokenCommand(["token", "revoke", "ci", `--dir=${dir}`], entries)).toBe(0);

      const readBearerLastUsed = requireAgentConfigFn<ReadBearerLastUsed>("readBearerLastUsed");
      expect(readBearerLastUsed(path)).toEqual({
        ops: "2026-01-06T00:00:00.000Z",
        default: "2026-01-07T00:00:00.000Z",
      });
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      restore();
    }
  });

  test("revoking a legacy named default prunes named:default but never primary default", async () => {
    capture();
    try {
      const dir = newAgentDir();
      const entries = [
        bearerEntry("default", "2026-01-01T00:00:00.000Z"),
        bearerEntry("ops", "2026-01-01T00:00:00.000Z"),
      ];
      writeAgentConfig(dir, entries);
      const path = join(dir, "bearer-last-used.json");
      writeLastUsed(path, {
        "named:default": "2026-01-05T00:00:00.000Z",
        default: "2026-01-07T00:00:00.000Z",
        ops: "2026-01-06T00:00:00.000Z",
      });

      expect(await runTokenCommand(["token", "revoke", "default", `--dir=${dir}`], entries)).toBe(
        0,
      );

      const readBearerLastUsed = requireAgentConfigFn<ReadBearerLastUsed>("readBearerLastUsed");
      expect(readBearerLastUsed(path)).toEqual({
        default: "2026-01-07T00:00:00.000Z",
        ops: "2026-01-06T00:00:00.000Z",
      });
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      restore();
    }
  });

  test("revoking another token keeps a surviving legacy named default's use", async () => {
    capture();
    try {
      const dir = newAgentDir();
      const entries = [
        bearerEntry("default", "2026-01-01T00:00:00.000Z"),
        bearerEntry("ops", "2026-01-01T00:00:00.000Z"),
      ];
      writeAgentConfig(dir, entries);
      const path = join(dir, "bearer-last-used.json");
      writeLastUsed(path, {
        "named:default": "2026-01-05T00:00:00.000Z",
        default: "2026-01-07T00:00:00.000Z",
        ops: "2026-01-06T00:00:00.000Z",
      });

      expect(await runTokenCommand(["token", "revoke", "ops", `--dir=${dir}`], entries)).toBe(0);

      const readBearerLastUsed = requireAgentConfigFn<ReadBearerLastUsed>("readBearerLastUsed");
      expect(readBearerLastUsed(path)).toEqual({
        "named:default": "2026-01-05T00:00:00.000Z",
        default: "2026-01-07T00:00:00.000Z",
      });
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      restore();
    }
  });

  test("renaming another token keeps a surviving legacy named default's use", async () => {
    capture();
    try {
      const dir = newAgentDir();
      const entries = [
        bearerEntry("default", "2026-01-01T00:00:00.000Z"),
        bearerEntry("ops", "2026-01-01T00:00:00.000Z"),
      ];
      writeAgentConfig(dir, entries);
      const path = join(dir, "bearer-last-used.json");
      writeLastUsed(path, {
        "named:default": "2026-01-05T00:00:00.000Z",
        default: "2026-01-07T00:00:00.000Z",
        ops: "2026-01-06T00:00:00.000Z",
      });

      expect(await runTokenCommand(["token", "rename", "ops", "x", `--dir=${dir}`], entries)).toBe(
        0,
      );

      const readBearerLastUsed = requireAgentConfigFn<ReadBearerLastUsed>("readBearerLastUsed");
      expect(readBearerLastUsed(path)).toEqual({
        "named:default": "2026-01-05T00:00:00.000Z",
        default: "2026-01-07T00:00:00.000Z",
        x: "2026-01-06T00:00:00.000Z",
      });
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      restore();
    }
  });

  test("the running agent recorder preserves CLI renames across flushes", () => {
    capture();
    try {
      const dir = newAgentDir();
      const path = join(dir, "bearer-last-used.json");
      const bearerLastUsedRecorder =
        requireAgentConfigFn<BearerLastUsedRecorderFactory>("bearerLastUsedRecorder");
      const readBearerLastUsed = requireAgentConfigFn<ReadBearerLastUsed>("readBearerLastUsed");
      const t0 = Date.parse("2026-01-02T03:04:05.000Z");
      const iso = (ms: number): string => new Date(ms).toISOString();
      let nowMs = t0;
      const recorder = bearerLastUsedRecorder(path, {
        now: () => nowMs,
        flushIntervalMs: 60_000,
      });

      recorder.record("ci");
      recorder.record("lu");
      writeLastUsed(path, { lu: iso(t0), ops: iso(t0) });

      nowMs = t0 + 1000;
      recorder.record("fresh");
      expect(readBearerLastUsed(path)).toEqual({
        lu: iso(t0),
        ops: iso(t0),
        fresh: iso(t0 + 1000),
      });

      nowMs = t0 + 62_000;
      recorder.record("lu");
      expect(readBearerLastUsed(path)).toEqual({
        lu: iso(t0 + 62_000),
        ops: iso(t0),
        fresh: iso(t0 + 1000),
      });
      expectOutputClean([]);
    } finally {
      restore();
    }
  });

  test("rename and revoke without a last-used file create no file", async () => {
    capture();
    try {
      const renameDir = newAgentDir();
      const renameEntries = [bearerEntry("ci", "2026-01-01T00:00:00.000Z")];
      writeAgentConfig(renameDir, renameEntries);
      expect(
        await runTokenCommand(
          ["token", "rename", "ci", "ops", `--dir=${renameDir}`],
          renameEntries,
        ),
      ).toBe(0);
      expect(fs.existsSync(join(renameDir, "bearer-last-used.json"))).toBe(false);

      const revokeDir = newAgentDir();
      const revokeEntries = [
        bearerEntry("ci", "2026-01-01T00:00:00.000Z"),
        bearerEntry("ops", "2026-01-01T00:00:00.000Z"),
      ];
      writeAgentConfig(revokeDir, revokeEntries);
      expect(
        await runTokenCommand(["token", "revoke", "ci", `--dir=${revokeDir}`], revokeEntries),
      ).toBe(0);
      expect(fs.existsSync(join(revokeDir, "bearer-last-used.json"))).toBe(false);
    } finally {
      restore();
    }
  });
});
