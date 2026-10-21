import { describe, expect, test } from "bun:test";

import type { UpdateDeps } from "../src/commands/update/deps.js";

import { runUpdate } from "../src/commands/update/index.js";
import {
  buildDeploySteps,
  missingAdoptions,
  parseControllerReports,
} from "../src/commands/update/procedure.js";
import {
  AGENT_UNIT,
  BUN,
  CONTROLLER_UNIT,
  fakeDeps,
  HISTORY,
  makeWorld,
  REPO,
  sha,
  UNIT_CGROUP,
  type World,
} from "./update-fakes.js";

interface Report {
  result: string;
  refusals: string[];
  steps: { step: string; ok: boolean; detail: string; warnings: string[] }[];
  rollbackSteps: { step: string; ok: boolean; detail: string }[];
  error: string | null;
  rollbackTarget: { branch: string | null; sha: string } | null;
}

async function run(
  w: World,
  args: string[],
  over: Partial<UpdateDeps> = {},
): Promise<{ code: number; report: Report; log: string }> {
  const { deps, out } = fakeDeps(w, over);
  const code = await runUpdate([...args, "--json"], deps);
  return {
    code,
    report: JSON.parse(out.stdout) as Report,
    log: `${out.log.join("\n")}\n${out.stderr}`,
  };
}

/** Install events carry the full argv; most tests only care that one ran. */
const eventLabel = (e: string): string => (e.startsWith("install ") ? "install" : e);

const INSTALL = `install flock -w 1800 /h/.heavy.lock systemd-run --user --scope --collect -q -p MemoryHigh=12G -p MemoryMax=16G -p MemorySwapMax=1G -- choom -n 900 -- ${BUN} install --frozen-lockfile --ignore-scripts`;

describe("buildDeploySteps", () => {
  test("controller stopped before the switch, started after the install, agent last", () => {
    const steps = buildDeploySteps({
      sha: sha(4),
      mode: { kind: "main" },
      depsChanged: true,
      waitIdleSec: 600,
      restartAgent: true,
    });
    expect(steps.map((s) => s.kind)).toEqual([
      "stop-controller",
      "switch",
      "install",
      "start-controller",
      "await-controller",
      "wait-idle",
      "restart-agent",
      "verify",
    ]);
  });

  test("no install without dependency changes; no agent restart when not asked", () => {
    const steps = buildDeploySteps({
      sha: sha(1),
      mode: { kind: "detach" },
      depsChanged: false,
      waitIdleSec: 0,
      restartAgent: false,
    });
    expect(steps.map((s) => s.kind)).toEqual([
      "stop-controller",
      "switch",
      "start-controller",
      "await-controller",
      "verify",
    ]);
  });
});

describe("controller reports", () => {
  test("only lines after the start line count", () => {
    const text = [
      "[t0] modelhost/seat on local: unchanged",
      "controller started pid=1 workloads=/w cfg=/c",
      "controller: source-staleness reload ARMED at abc",
      "[t1] modelhost/seat on local: restarted",
      "[t2] modelrun/gemma on gpu1: unchanged",
      "[t2] WARN modelhost/other on local: unchanged error=boom",
    ].join("\n");
    const r = parseControllerReports(text);
    expect(r.started).toBe(true);
    expect(r.passSeen).toBe(true);
    expect([...(r.actions.get("seat") ?? [])]).toEqual(["restarted"]);
    expect(missingAdoptions(r, ["seat", "gemma"])).toEqual(["seat"]);
    expect(
      missingAdoptions(parseControllerReports("[t] modelhost/seat on local: unchanged"), ["seat"]),
    ).toEqual(["seat"]);
  });

  test("older builds' 'converged' counts as unchanged", () => {
    const r = parseControllerReports(
      "controller started pid=1\n[t] modelrun/seat on local: converged\n",
    );
    expect(missingAdoptions(r, ["seat"])).toEqual([]);
  });
});

