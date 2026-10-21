import { describe, expect, test } from "bun:test";

import type { ExecResult } from "../src/commands/update/deps.js";

import { buildInstallCommand } from "../src/commands/update/procedure.js";
import {
  cgroupWithin,
  checkServiceMatch,
  enclosingService,
  expandSpecifiers,
  killModeProblem,
  killsChildren,
  launchdManager,
  parseCgroupPath,
  parseEnvFile,
  parseEnvironmentAssignments,
  parseEnvironmentFileProp,
  parseExecStartArgv,
  parseLaunchctlPrint,
  parseShowList,
  parseSystemctlShow,
  parseUnitStandardOutput,
  pickServiceManagerKind,
  readCgroupProcs,
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
    cgroupProcs: null,
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

  test("systemctl cat: the last StandardOutput= wins, an empty one resets", () => {
    const text = [
      "# /home/u/.config/systemd/user/llamactl-controller.service",
      "[Service]",
      "StandardOutput=journal",
      "",
      "# /home/u/.config/systemd/user/llamactl-controller.service.d/override.conf",
      "[Service]",
      "StandardOutput=append:%h/state/logs/llamactl-controller.log",
    ].join("\n");
    expect(parseUnitStandardOutput(text)).toBe("append:%h/state/logs/llamactl-controller.log");
    expect(parseUnitStandardOutput("StandardOutput=file:/a\nStandardOutput=")).toBeNull();
    expect(parseUnitStandardOutput("[Service]\nType=simple")).toBeNull();
  });

  test("systemctl show lists and EnvironmentFiles values (systemd 255 format)", () => {
    const show = [
      'Environment=A=1 "B=two words"',
      "EnvironmentFiles=/srv/llamactl.env (ignore_errors=no)",
      "EnvironmentFiles=/srv/optional.env (ignore_errors=yes)",
    ].join("\n");
    expect(parseShowList(show, "EnvironmentFiles").map(parseEnvironmentFileProp)).toEqual([
      { path: "/srv/llamactl.env", optional: false },
      { path: "/srv/optional.env", optional: true },
    ]);
    expect(parseShowList("Environment=\n", "Environment")).toEqual([]);
  });

  test("specifiers in a StandardOutput= path", () => {
    const spec = { h: "/home/u", U: "1000", t: "/run/user/1000" };
    expect(expandSpecifiers("%h/logs/c.log", spec)).toBe("/home/u/logs/c.log");
    expect(expandSpecifiers("%t/c-%U.log", spec)).toBe("/run/user/1000/c-1000.log");
    expect(expandSpecifiers("/l/100%%.log", spec)).toBe("/l/100%.log");
    expect(expandSpecifiers("/l/%N.log", spec)).toBeNull();
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
  test("describe reads state, argv, cgroup, KillMode, env and the stdout file", async () => {
    const calls: string[][] = [];
    const exec = (argv: readonly string[]): Promise<ExecResult> => {
      calls.push([...argv]);
      if (argv[2] === "show") {
        const show = `${SHOW}\nEnvironment=X=1 HOME_LOG=/home/u/l\nEnvironmentFiles=/srv/llamactl.env (ignore_errors=no)`;
        return Promise.resolve({ code: 0, stdout: show, stderr: "" });
      }
      if (argv[2] === "cat") {
        return Promise.resolve({
          code: 0,
          stdout: "[Service]\nEnvironment=IGNORED=1\nStandardOutput=append:%h/c.log\n",
          stderr: "",
        });
      }
      return Promise.resolve({ code: 1, stdout: "", stderr: "" });
    };
    const cg =
      "/user.slice/user-1000.slice/user@1000.service/app.slice/llamactl-controller.service";
    const files = new Map([
      ["/srv/llamactl.env", "DEV_STORAGE=/srv/state\nX=0\n"],
      [`/sys/fs/cgroup${cg}/cgroup.procs`, "2077114\n2039339\n"],
    ]);
    const mgr = systemdManager(exec, (p) => files.get(p) ?? null, { h: "/home/u" });
    const svc = await mgr.describe("controller", "llamactl-controller.service", false);
    expect(svc).toMatchObject({
      loaded: true,
      active: true,
      pid: 2077114,
      killMode: "process",
      cgroupProcs: [2077114, 2039339],
      // EnvironmentFile= overrides Environment=, as systemd applies them.
      env: { DEV_STORAGE: "/srv/state", X: "0", HOME_LOG: "/home/u/l" },
      stdoutPath: "/home/u/c.log",
      journal: false,
    });
    expect(svc.env["IGNORED"]).toBeUndefined();
    expect(calls[0]?.slice(0, 4)).toEqual([
      "systemctl",
      "--user",
      "show",
      "llamactl-controller.service",
    ]);
    expect(calls[0]).toContain("EnvironmentFiles");
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
    expect(killsChildren(info({ killMode: "mixed" }))).toBe(true);
    expect(killsChildren(info({ killMode: "process" }))).toBe(false);
  });

  test("KillMode guard reads the unit's cgroup.procs", () => {
    const files = new Map([["/sys/fs/cgroup/app.slice/c.service/cgroup.procs", "1\n77\n\n"]]);
    expect(readCgroupProcs("/app.slice/c.service", (p) => files.get(p) ?? null)).toEqual([1, 77]);
    expect(readCgroupProcs("/app.slice/x.service", () => null)).toBeNull();
    expect(readCgroupProcs(null, () => "1")).toBeNull();
    const cg = { pid: 1, cgroupProcs: [1, 77, 78] };
    expect(killModeProblem(info({ ...cg, killMode: "control-group" }))).toContain(
      "KillMode=control-group and 2 other process(es) in its cgroup (pid 77, 78)",
    );
    expect(killModeProblem(info({ ...cg, killMode: "mixed" }))).toContain("KillMode=mixed");
    expect(killModeProblem(info({ ...cg, killMode: "process" }))).toBeNull();
    expect(
      killModeProblem(info({ pid: 1, cgroupProcs: [1], killMode: "control-group" })),
    ).toBeNull();
    expect(
      killModeProblem(info({ pid: 1, cgroupProcs: null, killMode: "control-group" })),
    ).toBeNull();
  });
});

describe("buildInstallCommand", () => {
  const all = (bin: string): string | null => `/usr/bin/${bin}`;

  test("memory-capped scope at a high OOM score; the lock is not part of it", () => {
    const cmd = buildInstallCommand({ bun: "/opt/bun", platform: "linux", which: all });
    expect(cmd.argv).toEqual([
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
    expect(cmd).toMatchObject({ capped: true, warnings: [] });
    expect(cmd.argv).not.toContain("flock");
  });

  test("falls back to a plain install with a warning", () => {
    const noChoom = (bin: string): string | null => (bin === "choom" ? null : `/usr/bin/${bin}`);
    const cmd = buildInstallCommand({ bun: "/opt/bun", platform: "linux", which: noChoom });
    expect(cmd.argv).toEqual(["/opt/bun", "install", "--frozen-lockfile", "--ignore-scripts"]);
    expect(cmd.warnings).toHaveLength(1);
    const mac = buildInstallCommand({ bun: "/opt/bun", platform: "darwin", which: all });
    expect(mac).toMatchObject({
      capped: false,
      argv: ["/opt/bun", "install", "--frozen-lockfile", "--ignore-scripts"],
    });
  });
});
