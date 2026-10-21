import { describe, expect, test } from "bun:test";

import type { ExecResult } from "../src/commands/update/deps.js";

import { buildInstallCommand } from "../src/commands/update/procedure.js";
import {
  cgroupWithin,
  checkServiceMatch,
  enclosingService,
  killsChildren,
  launchdManager,
  parseCgroupPath,
  parseEnvFile,
  parseEnvironmentAssignments,
  parseExecStartArgv,
  parseLaunchctlPrint,
  parseSystemctlShow,
  parseUnitFile,
  pickServiceManagerKind,
  serviceBun,
  type ServiceInfo,
  stdoutTarget,
  systemdManager,
} from "../src/commands/update/services.js";

// Shape of `systemctl --user show` on systemd 255 (captured from a live unit).
const SHOW = `MainPID=2077114
ExecStart={ path=/home/u/.bun/bin/bun ; argv[]=/home/u/.bun/bin/bun /srv/llamactl/packages/cli/src/bin.ts controller serve --interval=10 ; ignore_errors=no ; start_time=[Wed 2026-10-21 17:07:06 EDT] ; stop_time=[n/a] ; pid=2077114 ; code=(null) ; status=0/0 }
ControlGroup=/user.slice/user-1000.slice/user@1000.service/app.slice/llamactl-controller.service
KillMode=process
Id=llamactl-controller.service
LoadState=loaded
ActiveState=active`;

function info(over: Partial<ServiceInfo> = {}): ServiceInfo {
  return {
    role: "controller",
    name: "llamactl-controller.service",
    explicit: false,
    loaded: true,
    active: true,
    pid: 1,
    argv: ["/opt/bun", "/srv/llamactl/packages/cli/src/bin.ts", "controller", "serve"],
    cgroup: "/app.slice/llamactl-controller.service",
    killMode: "process",
    env: {},
    stdoutPath: null,
    journal: true,
    plistPath: null,
    ...over,
  };
}

describe("systemd parsing", () => {
  test("systemctl show and its ExecStart argv", () => {
    const props = parseSystemctlShow(SHOW);
    expect(props["LoadState"]).toBe("loaded");
    expect(props["ControlGroup"]).toBe(
      "/user.slice/user-1000.slice/user@1000.service/app.slice/llamactl-controller.service",
    );
    expect(parseExecStartArgv(props["ExecStart"] ?? "")).toEqual([
      "/home/u/.bun/bin/bun",
      "/srv/llamactl/packages/cli/src/bin.ts",
      "controller",
      "serve",
      "--interval=10",
    ]);
    expect(parseExecStartArgv("")).toEqual([]);
  });

  test("systemctl cat: later assignments win, empty ones reset lists", () => {
    const text = [
      "# /home/u/.config/systemd/user/llamactl-controller.service",
      "[Service]",
      "EnvironmentFile=/srv/llamactl.env",
      "EnvironmentFile=-/srv/optional.env",
      'Environment=A=1 "B=two words"',
      "StandardOutput=journal",
      "",
      "# /home/u/.config/systemd/user/llamactl-controller.service.d/override.conf",
      "[Service]",
      "StandardOutput=append:/srv/state/logs/llamactl-controller.log",
      "Environment=C=3",
    ].join("\n");
    expect(parseUnitFile(text)).toEqual({
      environment: { A: "1", B: "two words", C: "3" },
      environmentFiles: [
        { path: "/srv/llamactl.env", optional: false },
        { path: "/srv/optional.env", optional: true },
      ],
      standardOutput: "append:/srv/state/logs/llamactl-controller.log",
    });
    expect(
      parseUnitFile("EnvironmentFile=/a\nEnvironmentFile=\nEnvironment=X=1\nEnvironment=")
        .environmentFiles,
    ).toEqual([]);
    expect(parseUnitFile("Environment=X=1\nEnvironment=").environment).toEqual({});
  });

  test("stdoutTarget", () => {
    expect(stdoutTarget(null)).toEqual({ path: null, journal: true });
    expect(stdoutTarget("journal+console")).toEqual({ path: null, journal: true });
    expect(stdoutTarget("append:/l/c.log")).toEqual({ path: "/l/c.log", journal: false });
    expect(stdoutTarget("file:/l/c.log")).toEqual({ path: "/l/c.log", journal: false });
    expect(stdoutTarget("null")).toEqual({ path: null, journal: false });
  });

  test("environment files and assignments", () => {
    expect(parseEnvFile("# c\nA=1\nexport B='x y'\n\nC=\"q\"\n; ini comment\nbad line\n")).toEqual({
      A: "1",
      B: "x y",
      C: "q",
    });
    expect(parseEnvironmentAssignments("A=1 'B=2 3' C=")).toEqual({ A: "1", B: "2 3", C: "" });
  });
});