describe("llamactl update --apply", () => {
  test("runs the ordered procedure and records history", async () => {
    const w = makeWorld();
    w.files.set(
      "/srv/llamactl.env",
      `${w.files.get("/srv/llamactl.env") ?? ""}LLAMACTL_UPDATE_HEAVY_LOCK=/h/.heavy.lock\n`,
    );
    const { code, report, log } = await run(w, ["--apply"]);
    expect(code).toBe(0);
    expect(report.result).toBe("applied");
    expect(w.events).toEqual([
      `stop ${CONTROLLER_UNIT}`,
      `switch -C main ${sha(4)}`,
      INSTALL,
      `start ${CONTROLLER_UNIT}`,
      `restart ${AGENT_UNIT}`,
    ]);
    expect(report.steps.map((s) => `${s.step}:${String(s.ok)}`)).toEqual([
      "stop-controller:true",
      "switch:true",
      "install:true",
      "start-controller:true",
      "await-controller:true",
      "wait-idle:true",
      "restart-agent:true",
      "verify:true",
    ]);
    expect(report.steps.find((s) => s.step === "await-controller")?.detail).toContain(
      "unchanged: seat (pid 2039339)",
    );
    expect(report.steps.at(-1)?.detail).toContain("worker RPC negotiate: not-advertised");
    const history = (w.files.get(HISTORY) ?? "").trim().split("\n");
    expect(history).toHaveLength(2);
    expect(history[0]).toEndWith(` from=feat/strata-engine@${sha(1)} to=${sha(4)}`);
    expect(history[1]).toMatch(/ ok 4444444$/);
    expect(
      w.calls.some(
        (c) => c.join(" ") === `git -C ${REPO} branch --quiet --set-upstream-to=origin/main main`,
      ),
    ).toBe(true);
    expect(log).toContain("Roll back with: llamactl update --rollback");
  });

  test("skips bun install when no dependency changed, and uses the unit's bun", async () => {
    const w = makeWorld({
      diffs: new Map([[`${sha(1)}..${sha(4)}`, ["packages/cli/src/bin.ts"]]]),
    });
    const { code } = await run(w, ["--apply"]);
    expect(code).toBe(0);
    expect(w.events.some((e) => e.startsWith("install"))).toBe(false);
  });

  test("an install failure rolls back", async () => {
    const w = makeWorld({ installExit: 1 });
    const { code, report } = await run(w, ["--apply"]);
    expect(code).toBe(1);
    expect(report.result).toBe("failed");
    expect(report.steps.at(-1)).toMatchObject({ step: "install", ok: false });
    expect(w.head).toBe(sha(1));
    expect(w.branch).toBe("feat/strata-engine");
  });

  test("an unhealthy agent after the restart rolls back automatically", async () => {
    const w = makeWorld({
      onAgentRestart: (world) => {
        world.agentHealthy = world.head === sha(1);
      },
    });
    const { code, report, log } = await run(w, ["--apply"]);
    expect(code).toBe(1);
    expect(report.result).toBe("failed");
    expect(report.steps.at(-1)).toMatchObject({ step: "restart-agent", ok: false });
    expect(w.events.map(eventLabel)).toEqual([
      `stop ${CONTROLLER_UNIT}`,
      `switch -C main ${sha(4)}`,
      "install",
      `start ${CONTROLLER_UNIT}`,
      `restart ${AGENT_UNIT}`,
      `stop ${CONTROLLER_UNIT}`,
      "switch feat/strata-engine",
      "install",
      `start ${CONTROLLER_UNIT}`,
      `restart ${AGENT_UNIT}`,
    ]);
    expect(report.rollbackSteps.every((s) => s.ok)).toBe(true);
    expect(w.head).toBe(sha(1));
    expect(report.error).toContain("rolled back to feat/strata-engine@1111111");
    expect(w.files.get(HISTORY)).toMatch(/rolled-back to feat\/strata-engine@1111111\n$/);
    expect(log).toContain("rolling back to feat/strata-engine@");
  });

  test("a controller that never re-adopts the host rolls back without touching the agent", async () => {
    const w = makeWorld({
      onControllerStart: (world) => {
        if (world.head === sha(4)) world.controllerLog += "controller started pid=9\n";
        else
          world.controllerLog +=
            "controller started pid=9\n[t] modelhost/seat on local: unchanged\n";
      },
    });
    const { code, report } = await run(w, ["--apply"]);
    expect(code).toBe(1);
    expect(report.steps.at(-1)?.detail).toContain("did not report seat unchanged within 90 s");
    expect(w.events.filter((e) => e.startsWith("restart"))).toEqual([]);
    expect(report.rollbackSteps.map((s) => s.step)).not.toContain("restart-agent");
    expect(w.head).toBe(sha(1));
  });

  test("an exception mid-procedure still rolls back", async () => {
    const w = makeWorld();
    const hosts = (): ReturnType<UpdateDeps["listManagedHosts"]> => {
      if (w.head === sha(4) && w.events.includes(`start ${CONTROLLER_UNIT}`)) {
        throw new Error("EACCES: runtime dir");
      }
      return w.hosts.map(({ name, kind, pid, host, port }) => ({ name, kind, pid, host, port }));
    };
    const { code, report } = await run(w, ["--apply"], { listManagedHosts: hosts });
    expect(code).toBe(1);
    expect(report.steps.at(-1)).toMatchObject({
      step: "await-controller",
      ok: false,
      detail: "unexpected error: EACCES: runtime dir",
    });
    expect(report.rollbackSteps.every((st) => st.ok)).toBe(true);
    expect(w.head).toBe(sha(1));
    expect(w.units.get(CONTROLLER_UNIT)?.active).toBe(true);
  });

  test("a rollback that fails too is reported, not retried", async () => {
    const w = makeWorld({
      onAgentRestart: (world) => {
        world.agentHealthy = false;
      },
    });
    const { code, report } = await run(w, ["--apply"]);
    expect(code).toBe(1);
    expect(report.error).toContain("the rollback is unhealthy too");
    expect(report.error).toContain(`systemctl --user status ${CONTROLLER_UNIT} ${AGENT_UNIT}`);
  });

  test("a host the controller restarted is a warning, and gets time to load", async () => {
    const w = makeWorld({
      onControllerStart: (world) => {
        const seat = world.hosts[0];
        if (seat !== undefined) seat.pid = 31337;
        world.controllerLog +=
          "controller started pid=9\n[t] modelhost/seat on local: restarted\n[t] modelhost/seat on local: unchanged\n";
      },
    });
    const { code, report } = await run(w, ["--apply"]);
    expect(code).toBe(0);
    const warnings = report.steps.find((s) => s.step === "await-controller")?.warnings ?? [];
    expect(warnings).toContain("seat pid changed 2039339 -> 31337: it was restarted");
    expect(warnings).toContain("the controller (re)started seat");
  });

  test("waits for busy hosts, then restarts the agent anyway", async () => {
    const w = makeWorld();
    const seat = w.hosts[0];
    if (seat !== undefined) seat.idle = "busy";
    const { code, report } = await run(w, ["--apply", "--wait-idle", "20"]);
    expect(code).toBe(0);
    expect(report.steps.find((s) => s.step === "wait-idle")?.warnings[0]).toContain(
      "still busy after 20 s",
    );
    expect(w.events.at(-1)).toBe(`restart ${AGENT_UNIT}`);
  });

  test("already up to date does nothing", async () => {
    const w = makeWorld({ head: sha(4), branch: "main", branches: new Map([["main", sha(4)]]) });
    const { code, report } = await run(w, ["--apply"]);
    expect(code).toBe(0);
    expect(report.result).toBe("up-to-date");
    expect(w.events).toEqual([]);
  });
});

