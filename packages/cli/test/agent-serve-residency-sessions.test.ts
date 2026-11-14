/**
 * #520: LLAMACTL_RESIDENCY_SESSION_IDLE_MS -> options.residencySessionIdleMs.
 *
 * The RED cases fail by assertion at 27a250bd: `buildServeOptions` never
 * reads the variable, so `residencySessionIdleMs` stays undefined where the
 * fix maps a positive integer onto it. The unset and invalid pins pass at
 * base and must keep passing: unset, non-positive, non-integer and
 * non-numeric strings must never add the key.
 */
import { currentSessionRefcounts } from "@llamactl/core/residency/sessions";
import { agentConfig, type RunningAgent, startAgentServer } from "@llamactl/remote";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildServeOptions, parseServeFlags, type ServeFlags } from "../src/commands/agent.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

type Opts = Parameters<typeof startAgentServer>[0] & {
  residencyLeases?: boolean;
  residencySessionIdleMs?: number;
};
const build = buildServeOptions as unknown as (...a: unknown[]) => Opts;

const dirs: string[] = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const ENV_KEYS = [
  "LLAMACTL_RESIDENCY_LEASES",
  "LLAMACTL_RESIDENCY_SESSION_IDLE_MS",
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMACTL_CONFIG",
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    Reflect.deleteProperty(process.env, key);
  }
  // The live-agent case starts a real server; keep its state off the host.
  const state = freshDir("serve-session-idle-state-");
  process.env["DEV_STORAGE"] = state;
  process.env["LOCAL_AI_RUNTIME_DIR"] = join(state, "runtime");
  process.env["LLAMACTL_CONFIG"] = join(state, "llamactl-config.json");
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
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
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

describe("agent serve LLAMACTL_RESIDENCY_SESSION_IDLE_MS (#520)", () => {
  test("#520: LLAMACTL_RESIDENCY_SESSION_IDLE_MS maps a positive integer onto options.residencySessionIdleMs", () => {
    const dir = freshDir("serve-session-idle-");
    const cfg = seedConfig(dir, "127.0.0.1", 7843);
    const parsed = serveFlags([`--dir=${dir}`]);
    const env = { LLAMACTL_RESIDENCY_LEASES: "1" };
    const sixty = build(parsed, cfg, idleWiring, "n", {
      ...env,
      LLAMACTL_RESIDENCY_SESSION_IDLE_MS: "60000",
    });
    expect(sixty.residencySessionIdleMs).toBe(60000);
    const one = build(parsed, cfg, idleWiring, "n", {
      ...env,
      LLAMACTL_RESIDENCY_SESSION_IDLE_MS: "1",
    });
    expect(one.residencySessionIdleMs).toBe(1);
    for (const raw of ["0", "-5", "1.5", "abc", "", " 60000", "1e3", "60000ms"]) {
      const options = build(parsed, cfg, idleWiring, "n", {
        ...env,
        LLAMACTL_RESIDENCY_SESSION_IDLE_MS: raw,
      });
      expect("residencySessionIdleMs" in options).toBe(false);
    }
  });

  test("#520: unset leaves the option keys unchanged", () => {
    const dir = freshDir("serve-session-idle-unset-");
    const cfg = seedConfig(dir, "127.0.0.1", 7843);
    const parsed = serveFlags([`--dir=${dir}`]);
    // beforeAll cleared both keys, so the four-argument call is the baseline.
    const baselineKeys = Object.keys(build(parsed, cfg, idleWiring, "n")).sort();
    const idleUnset = build(parsed, cfg, idleWiring, "n", { LLAMACTL_RESIDENCY_LEASES: "1" });
    expect(Object.keys(idleUnset).sort()).toEqual([...baselineKeys, "residencyLeases"].sort());
    expect("residencySessionIdleMs" in idleUnset).toBe(false);
    const idleSet = build(parsed, cfg, idleWiring, "n", {
      LLAMACTL_RESIDENCY_LEASES: "1",
      LLAMACTL_RESIDENCY_SESSION_IDLE_MS: "250",
    });
    expect(idleSet.residencySessionIdleMs).toBe(250);
  });
});

describe("agent serve LLAMACTL_RESIDENCY_SESSION_IDLE_MS reaches the registry (#520)", () => {
  // The env value is milliseconds and must reach createSessionRefcounts
  // unchanged. Each case starts a real loopback agent from the options
  // buildServeOptions derived, then times an idle released session against
  // the installed registry: a seconds reading (x1000) or a ms-to-seconds
  // conversion (/1000) lands on the wrong side of one of the two sleeps.
  function startFromEnv(raw: string): RunningAgent {
    const dir = freshDir("serve-session-idle-live-");
    const cfg = seedConfig(dir, "127.0.0.1", 7843);
    const built = build(serveFlags([`--dir=${dir}`]), cfg, idleWiring, "n", {
      LLAMACTL_RESIDENCY_LEASES: "1",
      LLAMACTL_RESIDENCY_SESSION_IDLE_MS: raw,
    });
    expect(built.residencySessionIdleMs).toBe(Number(raw));
    const options: Opts = {
      bindHost: "127.0.0.1",
      port: 0,
      tokenHash: built.tokenHash,
      advertiseMdns: false,
      ...(built.residencyLeases === true ? { residencyLeases: true } : {}),
      ...(built.residencySessionIdleMs !== undefined
        ? { residencySessionIdleMs: built.residencySessionIdleMs }
        : {}),
    };
    return startAgentServer(options);
  }

  async function idleCheckAfter(raw: string, sleepMs: number): Promise<unknown> {
    const agent = startFromEnv(raw);
    try {
      const reg = currentSessionRefcounts();
      if (reg === null) throw new Error("no session registry installed");
      const acquired = reg.acquire("s1", "wl-a");
      if (!acquired.ok) throw new Error("acquire refused");
      reg.release("s1", acquired.generation);
      await Bun.sleep(sleepMs);
      return reg.checkUnload("wl-a");
    } finally {
      await agent.stop();
    }
  }

  test("#520: 60000 keeps an idle session held past 150 ms", async () => {
    expect(await idleCheckAfter("60000", 150)).toEqual({
      ok: false,
      reason: "SessionActive",
      sessions: ["s1"],
    });
    expect(currentSessionRefcounts()).toBeNull();
  });

  test("#520: 20 lets an idle session expire within 200 ms", async () => {
    expect(await idleCheckAfter("20", 200)).toEqual({ ok: true, released: [] });
    expect(currentSessionRefcounts()).toBeNull();
  });
});
