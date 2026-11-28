/**
 * #218 — surface persisted bearer last use in `agent token list` and
 * wire the agent server's recorder beside agent.yaml. The fixtures write
 * agent.yaml directly: no cert generation, no openssl and no live agent
 * state. Neither output nor failure text may carry a token or a hash.
 */
import { agentConfig as agentConfigMod, auth } from "@llamactl/remote";
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildServeOptions, parseServeFlags, runAgent } from "../src/commands/agent.js";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "../src/safe-fs.js";
import { parseJsonArray } from "./helpers.js";

type BearerLastUsedMap = Record<string, string>;
type ReadBearerLastUsed = (path: string) => BearerLastUsedMap;

interface BearerLastUsedRecorder {
  record: (label: string) => void;
  snapshot: () => BearerLastUsedMap;
}

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
  const dir = mkdtempSync(join(tmpdir(), "agent-token-last-used-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

function bearerEntry(name: string, createdAt: string, expiresAt?: string): Record<string, string> {
  return {
    name,
    tokenHash: auth.hashToken(`${name}-fixture`),
    createdAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
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

describe("agent token last-used", () => {
  test("token list shows lastUsed from bearer-last-used.json, skipping a record older than the entry", async () => {
    capture();
    try {
      const dir = newAgentDir();
      const live = new Date(Date.now() + 365 * 86_400_000).toISOString();
      const entries = [
        bearerEntry("ci", "2026-01-01T00:00:00.000Z"),
        bearerEntry("reused", "2026-03-01T00:00:00.000Z"),
        bearerEntry("idle", "2026-01-01T00:00:00.000Z"),
        bearerEntry("rotated-1", "2026-02-02T00:00:00.000Z", live),
        bearerEntry("default", "2026-01-01T00:00:00.000Z"),
      ];
      writeAgentConfig(dir, entries);
      const lastUsedPath = join(dir, "bearer-last-used.json");
      writeFileSync(
        lastUsedPath,
        JSON.stringify({
          ci: "2026-01-05T00:00:00.000Z",
          reused: "2026-02-01T00:00:00.000Z",
          "rotated-1": "2026-02-03T00:00:00.000Z",
          "named:default": "2026-01-06T00:00:00.000Z",
          default: "2026-01-07T00:00:00.000Z",
        }),
        "utf8",
      );

      expect(await runAgent(["token", "list", `--dir=${dir}`])).toBe(0);
      expect(stdoutBuf.trimEnd().split("\n")).toEqual([
        "ci\t2026-01-01T00:00:00.000Z\tlastUsed=2026-01-05T00:00:00.000Z",
        "reused\t2026-03-01T00:00:00.000Z",
        "idle\t2026-01-01T00:00:00.000Z",
        `rotated-1\t2026-02-02T00:00:00.000Z\texpires=${live}\tlastUsed=2026-02-03T00:00:00.000Z`,
        "default\t2026-01-01T00:00:00.000Z\tlastUsed=2026-01-06T00:00:00.000Z",
      ]);
      let printedStdout = stdoutBuf;

      stdoutBuf = "";
      expect(await runAgent(["token", "list", `--dir=${dir}`, "--json"])).toBe(0);
      expect(parseJsonArray(stdoutBuf.trim())).toEqual([
        {
          name: "ci",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastUsedAt: "2026-01-05T00:00:00.000Z",
        },
        { name: "reused", createdAt: "2026-03-01T00:00:00.000Z" },
        { name: "idle", createdAt: "2026-01-01T00:00:00.000Z" },
        {
          name: "rotated-1",
          createdAt: "2026-02-02T00:00:00.000Z",
          expiresAt: live,
          expired: false,
          lastUsedAt: "2026-02-03T00:00:00.000Z",
        },
        {
          name: "default",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastUsedAt: "2026-01-06T00:00:00.000Z",
        },
      ]);
      printedStdout += stdoutBuf;

      const output = printedStdout + stderrBuf;
      expect(output).not.toContain("tokenHash");
      expect(output).not.toContain("ll_agt_");
      for (const entry of entries) {
        expect(output).not.toContain(entry["tokenHash"]!);
      }

      writeFileSync(lastUsedPath, "{not json", "utf8");
      stdoutBuf = "";
      stderrBuf = "";
      expect(await runAgent(["token", "list", `--dir=${dir}`])).toBe(0);
      expect(stdoutBuf.split("\n")[0]).toBe("ci\t2026-01-01T00:00:00.000Z");
    } finally {
      restore();
    }
  });

  test("buildServeOptions wires a bearerLastUsed recorder at the agent dir", () => {
    capture();
    try {
      const dir = newAgentDir();
      writeAgentConfig(dir, [bearerEntry("ci", "2026-01-01T00:00:00.000Z")]);
      const flags = parseServeFlags([`--dir=${dir}`]);
      if ("error" in flags) throw new Error(flags.error);
      const options = buildServeOptions(
        flags,
        agentConfigMod.loadAgentConfig(join(dir, "agent.yaml")),
        {
          dialUrl: undefined,
          dialBearer: undefined,
          tunnelCentralOn: false,
          tunnelCentralBearer: undefined,
        },
        "n",
        {},
      );

      const bearerLastUsed = (options as unknown as Record<string, unknown>)["bearerLastUsed"];
      expect(bearerLastUsed).toBeDefined();
      (bearerLastUsed as BearerLastUsedRecorder).record("ci");

      const readBearerLastUsed = requireAgentConfigFn<ReadBearerLastUsed>("readBearerLastUsed");
      const used = readBearerLastUsed(join(dir, "bearer-last-used.json"))["ci"];
      expect(typeof used).toBe("string");
      expect(Number.isFinite(Date.parse(used!))).toBe(true);
      expect(statSync(join(dir, "bearer-last-used.json")).mode & 0o777).toBe(0o600);
    } finally {
      restore();
    }
  });
});