describe("--apply refusals touch nothing", () => {
  async function refused(w: World, args: string[] = ["--apply"]): Promise<string[]> {
    const { code, report } = await run(w, args);
    expect(code).toBe(1);
    expect(report.result).toBe("refused");
    expect(w.events).toEqual([]);
    expect(w.files.has(HISTORY)).toBe(false);
    return report.refusals;
  }

  test("tracked local changes", async () => {
    expect((await refused(makeWorld({ dirty: [" M packages/cli/src/bin.ts"] })))[0]).toContain(
      "tracked local changes",
    );
  });

  test("a target that is not a fast-forward", async () => {
    expect(
      (await refused(makeWorld({ head: sha(4), branch: "feat/x", originMain: sha(2) })))[0],
    ).toContain("not a fast-forward");
  });

  test("red CI, unless --allow-red-ci", async () => {
    const failing = JSON.stringify([{ status: "completed", conclusion: "failure" }]);
    expect((await refused(makeWorld({ ciJson: failing })))[0]).toContain("target CI is 'failure'");
    const w = makeWorld({ ciJson: failing });
    expect((await run(w, ["--apply", "--allow-red-ci"])).code).toBe(0);
  });

  test("CI unknown without gh", async () => {
    expect((await refused(makeWorld({ haveGh: false })))[0]).toContain("target CI is 'unknown'");
  });

  test("running inside a unit it would restart", async () => {
    const w = makeWorld();
    w.files.set("/proc/self/cgroup", `0::${UNIT_CGROUP}/${AGENT_UNIT}\n`);
    const reasons = await refused(w);
    expect(reasons[0]).toContain(`running inside ${AGENT_UNIT}`);
    expect(reasons[0]).toContain("systemd-run --user --unit llamactl-update");
  });

  test("no matching service manager config", async () => {
    const w = makeWorld();
    const ctl = w.units.get(CONTROLLER_UNIT);
    if (ctl !== undefined) ctl.loaded = false;
    const reasons = await refused(w);
    expect(reasons).toContain(`${CONTROLLER_UNIT} is not loaded`);
    expect(reasons.join("\n")).toContain("--controller-unit/--agent-unit");
  });

  test("a default-named unit that runs a different checkout", async () => {
    const w = makeWorld();
    const agent = w.units.get(AGENT_UNIT);
    if (agent !== undefined)
      agent.argv = [BUN, "/elsewhere/packages/cli/src/bin.ts", "agent", "serve"];
    expect((await refused(w))[0]).toContain(
      `${AGENT_UNIT} does not run 'agent serve' from ${REPO}`,
    );
  });

  test("a unit whose KillMode would kill a model host", async () => {
    const w = makeWorld();
    const ctl = w.units.get(CONTROLLER_UNIT);
    if (ctl !== undefined) ctl.killMode = "control-group";
    expect((await refused(w))[0]).toContain(
      "KillMode=control-group: stopping it would kill seat (pid 2039339)",
    );
  });

  test("an unhealthy host before the update", async () => {
    const w = makeWorld();
    const seat = w.hosts[0];
    if (seat !== undefined) seat.ready = false;
    expect((await refused(w))[0]).toContain(
      "model host seat (http://127.0.0.1:18080) is not ready",
    );
  });

  test("no supported service manager", async () => {
    const reasons = await refused(makeWorld({ platform: "win32" }));
    expect(reasons[0]).toContain("no supported service manager on win32");
  });
});

