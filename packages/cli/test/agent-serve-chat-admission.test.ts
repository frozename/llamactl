/**
 * #281 DF-08 — `agent serve` maps LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS
 * and LLAMACTL_CHAT_ADMISSION_MAX_QUEUED onto
 * options.chatCompletionsAdmission. RED at base: buildServeOptions never
 * sets the key, so the defined/acquire assertions fail; the inert pins
 * (env unset, or a non-positive-integer MAX_EXECUTIONS) pass at base and
 * must keep passing.
 */
import { agentConfig, type startAgentServer } from "@llamactl/remote";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildServeOptions, parseServeFlags, type ServeFlags } from "../src/commands/agent.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

type ChatAdmission = {
  acquire: (...args: unknown[]) => Promise<() => void>;
  snapshot: () => { executing: number; queued: number };
};

type Opts = Parameters<typeof startAgentServer>[0] & {
  chatCompletionsAdmission?: ChatAdmission;
};
const build = buildServeOptions as unknown as (...a: unknown[]) => Opts;

const dirs: string[] = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const ENV_KEYS = [
  "LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS",
  "LLAMACTL_CHAT_ADMISSION_MAX_QUEUED",
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    Reflect.deleteProperty(process.env, key);
  }
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const prev = savedEnv.get(key);
    if (prev === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = prev;
  }
});

/** Poll `pred` every 10ms until it holds or the deadline passes. */
async function waitFor(pred: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(10);
  }
}

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
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

function admRequest(id: string): Record<string, unknown> {
  return {
    requestId: id,
    principal: "agent",
    priority: "interactive",
    model: { name: "chat-completions", revision: "agent" },
    bytes: 0,
    promptTokens: 0,
    maxCompletionTokens: 0,
  };
}

describe("agent serve chat-completions admission env (#281)", () => {
  // Kills: the env ignored, or maxExecutions not taken from it.
  test("(c1) LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS builds a working admission", async () => {
    const dir = freshDir("serve-chat-admission-");
    const cfg = seedConfig(dir, "127.0.0.1", 7843);
    const parsed = serveFlags([`--dir=${dir}`]);
    const options = build(parsed, cfg, idleWiring, "n", {
      LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS: "1",
    });
    expect(options.chatCompletionsAdmission).toBeDefined();
    const adm = options.chatCompletionsAdmission!;

    const relA = await adm.acquire(admRequest("a"), {});
    expect(await waitFor(() => adm.snapshot().executing === 1)).toBe(true);
    const pendingB = adm.acquire(admRequest("b"), {});
    void pendingB.catch(() => undefined);
    expect(await waitFor(() => adm.snapshot().queued === 1)).toBe(true);
    relA();
    const relB = await pendingB;
    relB();
  }, 10_000);

  // Kills: MAX_QUEUED ignored; the per-principal cap binding first.
  test("(c2) LLAMACTL_CHAT_ADMISSION_MAX_QUEUED adds the queue cap; a third acquire is QueueFull", async () => {
    const dir = freshDir("serve-chat-admission-q-");
    const cfg = seedConfig(dir, "127.0.0.1", 7843);
    const parsed = serveFlags([`--dir=${dir}`]);
    const options = build(parsed, cfg, idleWiring, "n", {
      LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS: "1",
      LLAMACTL_CHAT_ADMISSION_MAX_QUEUED: "1",
    });
    expect(options.chatCompletionsAdmission).toBeDefined();
    const adm = options.chatCompletionsAdmission!;

    const relA = await adm.acquire(admRequest("a"), {});
    expect(await waitFor(() => adm.snapshot().executing === 1)).toBe(true);
    const pendingB = adm.acquire(admRequest("b"), {});
    void pendingB.catch(() => undefined);
    expect(await waitFor(() => adm.snapshot().queued === 1)).toBe(true);
    const err = await adm.acquire(admRequest("c"), {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { code?: unknown }).code).toBe("QueueFull");
    relA();
    const relB = await pendingB;
    relB();
  }, 10_000);

  // Passes at base: unset env or a non-positive-integer MAX_EXECUTIONS
  // must never add the key.
  test("(e) pin: unset or invalid caps never add chatCompletionsAdmission", () => {
    const dir = freshDir("serve-chat-admission-off-");
    const cfg = seedConfig(dir, "127.0.0.1", 7843);
    const parsed = serveFlags([`--dir=${dir}`]);
    // The four-argument call reads process.env, which beforeAll cleared.
    const baselineKeys = Object.keys(build(parsed, cfg, idleWiring, "n")).sort();
    const envs: Record<string, string | undefined>[] = [
      {},
      { LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS: "" },
      { LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS: "0" },
      { LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS: "-1" },
      { LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS: "abc" },
      { LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS: "1.5" },
    ];
    for (const env of envs) {
      const options = build(parsed, cfg, idleWiring, "n", env);
      expect("chatCompletionsAdmission" in options).toBe(false);
      expect(Object.keys(options).sort()).toEqual(baselineKeys);
    }
  });
});
