/**
 * #520: active-session refcounts published on top of the DF-05 request
 * leases (#278). The RED cases fail by assertion at 27a250bd:
 * `startAgentServer` has no `residencySessionIdleMs` option and never
 * writes the session seam, so `currentSessionRefcounts()` stays null
 * where the fix installs one registry beside the lease registry and
 * restores the seam's previous value on stop. Agents are real
 * `startAgentServer` instances on loopback with port 0, no TLS and
 * advertiseMdns:false; the opt-in reaches the options only through
 * conditional spreads on a widened ServeOpts, so the file typechecks
 * at base.
 */
import {
  getResidencyLeaseRegistry,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import {
  createSessionRefcounts,
  currentSessionRefcounts,
  setSessionRefcountRegistry,
} from "@llamactl/core/residency/sessions";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { envForTemp, makeTempRuntime } from "../../../core/test/helpers.js";
import { generateToken } from "../../src/server/auth.js";
import { type RunningAgent, startAgentServer } from "../../src/server/serve.js";

const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMACTL_CONFIG",
  "LLAMACTL_RESIDENCY_LEASES",
  "LLAMACTL_RESIDENCY_SESSION_IDLE_MS",
] as const;

let temp: ReturnType<typeof makeTempRuntime>;
const envBackup: Record<string, string | undefined> = {};
const agents: RunningAgent[] = [];

type ServeOpts = Parameters<typeof startAgentServer>[0] & {
  residencyLeases?: boolean;
  residencySessionIdleMs?: number;
};

function startAgent(
  opts: { residencyLeases?: boolean; residencySessionIdleMs?: number } = {},
): RunningAgent {
  const options: ServeOpts = {
    bindHost: "127.0.0.1",
    port: 0,
    tokenHash: generateToken().hash,
    advertiseMdns: false,
    ...(opts.residencyLeases === true ? { residencyLeases: true } : {}),
    ...(opts.residencySessionIdleMs !== undefined
      ? { residencySessionIdleMs: opts.residencySessionIdleMs }
      : {}),
  };
  const agent = startAgentServer(options);
  agents.push(agent);
  return agent;
}

beforeAll(() => {
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
  temp = makeTempRuntime();
  const tempEnv = envForTemp(temp);
  process.env["DEV_STORAGE"] = tempEnv["DEV_STORAGE"];
  process.env["LOCAL_AI_RUNTIME_DIR"] = tempEnv["LOCAL_AI_RUNTIME_DIR"];
  process.env["LLAMACTL_CONFIG"] = join(temp.devStorage, "llamactl-config.json");
  // #520: both flags are saved above and deleted here so no case inherits a
  // developer's live setting; afterAll restores them.
  Reflect.deleteProperty(process.env, "LLAMACTL_RESIDENCY_LEASES");
  Reflect.deleteProperty(process.env, "LLAMACTL_RESIDENCY_SESSION_IDLE_MS");
});

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
  setSessionRefcountRegistry(null);
  setResidencyLeaseRegistry(null);
});