describe("llamactl update --rollback", () => {
  function updated(): World {
    const w = makeWorld({
      head: sha(4),
      branch: "main",
      branches: new Map([
        ["feat/strata-engine", sha(1)],
        ["main", sha(4)],
      ]),
    });
    w.files.set(HISTORY, `t1 from=feat/strata-engine@${sha(1)} to=${sha(4)}\nt2 ok 4444444\n`);
    return w;
  }

  test("defaults to where the last update came from, restoring the branch", async () => {
    const w = updated();
    const { code, report } = await run(w, ["--rollback"]);
    expect(code).toBe(0);
    expect(report.result).toBe("rolled-back");
    expect(report.rollbackTarget).toEqual({ branch: "feat/strata-engine", sha: sha(1) });
    expect(w.events.map(eventLabel)).toEqual([
      `stop ${CONTROLLER_UNIT}`,
      "switch feat/strata-engine",
      "install",
      `start ${CONTROLLER_UNIT}`,
      `restart ${AGENT_UNIT}`,
    ]);
    const lines = (w.files.get(HISTORY) ?? "").trim().split("\n");
    expect(lines[2]).toEndWith(` rollback from=main@${sha(4)} to=feat/strata-engine@${sha(1)}`);
    expect(lines[3]).toMatch(/ ok 1111111$/);
  });

  test("detaches when the recorded branch has moved on", async () => {
    const w = updated();
    w.branches.set("feat/strata-engine", sha(2));
    const { code } = await run(w, ["--rollback"]);
    expect(code).toBe(0);
    expect(w.events).toContain(`switch --detach ${sha(1)}`);
    expect(w.branch).toBeNull();
  });

  test("main@sha resets main", async () => {
    const w = updated();
    const { code } = await run(w, ["--rollback", `main@${sha(3)}`]);
    expect(code).toBe(0);
    expect(w.events).toContain(`switch -C main ${sha(3)}`);
  });

  test("a bare sha detaches", async () => {
    const w = updated();
    const { code, report } = await run(w, ["--rollback", sha(2)]);
    expect(code).toBe(0);
    expect(report.rollbackTarget).toEqual({ branch: null, sha: sha(2) });
    expect(w.events).toContain(`switch --detach ${sha(2)}`);
  });

  test("without history or a target it refuses to guess", async () => {
    const w = makeWorld();
    const { code, report } = await run(w, ["--rollback"]);
    expect(code).toBe(1);
    expect(report.error).toContain("no rollback target");
    expect(w.events).toEqual([]);
  });

  test("tracked local changes refuse a rollback too", async () => {
    const w = updated();
    w.dirty = ["M x"];
    const { code, report } = await run(w, ["--rollback"]);
    expect(code).toBe(1);
    expect(report.refusals[0]).toContain("tracked local changes");
    expect(w.events).toEqual([]);
  });
});

