// launchd reports a freshly bootstrapped job as `state = xpcproxy` (the spawn
// trampoline) for a moment before `state = running`. `llamactl update` must
// wait that window out instead of declaring the unit inactive (#268).
import { describe, expect, test } from "bun:test";

import type { ExecResult } from "../src/commands/update/deps.js";

import { runUpdate } from "../src/commands/update/index.js";
import {
  DEFAULT_TIMEOUTS,
  type DeployContext,
  ensureControllerRunning,
} from "../src/commands/update/procedure.js";
import { makeServiceManager } from "../src/commands/update/services.js";
import {
  AGENT_DIR,
  BUN,
  CONTROLLER_LOG,
  ENTRY,
  fakeDeps,
  fakeExec,
  type FakeUnit,
  makeWorld,
  REPO,
  sha,
  type World,
} from "./update-fakes.js";

interface Report {
  result: string;
  refusals: string[];
  steps: { step: string; ok: boolean; detail: string }[];
  rollbackSteps: { step: string; ok: boolean; detail: string }[];
  finalStart: { step: string; ok: boolean; detail: string } | null;
  error: string | null;
}

async function run(w: World, args: string[]): Promise<{ code: number; report: Report }> {
  const { deps, out } = fakeDeps(w);
  const code = await runUpdate([...args, "--json"], deps);
  return { code, report: JSON.parse(out.stdout) as Report };
}

const CONTROLLER = "com.llamactl.controller";
const AGENT = "com.llamactl.agent";
const plist = (label: string): string => `/Users/u/Library/LaunchAgents/${label}.plist`;

function unit(over: Partial<FakeUnit>): FakeUnit {
  return {
    loaded: true,
    active: true,
    pid: 501,
    argv: [],
    killMode: "process",
    cgroup: "",
    standardOutput: null,
    environmentFile: null,
    plistPath: null,
    ...over,
  };
}

function spawnWorld(over: { controller?: Partial<FakeUnit>; agent?: Partial<FakeUnit> }): World {
  return makeWorld({
    platform: "darwin",
    units: new Map([
      [
        CONTROLLER,
        unit({
          argv: [BUN, ENTRY, "controller", "serve"],
          standardOutput: CONTROLLER_LOG,
          plistPath: plist(CONTROLLER),
          ...over.controller,
        }),
      ],
      [
        AGENT,
        unit({
          pid: 502,
          argv: [BUN, ENTRY, "agent", "serve", `--dir=${AGENT_DIR}`],
          plistPath: plist(AGENT),
          ...over.agent,
        }),
      ],
    ]),
  });
}

describe("launchd spawn window", () => {
  test("a job that spends two prints in xpcproxy after each start still applies", async () => {
    const w = spawnWorld({ controller: { spawnPrints: 2 }, agent: { spawnPrints: 2 } });
    const { code, report } = await run(w, ["--apply"]);
    expect(code).toBe(0);
    expect(report.result).toBe("applied");
    const details = [...report.steps, ...report.rollbackSteps].map((s) => s.detail);
    expect(details.filter((d) => d.includes("is not active"))).toEqual([]);
    expect(w.events).toEqual([
      "bootout com.llamactl.controller",
      `switch -C main ${sha(4)}`,
      `install ${BUN} install --frozen-lockfile --ignore-scripts`,
      "bootstrap com.llamactl.controller",
      "kickstart com.llamactl.agent",
    ]);
  });

  test("a job that never leaves xpcproxy fails with its last state", async () => {
    const w = spawnWorld({ controller: { spawnPrints: Number.POSITIVE_INFINITY } });
    const { code, report } = await run(w, ["--apply"]);
    expect(code).toBe(1);
    const step = report.steps.find((s) => s.step === "await-controller");
    expect(step?.ok).toBe(false);
    expect(step?.detail).toContain("is not active after");
    expect(step?.detail).toContain("xpcproxy");
    expect(report.error).toContain("is not active after");
  });

  test("a rollback still succeeds through the same spawn window", async () => {
    let restarts = 0;
    const w = spawnWorld({ controller: { spawnPrints: 2 }, agent: { spawnPrints: 2 } });
    w.onAgentRestart = (world): void => {
      restarts += 1;
      world.agentHealthy = restarts > 1;
    };
    const { code, report } = await run(w, ["--apply"]);
    expect(code).toBe(1);
    expect(report.result).toBe("failed");
    expect(report.steps.at(-1)).toMatchObject({ step: "restart-agent", ok: false });
    expect(report.rollbackSteps.every((s) => s.ok)).toBe(true);
    expect(report.error).not.toContain("unhealthy");
  });

  test("ensureControllerRunning waits out an xpcproxy spawn instead of bootstrapping again", async () => {
    const w = spawnWorld({});
    const { deps } = fakeDeps(w);
    const manager = makeServiceManager("launchd", fakeExec(w), () => null, 501, {});
    const controller = await manager.describe("controller", CONTROLLER, false);
    const agent = await manager.describe("agent", AGENT, false);
    const u = w.units.get(CONTROLLER);
    if (u === undefined) {
      throw new Error("controller unit missing");
    }
    u.spawnRemaining = 2;
    const noopExec = (): Promise<ExecResult> =>
      Promise.resolve({ code: 0, stdout: "", stderr: "" });
    const ctx = {
      deps,
      git: noopExec,
      repo: REPO,
      manager,
      controller,
      agent,
      agentEndpoint: { url: "https://127.0.0.1:17843", source: "test" },
      hostsEnv: {},
      snapshot: [],
      install: { argv: [], capped: false, warnings: [] },
      controllerLog: { kind: "none" },
      timeouts: { ...DEFAULT_TIMEOUTS, controllerStartMs: 4_000, pollMs: 100 },
      lock: null,
      signal: new AbortController().signal,
    } as unknown as DeployContext;
    const r = await ensureControllerRunning(ctx);
    expect(r === null || r.ok).toBe(true);
    expect(w.calls.filter((c) => c[0] === "launchctl" && c.includes("bootstrap"))).toEqual([]);
    expect(w.calls.filter((c) => c[0] === "launchctl" && c.includes("kickstart"))).toEqual([]);
  });
});