afterAll(() => {
  try {
    temp.cleanup();
  } finally {
    for (const key of ENV_KEYS) {
      const prev = envBackup[key];
      if (prev === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = prev;
    }
    setSessionRefcountRegistry(null);
    setResidencyLeaseRegistry(null);
  }
});

describe("#520: agent serve publishes a session-refcount registry beside the DF-05 leases", () => {
  test("#520: leases + idle publishes one session registry at start and restores null on stop", async () => {
    const agent = startAgent({ residencyLeases: true, residencySessionIdleMs: 60_000 });
    const reg = currentSessionRefcounts();
    expect(reg).not.toBeNull();
    expect(reg!.acquire("s1", "wl-a").ok).toBe(true);
    expect(reg!.checkUnload("wl-a")).toEqual({
      ok: false,
      reason: "SessionActive",
      sessions: ["s1"],
    });
    await agent.stop();
    expect(currentSessionRefcounts()).toBeNull();
  });

  test("#520: the configured idle timeout reaches the registry", async () => {
    const agent = startAgent({ residencyLeases: true, residencySessionIdleMs: 1 });
    const fast = currentSessionRefcounts();
    expect(fast).not.toBeNull();
    const fastAcquire = fast!.acquire("s1", "wl-a");
    if (!fastAcquire.ok) throw new Error("acquire refused");
    fast!.release("s1", fastAcquire.generation);
    await Bun.sleep(20);
    expect(fast!.checkUnload("wl-a")).toEqual({ ok: true, released: [] });

    agents.splice(agents.indexOf(agent), 1);
    await agent.stop();

    startAgent({ residencyLeases: true, residencySessionIdleMs: 60_000 });
    const slow = currentSessionRefcounts();
    expect(slow).not.toBeNull();
    const slowAcquire = slow!.acquire("s1", "wl-a");
    if (!slowAcquire.ok) throw new Error("acquire refused");
    slow!.release("s1", slowAcquire.generation);
    expect(slow!.checkUnload("wl-a")).toEqual({
      ok: false,
      reason: "SessionActive",
      sessions: ["s1"],
    });
  });

  test("#520: sessions need the lease opt-in, and stop restores a pre-installed sentinel", async () => {
    const idleOnly = startAgent({ residencySessionIdleMs: 60_000 });
    expect(currentSessionRefcounts()).toBeNull();
    await idleOnly.stop();

    const sentinel = createSessionRefcounts({ idleTimeoutMs: 1000 });
    setSessionRefcountRegistry(sentinel);
    const agent = startAgent({ residencyLeases: true, residencySessionIdleMs: 60_000 });
    const published = currentSessionRefcounts();
    expect(published).not.toBeNull();
    expect(published).not.toBe(sentinel);
    await agent.stop();
    expect(currentSessionRefcounts()).toBe(sentinel);
  });

  test("#520: leases without an idle timeout never write the session seam", async () => {
    // Installed before start: a publish that writes the seam replaces it.
    const sentinel = createSessionRefcounts({ idleTimeoutMs: 1000 });
    setSessionRefcountRegistry(sentinel);
    const first = startAgent({ residencyLeases: true });
    expect(currentSessionRefcounts()).toBe(sentinel);
    agents.splice(agents.indexOf(first), 1);
    await first.stop();
    expect(currentSessionRefcounts()).toBe(sentinel);

    // Installed while running over a null seam: a restore that writes the
    // seam puts the null captured at start back.
    setSessionRefcountRegistry(null);
    const second = startAgent({ residencyLeases: true });
    expect(currentSessionRefcounts()).toBeNull();
    setSessionRefcountRegistry(sentinel);
    expect(currentSessionRefcounts()).toBe(sentinel);
    agents.splice(agents.indexOf(second), 1);
    await second.stop();
    expect(currentSessionRefcounts()).toBe(sentinel);
  });

  test("#520: an invalid idle timeout throws before binding and leaves both seams untouched", () => {
    expect(currentSessionRefcounts()).toBeNull();
    expect(getResidencyLeaseRegistry()).toBeNull();
    const badOptions: ServeOpts = {
      bindHost: "127.0.0.1",
      port: 0,
      tokenHash: generateToken().hash,
      advertiseMdns: false,
      residencyLeases: true,
      residencySessionIdleMs: 0,
    };
    // The agent is pushed only if the call returns, so a base run that
    // ignores the option still leaves nothing for afterEach to miss.
    const badAttempt = (): RunningAgent => {
      const agent = startAgentServer(badOptions);
      agents.push(agent);
      return agent;
    };
    expect(badAttempt).toThrow("idleTimeoutMs must be a positive finite number");
    expect(currentSessionRefcounts()).toBeNull();
    expect(getResidencyLeaseRegistry()).toBeNull();

    const tlsOptions: ServeOpts = {
      bindHost: "127.0.0.1",
      port: 0,
      tokenHash: generateToken().hash,
      advertiseMdns: false,
      tls: {
        certPath: join(temp.runtimeDir, "missing-agent.crt"),
        keyPath: join(temp.runtimeDir, "missing-agent.key"),
      },
      residencyLeases: true,
      residencySessionIdleMs: 60_000,
    };
    expect(() => startAgentServer(tlsOptions)).toThrow("cert not found");
    expect(currentSessionRefcounts()).toBeNull();
  });
});