describe("systemdManager", () => {
  test("describe reads state, argv, cgroup, KillMode, env files and the stdout file", async () => {
    const calls: string[][] = [];
    const exec = (argv: readonly string[]): Promise<ExecResult> => {
      calls.push([...argv]);
      if (argv[2] === "show") return Promise.resolve({ code: 0, stdout: SHOW, stderr: "" });
      if (argv[2] === "cat") {
        return Promise.resolve({
          code: 0,
          stdout:
            "[Service]\nEnvironmentFile=/srv/llamactl.env\nEnvironment=X=1\nStandardOutput=append:/srv/c.log\n",
          stderr: "",
        });
      }
      return Promise.resolve({ code: 1, stdout: "", stderr: "" });
    };
    const files = new Map([["/srv/llamactl.env", "DEV_STORAGE=/srv/state\nX=0\n"]]);
    const mgr = systemdManager(exec, (p) => files.get(p) ?? null);
    const svc = await mgr.describe("controller", "llamactl-controller.service", false);
    expect(svc).toMatchObject({
      loaded: true,
      active: true,
      pid: 2077114,
      killMode: "process",
      env: { DEV_STORAGE: "/srv/state", X: "1" },
      stdoutPath: "/srv/c.log",
      journal: false,
    });
    expect(calls[0]?.slice(0, 4)).toEqual([
      "systemctl",
      "--user",
      "show",
      "llamactl-controller.service",
    ]);
  });

  test("a unit that is not loaded describes as not loaded", async () => {
    const exec = (): Promise<ExecResult> =>
      Promise.resolve({
        code: 0,
        stdout: "LoadState=not-found\nActiveState=inactive\n",
        stderr: "",
      });
    const svc = await systemdManager(exec, () => null).describe("agent", "nope.service", false);
    expect(svc.loaded).toBe(false);
  });
});

