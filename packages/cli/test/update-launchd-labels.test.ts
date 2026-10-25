import { describe, expect, test } from "bun:test";

import { runUpdate } from "../src/commands/update/index.js";
import {
  BUN,
  CONTROLLER_LOG,
  ENTRY,
  fakeDeps,
  type FakeUnit,
  makeWorld,
  type World,
} from "./update-fakes.js";

interface Report {
  result: string;
  refusals: string[];
  warnings: string[];
  services: { role: string; name: string; loaded: boolean; active: boolean; pid: number | null }[];
}

async function run(w: World, args: string[]): Promise<{ code: number; report: Report }> {
  const { deps, out } = fakeDeps(w);
  const code = await runUpdate([...args, "--json"], deps);
  return { code, report: JSON.parse(out.stdout) as Report };
}

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

const plist = (label: string): string => `/Users/u/Library/LaunchAgents/${label}.plist`;

const controllerUnit = (): FakeUnit =>
  unit({
    argv: [BUN, ENTRY, "controller", "serve"],
    standardOutput: CONTROLLER_LOG,
    plistPath: plist("com.llamactl.controller"),
  });

const agentUnit = (label: string): FakeUnit =>
  unit({
    pid: 502,
    argv: [BUN, ENTRY, "agent", "serve"],
    plistPath: plist(label),
  });

function launchdWorld(units: [string, FakeUnit][]): World {
  return makeWorld({ platform: "darwin", units: new Map(units) });
}

const SUPERVISOR = "com.llamactl.fleet-supervisor";
const SUPERVISOR_WARNING = `${SUPERVISOR} runs this checkout and llamactl update does not restart it; after --apply restart it with: llamactl infra restart-control-plane (or launchctl kickstart -k gui/501/${SUPERVISOR})`;

describe("launchd agent label fallback", () => {
  test("com.llamactl.agent absent, com.llamactl.node-agent running: resolved, no refusal", async () => {
    const w = launchdWorld([
      ["com.llamactl.controller", controllerUnit()],
      ["com.llamactl.node-agent", agentUnit("com.llamactl.node-agent")],
    ]);
    const { code, report } = await run(w, ["--check"]);
    expect(code).toBe(0);
    expect(report.services.find((s) => s.role === "agent")?.name).toBe("com.llamactl.node-agent");
    expect(report.refusals.filter((r) => r.includes("agent"))).toEqual([]);
  });

  test("an explicit --agent-unit never falls back", async () => {
    const w = launchdWorld([
      ["com.llamactl.controller", controllerUnit()],
      ["com.llamactl.node-agent", agentUnit("com.llamactl.node-agent")],
    ]);
    const { report } = await run(w, ["--check", "--agent-unit", "com.llamactl.agent"]);
    expect(report.refusals.some((r) => r.includes("com.llamactl.agent is not loaded"))).toBe(true);
  });

  test("neither agent label loaded: the default name is still in the refusal", async () => {
    const w = launchdWorld([["com.llamactl.controller", controllerUnit()]]);
    const { report } = await run(w, ["--check"]);
    expect(report.refusals).toContain("com.llamactl.agent is not loaded");
  });
});

describe("launchd control-plane jobs left running", () => {
  function withControlPlane(): World {
    return launchdWorld([
      ["com.llamactl.controller", controllerUnit()],
      ["com.llamactl.agent", agentUnit("com.llamactl.agent")],
      [
        SUPERVISOR,
        unit({
          pid: 601,
          argv: [BUN, ENTRY, "supervisor", "serve"],
          plistPath: plist(SUPERVISOR),
        }),
      ],
      [
        "com.llamactl.internal-proxy",
        unit({
          pid: 602,
          argv: [BUN, "/other/llamactl/packages/cli/src/bin.ts", "proxy", "serve"],
          plistPath: plist("com.llamactl.internal-proxy"),
        }),
      ],
      [
        "com.llamactl.node-agent",
        unit({ loaded: false, active: false, pid: 0, plistPath: plist("com.llamactl.node-agent") }),
      ],
    ]);
  }

  test("--check warns about the supervisor but not other checkouts or unloaded jobs", async () => {
    const { report } = await run(withControlPlane(), ["--check"]);
    expect(report.warnings).toContain(SUPERVISOR_WARNING);
    expect(report.warnings.filter((x) => x.includes("runs this checkout"))).toEqual([
      SUPERVISOR_WARNING,
    ]);
  });

  test("--apply never stops, starts or restarts the supervisor job", async () => {
    const w = withControlPlane();
    const { code } = await run(w, ["--apply"]);
    expect(code).toBe(0);
    const mutated = w.calls.filter(
      (c) =>
        c[0] === "launchctl" &&
        (c.includes("kickstart") || c.includes("bootout") || c.includes("bootstrap")) &&
        c.join(" ").includes(SUPERVISOR),
    );
    expect(mutated).toEqual([]);
  });
});

describe("systemd is untouched", () => {
  test("a systemd world gets no control-plane warnings", async () => {
    const { report } = await run(makeWorld(), ["--check"]);
    expect(report.warnings.filter((x) => x.includes("runs this checkout"))).toEqual([]);
  });
});
