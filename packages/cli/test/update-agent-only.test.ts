// `llamactl update --agent-only` (#309): worker nodes whose controller is
// handed to a central one update only the agent — the local controller unit
// is never stopped, started or awaited, and --apply refuses while one is
// still active locally.
import { describe, expect, test } from "bun:test";

import { parseUpdateFlags } from "../src/commands/update/flags.js";
import { runUpdate } from "../src/commands/update/index.js";
import { buildDeploySteps } from "../src/commands/update/procedure.js";
import {
  AGENT_UNIT,
  CONTROLLER_UNIT,
  fakeDeps,
  HISTORY,
  makeWorld,
  sha,
  type World,
} from "./update-fakes.js";

interface Report {
  result: string;
  agentOnly?: boolean;
  refusals: string[];
  steps: { step: string; ok: boolean }[];
  rollbackSteps: { step: string; ok: boolean }[];
  finalStart: { ok: boolean } | null;
  error: string | null;
}

async function run(
  w: World,
  args: string[],
): Promise<{ code: number; report: Report | null; log: string }> {
  const { deps, out } = fakeDeps(w);
  const code = await runUpdate([...args, "--json"], deps);
  return {
    code,
    report: out.stdout === "" ? null : (JSON.parse(out.stdout) as Report),
    log: `${out.log.join("\n")}\n${out.stderr}`,
  };
}

/** Install events carry the full argv; these tests only care that one ran. */
const eventLabel = (e: string): string => (e.startsWith("install ") ? "install" : e);

/** A worker node: the controller unit is installed but not running locally. */
function agentOnlyWorld(over: Partial<World> = {}): World {
  const w = makeWorld(over);
  w.units.get(CONTROLLER_UNIT)!.active = false;
  return w;
}

describe("parseUpdateFlags --agent-only", () => {
  test("parses as a switch and defaults to false", () => {
    expect(parseUpdateFlags(["--apply", "--agent-only"])).toMatchObject({
      mode: "apply",
      agentOnly: true,
    });
    expect(parseUpdateFlags(["--apply"])).toMatchObject({ agentOnly: false });
  });
});

describe("buildDeploySteps agentOnly", () => {
  test("drops the controller steps, keeps the lock, install, agent restart and verify", () => {
    expect(
      buildDeploySteps({
        sha: sha(4),
        mode: { kind: "main" },
        depsChanged: true,
        waitIdleSec: 600,
        restartAgent: true,
        lock: false,
        agentOnly: true,
      }).map((s) => s.kind),
    ).toEqual(["switch", "install", "wait-idle", "restart-agent", "verify"]);
    expect(
      buildDeploySteps({
        sha: sha(4),
        mode: { kind: "main" },
        depsChanged: true,
        waitIdleSec: 600,
        restartAgent: true,
        lock: true,
        agentOnly: true,
      }).map((s) => s.kind),
    ).toEqual(["lock", "switch", "install", "unlock", "wait-idle", "restart-agent", "verify"]);
  });
});

describe("--check on an agent-only worker", () => {
  test("the default mode hints at --agent-only, and the flag skips the controller", async () => {
    const plain = await run(agentOnlyWorld(), ["--check"]);
    expect(
      plain.report?.refusals.some(
        (r) => r.includes(`${CONTROLLER_UNIT} is not active`) && r.includes("--agent-only"),
      ),
    ).toBe(true);

    const { code, report, log } = await run(agentOnlyWorld(), ["--check", "--agent-only"]);
    expect(code).toBe(0);
    expect(report?.result).toBe("check");
    expect(report?.agentOnly).toBe(true);
    expect(report?.refusals.some((r) => r.includes("is not active"))).toBe(false);
    expect(log).toContain("agent-only mode");
  });
});

describe("--apply --agent-only", () => {
  test("switches, installs and restarts only the agent", async () => {
    const w = agentOnlyWorld();
    const { code, report } = await run(w, ["--apply", "--agent-only"]);
    expect(code).toBe(0);
    expect(report?.result).toBe("applied");
    expect(w.events.map(eventLabel)).toEqual([
      `switch -C main ${sha(4)}`,
      "install",
      `restart ${AGENT_UNIT}`,
    ]);
    expect(w.events.some((e) => e.includes(CONTROLLER_UNIT))).toBe(false);
    expect(report?.finalStart).toBeNull();
    expect(w.files.get(HISTORY) ?? "").toContain(` ok ${sha(4).slice(0, 7)}`);
    const steps = report?.steps.map((s) => s.step) ?? [];
    expect(steps).toContain("wait-idle");
    expect(steps).toContain("verify");
  });

  test("an unhealthy agent rolls back over the agent only", async () => {
    const w = agentOnlyWorld({
      onAgentRestart: (world) => {
        world.agentHealthy = world.head === sha(1);
      },
    });
    const { code, report } = await run(w, ["--apply", "--agent-only"]);
    expect(code).toBe(1);
    expect(report?.result).toBe("failed");
    expect(report?.error ?? "").toContain("rolled back to feat/strata-engine@1111111");
    expect(report?.steps.at(-1)).toMatchObject({ step: "restart-agent", ok: false });
    expect(report?.rollbackSteps.length ?? 0).toBeGreaterThan(0);
    expect(report?.rollbackSteps.every((s) => s.ok) ?? false).toBe(true);
    expect(w.events.map(eventLabel)).toEqual([
      `switch -C main ${sha(4)}`,
      "install",
      `restart ${AGENT_UNIT}`,
      "switch feat/strata-engine",
      "install",
      `restart ${AGENT_UNIT}`,
    ]);
    expect(w.events.some((e) => e.includes(CONTROLLER_UNIT))).toBe(false);
    expect(report?.finalStart).toBeNull();
    expect(w.files.get(HISTORY) ?? "").toMatch(/rolled-back to feat\/strata-engine@1111111\n$/);
  });

  test("refuses while the local controller is active; a plain --apply still drives it", async () => {
    const w = makeWorld();
    const refused = await run(w, ["--apply", "--agent-only"]);
    expect(refused.code).toBe(1);
    expect(refused.report?.result).toBe("refused");
    expect(
      refused.report?.refusals.some(
        (r) => r.includes("--agent-only") && r.includes(`${CONTROLLER_UNIT} is active`),
      ),
    ).toBe(true);
    expect(w.events).toEqual([]);

    const w2 = makeWorld();
    const applied = await run(w2, ["--apply"]);
    expect(applied.code).toBe(0);
    expect(w2.events).toContain(`stop ${CONTROLLER_UNIT}`);
    expect(w2.events).toContain(`start ${CONTROLLER_UNIT}`);
  });
});

describe("--rollback --agent-only", () => {
  test("covers only the agent", async () => {
    const w = agentOnlyWorld({
      head: sha(4),
      branch: "main",
      branches: new Map([
        ["feat/strata-engine", sha(1)],
        ["main", sha(4)],
      ]),
    });
    w.files.set(HISTORY, `t1 from=feat/strata-engine@${sha(1)} to=${sha(4)}\nt2 ok 4444444\n`);
    const { code, report } = await run(w, ["--rollback", "--agent-only"]);
    expect(code).toBe(0);
    expect(report?.result).toBe("rolled-back");
    expect(w.events.map(eventLabel)).toEqual([
      "switch feat/strata-engine",
      "install",
      `restart ${AGENT_UNIT}`,
    ]);
    expect(w.events.some((e) => e.includes(CONTROLLER_UNIT))).toBe(false);
    expect(report?.finalStart).toBeNull();
  });
});