describe("launchd", () => {
  test("bootout, bootstrap and kickstart in the same order", async () => {
    const w = makeWorld({ platform: "darwin" });
    w.units = new Map([
      [
        "com.llamactl.controller",
        {
          loaded: true,
          active: true,
          pid: 501,
          argv: [BUN, `${REPO}/packages/cli/src/bin.ts`, "controller", "serve"],
          killMode: "process",
          cgroup: "",
          standardOutput: "/srv/state/logs/llamactl-controller.log",
          environmentFile: null,
          plistPath: "/Users/u/Library/LaunchAgents/com.llamactl.controller.plist",
        },
      ],
      [
        "com.llamactl.agent",
        {
          loaded: true,
          active: true,
          pid: 502,
          argv: [
            BUN,
            `${REPO}/packages/cli/src/bin.ts`,
            "agent",
            "serve",
            "--dir=/srv/state/agent",
          ],
          killMode: "process",
          cgroup: "",
          standardOutput: null,
          environmentFile: null,
          plistPath: "/Users/u/Library/LaunchAgents/com.llamactl.agent.plist",
        },
      ],
    ]);
    const { code, report } = await run(w, ["--apply"]);
    expect(report.refusals).toEqual([]);
    expect(code).toBe(0);
    expect(w.events).toEqual([
      "bootout com.llamactl.controller",
      `switch -C main ${sha(4)}`,
      `install ${BUN} install --frozen-lockfile --ignore-scripts`,
      "bootstrap com.llamactl.controller",
      "kickstart com.llamactl.agent",
    ]);
  });
});