describe("launchd", () => {
  const PRINT = `gui/501/com.llamactl.agent = {
	active count = 1
	path = /Users/u/Library/LaunchAgents/com.llamactl.agent.plist
	type = LaunchAgent
	state = running

	program = /opt/bun
	arguments = {
		/opt/bun
		/srv/llamactl/packages/cli/src/bin.ts
		agent
		serve
	}

	stdout path = /Users/u/logs/agent.log
	environment = {
		LLAMACTL_AGENT_DIR => /Users/u/agent
	}

	endpoints = {
		"com.x" = {
			port = 1
		}
	}

	pid = 4321
}`;

  test("parseLaunchctlPrint", () => {
    expect(parseLaunchctlPrint(PRINT)).toEqual({
      state: "running",
      pid: 4321,
      argv: ["/opt/bun", "/srv/llamactl/packages/cli/src/bin.ts", "agent", "serve"],
      stdoutPath: "/Users/u/logs/agent.log",
      plistPath: "/Users/u/Library/LaunchAgents/com.llamactl.agent.plist",
      env: { LLAMACTL_AGENT_DIR: "/Users/u/agent" },
    });
  });

  test("start refuses without a plist to bootstrap from", async () => {
    const exec = (): Promise<ExecResult> => Promise.reject(new Error("must not exec"));
    const r = await launchdManager(exec, 501).start(info({ plistPath: null }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no plist recorded");
  });
});

describe("service matching and safety", () => {
  test("pickServiceManagerKind", () => {
    expect(pickServiceManagerKind(null, "linux")).toBe("systemd");
    expect(pickServiceManagerKind(undefined, "darwin")).toBe("launchd");
    expect(pickServiceManagerKind("launchd", "linux")).toBe("launchd");
    expect(pickServiceManagerKind(null, "win32")).toBeNull();
  });

  test("a default-named unit must run '<role> serve' from this checkout", () => {
    expect(checkServiceMatch(info(), "/srv/llamactl")).toEqual({ problems: [], warnings: [] });
    expect(checkServiceMatch(info(), "/other/checkout").problems[0]).toContain(
      "does not run 'controller serve' from /other/checkout",
    );
    expect(
      checkServiceMatch(
        info({ argv: ["/opt/bun", "/srv/llamactl/packages/cli/src/bin.ts", "agent", "serve"] }),
        "/srv/llamactl",
      ).problems,
    ).toHaveLength(1);
    expect(checkServiceMatch(info({ loaded: false }), "/srv/llamactl").problems).toEqual([
      "llamactl-controller.service is not loaded",
    ]);
  });

  test("an explicitly named unit is trusted with a warning", () => {
    const wrapped = info({
      explicit: true,
      argv: ["/usr/local/bin/llamactl", "controller", "serve"],
    });
    const m = checkServiceMatch(wrapped, "/srv/llamactl");
    expect(m.problems).toEqual([]);
    expect(m.warnings[0]).toContain("trusting it because it was named explicitly");
  });

  test("serviceBun comes from the unit's ExecStart when it runs bin.ts directly", () => {
    expect(serviceBun(info(), "/srv/llamactl")).toBe("/opt/bun");
    expect(
      serviceBun(
        info({ argv: ["/usr/local/bin/llamactl", "controller", "serve"] }),
        "/srv/llamactl",
      ),
    ).toBeNull();
  });

  test("cgroups", () => {
    expect(parseCgroupPath("0::/user.slice/x.service\n")).toBe("/user.slice/x.service");
    expect(parseCgroupPath("12:pids:/a\n1:name=systemd:/user.slice/y.service\n")).toBe(
      "/user.slice/y.service",
    );
    expect(parseCgroupPath("")).toBeNull();
    expect(cgroupWithin("/a/b.service/sub", "/a/b.service")).toBe(true);
    expect(cgroupWithin("/a/b.service2", "/a/b.service")).toBe(false);
    const units = [
      info(),
      info({
        role: "agent",
        name: "llamactl-agent.service",
        cgroup: "/app.slice/llamactl-agent.service",
      }),
    ];
    expect(enclosingService("/app.slice/llamactl-agent.service", units)?.name).toBe(
      "llamactl-agent.service",
    );
    expect(enclosingService("/user.slice/session-2.scope", units)).toBeNull();
    expect(killsChildren(info({ killMode: "control-group" }))).toBe(true);
    expect(killsChildren(info({ killMode: "process" }))).toBe(false);
  });
});

describe("buildInstallCommand", () => {
  const all = (bin: string): string | null => `/usr/bin/${bin}`;

  test("memory-capped scope, high OOM score, heavy-job lock", () => {
    const cmd = buildInstallCommand({
      bun: "/opt/bun",
      platform: "linux",
      which: all,
      heavyLock: "/h/.heavy.lock",
    });
    expect(cmd.argv).toEqual([
      "flock",
      "-w",
      "1800",
      "/h/.heavy.lock",
      "systemd-run",
      "--user",
      "--scope",
      "--collect",
      "-q",
      "-p",
      "MemoryHigh=12G",
      "-p",
      "MemoryMax=16G",
      "-p",
      "MemorySwapMax=1G",
      "--",
      "choom",
      "-n",
      "900",
      "--",
      "/opt/bun",
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ]);
    expect(cmd).toMatchObject({ capped: true, locked: true, warnings: [] });
  });

  test("falls back to a plain install with warnings", () => {
    const noChoom = (bin: string): string | null =>
      bin === "choom" || bin === "flock" ? null : `/usr/bin/${bin}`;
    const cmd = buildInstallCommand({
      bun: "/opt/bun",
      platform: "linux",
      which: noChoom,
      heavyLock: "/h/.heavy.lock",
    });
    expect(cmd.argv).toEqual(["/opt/bun", "install", "--frozen-lockfile", "--ignore-scripts"]);
    expect(cmd.warnings).toHaveLength(2);
    const mac = buildInstallCommand({
      bun: "/opt/bun",
      platform: "darwin",
      which: all,
      heavyLock: null,
    });
    expect(mac).toMatchObject({
      capped: false,
      locked: false,
      argv: ["/opt/bun", "install", "--frozen-lockfile", "--ignore-scripts"],
    });
  });
});
