// #278 (DF-05): end-to-end audit persistence — an opt-in agent wires the
// lease registry's onAudit sink to the node-local residency store, closes
// the sink on stop() so late writes cannot persist, and a restarted agent
// reports the persisted entries through residencyStatus. At the pinned
// base serve.ts never creates the sink and the store module lacks
// readResidencyLeaseAudit, so the case fails by assertion on the typeof
// probe. Agents are real startAgentServer instances on loopback; no fake
// engine is needed because the registry is driven directly.
import {
  getResidencyLeaseRegistry,
  type ResidencyAuditEntry,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { envForTemp, makeTempRuntime } from "../../../core/test/helpers.js";
import { router } from "../../src/router.js";
import { existsSync } from "../../src/safe-fs.js";
import { generateToken } from "../../src/server/auth.js";
import { type RunningAgent, startAgentServer } from "../../src/server/serve.js";

const STORE_MODULE = "../../src/residency/store.js";

type AuditStoreModule = {
  readResidencyLeaseAudit: (path: string) => ResidencyAuditEntry[];
};

type LeaseAuditRow = {
  workload: string;
  epoch: number;
  forced: true;
  revokedCount: number;
  reason: string | null;
};

type LeasesSection =
  | { status: "unavailable"; scope: "serving-process" }
  | {
      status: "available";
      scope: "serving-process";
      workloads: {
        workload: string;
        phase: "open" | "draining" | "unloaded";
        epoch: number;
        activeLeaseCount: number;
        waiters: number;
      }[];
      auditCount: number;
      recentAudit: LeaseAuditRow[];
    };

type AvailableLeases = Extract<LeasesSection, { status: "available" }>;

const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMACTL_CONFIG",
  "LLAMACTL_RESIDENCY_LEASES",
  "LLAMACTL_RESIDENCY_STORE",
  "LLAMACTL_WORKLOADS_DIR",
] as const;

let temp: ReturnType<typeof makeTempRuntime>;
let auditStorePath = "";
const envBackup: Record<string, string | undefined> = {};
const agents: RunningAgent[] = [];

type ServeOpts = Parameters<typeof startAgentServer>[0] & { residencyLeases?: boolean };

function startAgent(flag: boolean): RunningAgent {
  const options: ServeOpts = {
    bindHost: "127.0.0.1",
    port: 0,
    tokenHash: generateToken().hash,
    advertiseMdns: false,
    ...(flag ? { residencyLeases: true } : {}),
  };
  const agent = startAgentServer(options);
  agents.push(agent);
  return agent;
}

async function stopAgent(agent: RunningAgent): Promise<void> {
  agents.splice(agents.indexOf(agent), 1);
  await agent.stop();
}

async function loadAuditReader(): Promise<AuditStoreModule | null> {
  try {
    const mod: unknown = await import(STORE_MODULE);
    return mod as AuditStoreModule;
  } catch {
    return null;
  }
}

async function leasesStatus(): Promise<LeasesSection> {
  const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
    .procedures;
  expect(Object.keys(procs)).toContain("residencyStatus");
  const caller = router.createCaller({}) as unknown as {
    residencyStatus: (input: { node: string }) => Promise<{ leases: LeasesSection }>;
  };
  const r = await caller.residencyStatus({ node: "local" });
  return r.leases;
}

function expectAvailable(leases: LeasesSection): AvailableLeases {
  expect(leases.status).toBe("available");
  if (leases.status !== "available") {
    throw new Error("expected an available leases section");
  }
  return leases;
}

beforeAll(() => {
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
  temp = makeTempRuntime();
  const tempEnv = envForTemp(temp);
  process.env["DEV_STORAGE"] = tempEnv["DEV_STORAGE"];
  process.env["LOCAL_AI_RUNTIME_DIR"] = tempEnv["LOCAL_AI_RUNTIME_DIR"];
  process.env["LLAMACTL_CONFIG"] = join(temp.devStorage, "llamactl-config.json");
  auditStorePath = join(temp.devStorage, "residency-audit", "operations.sqlite");
  process.env["LLAMACTL_RESIDENCY_STORE"] = auditStorePath;
  process.env["LLAMACTL_WORKLOADS_DIR"] = join(temp.runtimeDir, "workloads");
  Reflect.deleteProperty(process.env, "LLAMACTL_RESIDENCY_LEASES");
});

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
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
    setResidencyLeaseRegistry(null);
  }
});

describe("#278 DF-05: the opt-in agent persists the forced-unload audit", () => {
  test("the opt-in agent persists forced-unload audit and a restarted agent reports it", async () => {
    const off = startAgent(false);
    await stopAgent(off);
    expect(existsSync(auditStorePath)).toBe(false);

    const agentA = startAgent(true);
    expect(existsSync(auditStorePath)).toBe(false);
    const published = getResidencyLeaseRegistry();
    expect(published).not.toBeNull();
    const regA = published!;

    const leaseA = regA.acquire("wl-a");
    expect(leaseA.ok).toBe(true);
    const drainA = regA.beginDrain("wl-a");
    if (!drainA.ok) {
      throw new Error(`beginDrain(wl-a) refused: ${drainA.reason}`);
    }
    expect(regA.commitUnload(drainA.token, { force: true, reason: "op-a" })).toEqual({
      ok: true,
      revoked: ["wl-a#1"],
    });

    const mod = await loadAuditReader();
    expect(typeof mod?.readResidencyLeaseAudit).toBe("function");
    const readAudit = mod!.readResidencyLeaseAudit;
    expect(readAudit(auditStorePath)).toEqual([
      { workload: "wl-a", epoch: 1, forced: true, revoked: ["wl-a#1"], reason: "op-a" },
    ]);

    await stopAgent(agentA);
    const lateLease = regA.acquire("wl-late");
    expect(lateLease.ok).toBe(true);
    const lateDrain = regA.beginDrain("wl-late");
    if (!lateDrain.ok) {
      throw new Error(`beginDrain(wl-late) refused: ${lateDrain.reason}`);
    }
    expect(regA.commitUnload(lateDrain.token, { force: true })).toEqual({
      ok: true,
      revoked: ["wl-late#1"],
    });
    expect(regA.audit()).toHaveLength(2);
    expect(readAudit(auditStorePath)).toHaveLength(1);

    startAgent(true);
    const leases = expectAvailable(await leasesStatus());
    expect(leases.auditCount).toBe(1);
    expect(leases.recentAudit).toEqual([
      { workload: "wl-a", epoch: 1, forced: true, revokedCount: 1, reason: "op-a" },
    ]);
  }, 15_000);
});
