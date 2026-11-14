/**
 * Part of frozename/llamactl#367: CLI wiring for the per-role runtime
 * memory identity added in #577.
 *
 * Every case fails by assertion at the base: parseServeFlags does not know
 * --runtime-role/--memory-budget-bytes, buildServeOptions never sets
 * runtimeRole/runtimeMemoryBudgetBytes, SERVE_USAGE documents neither flag
 * nor env var, resolveServeRuntimeIdentity is not exported, and runServe
 * has no early identity validation. The pin case passes at base and must
 * keep passing: with no flags and an empty env neither option key may
 * appear, preserving the role="agent" no-budget default.
 */
import { agentConfig, type startAgentServer } from "@llamactl/remote";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as agentMod from "../src/commands/agent.js";
import {
  buildServeOptions,
  parseServeFlags,
  runAgent,
  type ServeFlags,
} from "../src/commands/agent.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

type Opts = Parameters<typeof startAgentServer>[0] & {
  runtimeRole?: string;
  runtimeMemoryBudgetBytes?: number;
};
const build = buildServeOptions as unknown as (...a: unknown[]) => Opts;

const dirs: string[] = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const IDENTITY_ENV_KEYS = [
  "LLAMACTL_AGENT_RUNTIME_ROLE",
  "LLAMACTL_AGENT_MEMORY_BUDGET_BYTES",
] as const;
// resolveServeBearers scrubs these from process.env on every serve run (#289);
// save and restore them so a test never eats the developer's real values.
const SCRUBBED_ENV_KEYS = ["LLAMACTL_TUNNEL_BEARER", "LLAMACTL_TUNNEL_CENTRAL_BEARER"] as const;
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
  for (const key of [...IDENTITY_ENV_KEYS, ...SCRUBBED_ENV_KEYS]) {
    savedEnv.set(key, process.env[key]);
  }
});

beforeEach(() => {
  for (const key of IDENTITY_ENV_KEYS) Reflect.deleteProperty(process.env, key);
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const key of [...IDENTITY_ENV_KEYS, ...SCRUBBED_ENV_KEYS]) {
    const prev = savedEnv.get(key);
    if (prev === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = prev;
  }
});

const idleWiring = {
  dialUrl: undefined,
  dialBearer: undefined,
  tunnelCentralOn: false,
  tunnelCentralBearer: undefined,
};

function seedConfig(dir: string, bindHost: string, port: number): agentConfig.AgentConfig {
  const config: agentConfig.AgentConfig = {
    apiVersion: "llamactl/v1",
    kind: "AgentConfig",
    bindHost,
    port,
    certPath: join(dir, "agent.crt"),
    keyPath: join(dir, "agent.key"),
    tokenHash: "a".repeat(64),
    fingerprint: `sha256:${"b".repeat(64)}`,
  };
  agentConfig.saveAgentConfig(config, join(dir, "agent.yaml"));
  return agentConfig.loadAgentConfig(join(dir, "agent.yaml"));
}

function serveFlags(args: string[]): ServeFlags {
  const parsed = parseServeFlags(args);
  expect("error" in parsed).toBe(false);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

async function capture(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array): true => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): true => {
    err += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  try {
    const code = await runAgent(args);
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// Lands with the fix; the cast keeps this file typechecking at the RED base.
type ResolveServeRuntimeIdentity = (
  flags: { dir: string },
  env: Readonly<Record<string, string | undefined>>,
) => { runtimeRole?: string; runtimeMemoryBudgetBytes?: number } | { error: string };

const resolveServeRuntimeIdentity = (
  agentMod as unknown as { resolveServeRuntimeIdentity?: ResolveServeRuntimeIdentity }
).resolveServeRuntimeIdentity;

describe("agent serve runtime memory identity (#367)", () => {
  test("parseServeFlags accepts --runtime-role and --memory-budget-bytes", () => {
    expect(
      parseServeFlags(["--runtime-role=control", "--memory-budget-bytes=536870912"]),
    ).toMatchObject({ runtimeRole: "control", memoryBudgetBytes: 536870912 });
  });

  test("rejects a non-positive-integer budget with a named error", () => {
    for (const v of ["0", "-1", "1.5", "abc", "1e9", "9x", "9007199254740993", ""]) {
      expect(parseServeFlags([`--memory-budget-bytes=${v}`])).toEqual({
        error: `agent serve: invalid --memory-budget-bytes: ${v} (expected a positive integer byte count)`,
      });
    }
  });

  test("rejects a malformed role with a named error", () => {
    for (const v of ["", "Control", "a b", "9x", "x".repeat(33)]) {
      expect(parseServeFlags([`--runtime-role=${v}`])).toEqual({
        error: `agent serve: invalid --runtime-role: ${v} (expected 1-32 characters of a-z, 0-9, _ or -, starting with a letter)`,
      });
    }
  });

  test("buildServeOptions forwards the flags into startAgentServer options", () => {
    const dir = freshDir("serve-mem-flags-");
    const cfg = seedConfig(dir, "127.0.0.1", 7843);
    const parsed = serveFlags([
      `--dir=${dir}`,
      "--runtime-role=control",
      "--memory-budget-bytes=536870912",
    ]);
    const options = build(parsed, cfg, idleWiring, "mem-node", {});
    expect(options.runtimeRole).toBe("control");
    expect(options.runtimeMemoryBudgetBytes).toBe(536870912);
  });

  test("env fallback and flag precedence", () => {
    const dir = freshDir("serve-mem-env-");
    const cfg = seedConfig(dir, "127.0.0.1", 7843);
    const env = {
      LLAMACTL_AGENT_RUNTIME_ROLE: "control",
      LLAMACTL_AGENT_MEMORY_BUDGET_BYTES: "268435456",
    };
    const fromEnv = build(serveFlags([`--dir=${dir}`]), cfg, idleWiring, "mem-node", env);
    expect(fromEnv.runtimeRole).toBe("control");
    expect(fromEnv.runtimeMemoryBudgetBytes).toBe(268435456);

    const fromFlags = build(
      serveFlags([`--dir=${dir}`, "--runtime-role=supervisor", "--memory-budget-bytes=1048576"]),
      cfg,
      idleWiring,
      "mem-node",
      env,
    );
    expect(fromFlags.runtimeRole).toBe("supervisor");
    expect(fromFlags.runtimeMemoryBudgetBytes).toBe(1048576);
  });

  test("resolveServeRuntimeIdentity reports invalid env with a named error", () => {
    const resolve = resolveServeRuntimeIdentity;
    expect(typeof resolve).toBe("function");
    if (resolve === undefined) throw new Error("resolveServeRuntimeIdentity is not exported");
    const dir = freshDir("serve-runtime-identity-");
    expect(resolve({ dir }, { LLAMACTL_AGENT_MEMORY_BUDGET_BYTES: "abc" })).toEqual({
      error:
        "agent serve: invalid LLAMACTL_AGENT_MEMORY_BUDGET_BYTES: abc " +
        "(expected a positive integer byte count)",
    });
    expect(resolve({ dir }, { LLAMACTL_AGENT_RUNTIME_ROLE: "Bad Role" })).toEqual({
      error:
        "agent serve: invalid LLAMACTL_AGENT_RUNTIME_ROLE: Bad Role " +
        "(expected 1-32 characters of a-z, 0-9, _ or -, starting with a letter)",
    });
    expect(
      resolve({ dir }, { LLAMACTL_AGENT_RUNTIME_ROLE: "", LLAMACTL_AGENT_MEMORY_BUDGET_BYTES: "" }),
    ).toEqual({});
  });

  test("agent serve --help documents the flags and env", async () => {
    const r = await capture(["serve", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("--runtime-role=<role>");
    expect(r.out).toContain("--memory-budget-bytes=<n>");
    expect(r.out).toContain("LLAMACTL_AGENT_RUNTIME_ROLE");
    expect(r.out).toContain("LLAMACTL_AGENT_MEMORY_BUDGET_BYTES");
  });

  test("agent serve exits 1 on an invalid budget before touching config", async () => {
    const emptyDir = freshDir("serve-mem-empty-");
    const badFlag = await capture(["serve", `--dir=${emptyDir}`, "--memory-budget-bytes=0"]);
    expect(badFlag.code).toBe(1);
    expect(badFlag.err).toContain("agent serve: invalid --memory-budget-bytes: 0");

    process.env["LLAMACTL_AGENT_MEMORY_BUDGET_BYTES"] = "abc";
    try {
      const badEnv = await capture(["serve", `--dir=${emptyDir}`]);
      expect(badEnv.code).toBe(1);
      expect(badEnv.err).toContain("agent serve: invalid LLAMACTL_AGENT_MEMORY_BUDGET_BYTES: abc");
    } finally {
      Reflect.deleteProperty(process.env, "LLAMACTL_AGENT_MEMORY_BUDGET_BYTES");
    }
  }, 5_000);

  test("pin: no flags and empty env leave both runtime memory keys absent", () => {
    const dir = freshDir("serve-mem-pin-");
    const cfg = seedConfig(dir, "127.0.0.1", 7843);
    const parsed = serveFlags([`--dir=${dir}`]);
    const options = build(parsed, cfg, idleWiring, "mem-node", {});
    expect("runtimeRole" in options).toBe(false);
    expect("runtimeMemoryBudgetBytes" in options).toBe(false);
    const ambient = build(parsed, cfg, idleWiring, "mem-node");
    expect("runtimeRole" in ambient).toBe(false);
    expect("runtimeMemoryBudgetBytes" in ambient).toBe(false);
  });
});
