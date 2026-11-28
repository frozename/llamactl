import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { FsLike, InstallLaunchdDeps } from "../src/commands/agent-install/index.js";

import { buildSystemdUnit } from "../src/commands/agent-install/systemd-template.js";
import {
  parseInstallSystemdFlags,
  runAgentInstallSystemd,
} from "../src/commands/agent-install/systemd.js";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../src/safe-fs.js";

const accessFromDisk: FsLike["accessSync"] = (path, mode) => {
  if (typeof path !== "string" && !(path instanceof URL)) {
    throw new Error("access shim requires string or URL path");
  }
  const p = typeof path === "string" ? path : path.pathname;
  if (!existsSync(p)) throw new Error("ENOENT");
  void mode;
};

interface SpawnCall {
  command: string;
  args: string[];
}

interface SpawnStubConfig {
  responses?: {
    match: (command: string, args: string[]) => boolean;
    response: SpawnSyncReturns<string>;
  }[];
  fallback?: SpawnSyncReturns<string>;
}

function makeSpawnStub(config: SpawnStubConfig): {
  spawn: InstallLaunchdDeps["spawnSync"];
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const queued = (config.responses ?? []).slice();
  const fallback: SpawnSyncReturns<string> = config.fallback ?? {
    pid: 0,
    output: ["", "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
  };
  const spawn: InstallLaunchdDeps["spawnSync"] = (
    command: string,
    args: string[],
    _opts?: SpawnSyncOptionsWithStringEncoding,
  ): SpawnSyncReturns<string> => {
    calls.push({ command, args });
    for (let i = 0; i < queued.length; i++) {
      const entry = queued[i]!;
      if (entry.match(command, args)) {
        queued.splice(i, 1);
        return entry.response;
      }
    }
    return fallback;
  };
  return { spawn, calls };
}

function defaultFs(): FsLike {
  return {
    existsSync,
    mkdirSync,
    writeFileSync: (..._args: Parameters<typeof writeFileSync>): void => {
      /* noop in tests that touch the default fs — override when needed */
    },
    readFileSync,
    chmodSync: (..._args: Parameters<typeof chmodSync>): void => {
      /* noop */
    },
    copyFileSync: (..._args: Parameters<FsLike["copyFileSync"]>): void => {
      /* noop */
    },
    unlinkSync: (..._args: Parameters<FsLike["unlinkSync"]>): void => {
      /* noop */
    },
    statSync,
    accessSync: (..._args: Parameters<FsLike["accessSync"]>): void => {
      /* noop — existence + exec treated as satisfied */
    },
  } as unknown as FsLike;

  function statSync(..._args: Parameters<FsLike["statSync"]>): ReturnType<FsLike["statSync"]> {
    return {
      isFile: () => true,
      isDirectory: () => false,
    } as unknown as ReturnType<FsLike["statSync"]>;
  }
}

function makeTestDeps(over: Partial<InstallLaunchdDeps> = {}): {
  deps: InstallLaunchdDeps;
  stdoutChunks: string[];
  stderrChunks: string[];
} {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const defaults: InstallLaunchdDeps = {
    spawnSync: (_c, _a, _o): SpawnSyncReturns<string> => ({
      pid: 0,
      output: ["", "", ""],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    }),
    fs: defaultFs(),
    fetchAgentRelease: () =>
      Promise.resolve({
        ok: true,
        version: "v1.2.3",
        target: "linux-x64",
        path: "/tmp/fake-release-binary",
        sha256: "deadbeef",
        bytes: 0,
        signature: { verified: null, reason: "skipped" },
      }),
    buildAgentBinary: () =>
      Promise.resolve({ ok: true, outPath: "/tmp/fake-built-binary", code: 0 }),
    stdout: (c) => {
      stdoutChunks.push(c);
    },
    stderr: (c) => {
      stderrChunks.push(c);
    },
    now: Date.now,
    sleep: async () => {
      /* no-op for speed */
    },
    getuid: () => 501,
    platform: "linux",
    env: { HOME: "/home/tester", USER: "tester" },
    ...over,
  };
  return {
    deps: { ...defaults, ...over, env: { ...defaults.env, ...(over.env ?? {}) } },
    stdoutChunks,
    stderrChunks,
  };
}

function okExit(stdout = ""): SpawnSyncReturns<string> {
  return { pid: 0, output: [stdout, "", ""], stdout, stderr: "", status: 0, signal: null };
}

const UNIT_NAME = "llamactl-agent.service";
const CONTROL_GROUP = `/user.slice/user-501.slice/user@501.service/app.slice/${UNIT_NAME}`;
const CGROUP_PROCS_PATH = `/sys/fs/cgroup${CONTROL_GROUP}/cgroup.procs`;
const LOADED_GUARD_SHOW =
  `LoadState=loaded\n` +
  `ActiveState=active\n` +
  `MainPID=1000\n` +
  `ControlGroup=${CONTROL_GROUP}\n`;
function guardShow(opts: { activeState: string; mainPid: number }): string {
  return (
    `LoadState=loaded\n` +
    `ActiveState=${opts.activeState}\n` +
    `MainPID=${String(opts.mainPid)}\n` +
    `ControlGroup=${CONTROL_GROUP}\n`
  );
}
const POLL_SHOW = "ActiveState=active\nMainPID=1000\n";
const GUARD_SHOW_ARGS = [
  "--user",
  "show",
  "-p",
  "LoadState",
  "-p",
  "ActiveState",
  "-p",
  "MainPID",
  "-p",
  "ControlGroup",
  UNIT_NAME,
];

interface InstallFixtureOptions {
  cgroupProcs: string | null;
  guardStdout?: string;
}

interface InstallFixture {
  tmp: string;
  binary: string;
  installPath: string;
  unitPath: string;
  dirArg: string;
  deps: InstallLaunchdDeps;
  spawnCalls: SpawnCall[];
  stdoutChunks: string[];
  stderrChunks: string[];
  counts: {
    unitWrites: number;
    binaryCopies: number;
    cgroupProcsReads: number;
  };
}

type ReadFilePath = Parameters<FsLike["readFileSync"]>[0];

function cgroupReadFileSync(
  cgroupProcs: string | null,
  countRead: () => void,
): FsLike["readFileSync"] {
  const realReadFileSync = readFileSync as unknown as (
    path: ReadFilePath,
    options?: unknown,
  ) => unknown;
  return ((path: ReadFilePath, options?: unknown): unknown => {
    if (String(path) === CGROUP_PROCS_PATH) {
      countRead();
      if (cgroupProcs === null) {
        const error = new Error(
          `ENOENT: no such file or directory, open '${CGROUP_PROCS_PATH}'`,
        ) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return cgroupProcs;
    }
    return realReadFileSync(path, options);
  }) as FsLike["readFileSync"];
}

function makeInstallFixture(opts: InstallFixtureOptions): InstallFixture {
  const tmp = mkdtempSync(join(tmpdir(), "install-systemd-killmode-"));
  const binary = join(tmp, "agent-bin");
  writeFileSync(binary, "#!/bin/sh\necho ok\n", { mode: 0o755 });
  chmodSync(binary, 0o755);
  const installPath = join(tmp, "bin", "llamactl-agent");
  const unitPath = join(tmp, ".config", "systemd", "user", UNIT_NAME);
  const dirArg = join(tmp, "agent");
  const counts = { unitWrites: 0, binaryCopies: 0, cgroupProcsReads: 0 };

  const spawnStub = makeSpawnStub({
    responses: [
      {
        match: (command, args): boolean => command === "systemctl" && args.includes("ControlGroup"),
        response: okExit(opts.guardStdout ?? LOADED_GUARD_SHOW),
      },
      {
        match: (command, args): boolean =>
          command === "systemctl" &&
          args.includes("show") &&
          args.includes("ActiveState") &&
          args.includes("MainPID") &&
          !args.includes("ControlGroup"),
        response: okExit(POLL_SHOW),
      },
      {
        match: (command): boolean => command === "loginctl",
        response: okExit("Linger=yes\n"),
      },
    ],
    fallback: okExit(),
  });

  const fs = {
    ...defaultFs(),
    existsSync,
    mkdirSync,
    chmodSync,
    accessSync: accessFromDisk,
    writeFileSync: (
      file: Parameters<FsLike["writeFileSync"]>[0],
      data: Parameters<FsLike["writeFileSync"]>[1],
      options?: Parameters<FsLike["writeFileSync"]>[2],
    ): void => {
      if (String(file) === unitPath) counts.unitWrites++;
      writeFileSync(file, data, options);
    },
    copyFileSync: (
      src: Parameters<FsLike["copyFileSync"]>[0],
      dest: Parameters<FsLike["copyFileSync"]>[1],
    ): void => {
      const destPath = String(dest);
      if (destPath === installPath) counts.binaryCopies++;
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(src, dest);
    },
    readFileSync: cgroupReadFileSync(opts.cgroupProcs, () => {
      counts.cgroupProcsReads++;
    }),
  };

  const { deps, stdoutChunks, stderrChunks } = makeTestDeps({
    spawnSync: spawnStub.spawn,
    fs,
    getuid: () => 501,
    platform: "linux",
    env: { HOME: tmp, USER: "tester" },
  });

  return {
    tmp,
    binary,
    installPath,
    unitPath,
    dirArg,
    deps,
    spawnCalls: spawnStub.calls,
    stdoutChunks,
    stderrChunks,
    counts,
  };
}

async function withInstallFixture<T>(
  opts: InstallFixtureOptions,
  run: (fixture: InstallFixture) => Promise<T> | T,
): Promise<T> {
  const fixture = makeInstallFixture(opts);
  try {
    return await run(fixture);
  } finally {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
}

function installArgs(fixture: InstallFixture): string[] {
  return [
    `--binary=${fixture.binary}`,
    `--install-path=${fixture.installPath}`,
    `--dir=${fixture.dirArg}`,
  ];
}

function parsedKillMode(parsed: ReturnType<typeof parseInstallSystemdFlags>): unknown {
  if ("error" in parsed) return undefined;
  return (parsed as { killMode?: unknown }).killMode;
}

function mutatingSystemctlCalls(fixture: InstallFixture): SpawnCall[] {
  return fixture.spawnCalls.filter(
    (call) =>
      call.command === "systemctl" &&
      (call.args.includes("daemon-reload") || call.args.includes("restart")),
  );
}

describe("install-systemd KillMode", () => {
  test("buildSystemdUnit honors killMode=mixed for a user unit", () => {
    const unit = buildSystemdUnit({
      scope: "user",
      execPath: "/x",
      args: ["agent", "serve"],
      env: {},
      envFiles: [],
      killMode: "mixed",
    });

    expect(unit).toContain("KillMode=mixed\nOOMScoreAdjust=100\n");
    expect(unit).not.toContain("KillMode=process");
  });

  test("parseInstallSystemdFlags accepts --kill-mode=mixed and defaults to process", () => {
    const mixed = parseInstallSystemdFlags(["--kill-mode=mixed"]);
    expect("error" in mixed).toBe(false);
    if (!("error" in mixed)) expect(parsedKillMode(mixed)).toBe("mixed");

    const defaulted = parseInstallSystemdFlags([]);
    expect("error" in defaulted).toBe(false);
    if (!("error" in defaulted)) expect(parsedKillMode(defaulted)).toBe("process");
  });

  test("parseInstallSystemdFlags rejects an unknown kill mode", () => {
    const parsed = parseInstallSystemdFlags(["--kill-mode=bogus"]);
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) expect(parsed.error).toContain("--kill-mode must be process|mixed");
  });

  test("parseInstallSystemdFlags rejects --kill-mode=mixed with --scope=system", () => {
    const parsed = parseInstallSystemdFlags(["--kill-mode=mixed", "--scope=system"]);
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) {
      expect(parsed.error).toContain("--kill-mode=mixed");
      expect(parsed.error).toContain("--scope=system");
    }
  });

  test("parseInstallSystemdFlags rejects --kill-mode=mixed when engine scopes are off", () => {
    const parsed = parseInstallSystemdFlags([
      "--kill-mode=mixed",
      "--env=LLAMACTL_ENGINE_SCOPE=off",
    ]);
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) expect(parsed.error).toContain("LLAMACTL_ENGINE_SCOPE=off");
  });

  test("dry-run renders KillMode=mixed without spawning systemctl", async () => {
    await withInstallFixture({ cgroupProcs: "1000\n" }, async (fixture) => {
      const code = await runAgentInstallSystemd(
        ["--dry-run", "--kill-mode=mixed", ...installArgs(fixture)],
        fixture.deps,
      );

      expect(code).toBe(0);
      expect(fixture.stdoutChunks.join("")).toContain(
        "KillMode=mixed\nOOMScoreAdjust=100\nRestartSec=10\n",
      );
      expect(fixture.spawnCalls.length).toBe(0);
    });
  });

  test("live mixed install refuses an existing unit cgroup with another pid", async () => {
    await withInstallFixture({ cgroupProcs: "1000\n4242\n" }, async (fixture) => {
      const code = await runAgentInstallSystemd(
        ["--kill-mode=mixed", ...installArgs(fixture)],
        fixture.deps,
      );

      expect(code).toBe(1);
      const stderr = fixture.stderrChunks.join("");
      expect(stderr).toContain("--kill-mode=mixed");
      expect(stderr).toContain("4242");
      expect(stderr).toContain(UNIT_NAME);
      expect(mutatingSystemctlCalls(fixture)).toEqual([]);
      expect(fixture.counts.unitWrites).toBe(0);
      expect(fixture.counts.binaryCopies).toBe(0);
    });
  });

  test("live mixed install refuses when the existing unit cgroup is unreadable", async () => {
    await withInstallFixture({ cgroupProcs: null }, async (fixture) => {
      const code = await runAgentInstallSystemd(
        ["--kill-mode=mixed", ...installArgs(fixture)],
        fixture.deps,
      );

      expect(code).toBe(1);
      expect(fixture.stderrChunks.join("")).toContain("cgroup");
      expect(mutatingSystemctlCalls(fixture)).toEqual([]);
      expect(fixture.counts.unitWrites).toBe(0);
      expect(fixture.counts.binaryCopies).toBe(0);
    });
  });

  test("live mixed install proceeds when the existing unit cgroup holds only MainPID", async () => {
    await withInstallFixture({ cgroupProcs: "1000\n" }, async (fixture) => {
      const code = await runAgentInstallSystemd(
        ["--kill-mode=mixed", ...installArgs(fixture)],
        fixture.deps,
      );

      expect(code).toBe(0);
      expect(readFileSync(fixture.unitPath, "utf8")).toContain("KillMode=mixed");

      const systemctlCalls = fixture.spawnCalls.filter((call) => call.command === "systemctl");
      const guardIndex = systemctlCalls.findIndex((call) => call.args.includes("ControlGroup"));
      expect(guardIndex).toBeGreaterThanOrEqual(0);
      expect(systemctlCalls[guardIndex]?.args).toEqual(GUARD_SHOW_ARGS);
      expect(systemctlCalls[guardIndex + 1]?.args).toEqual(["--user", "daemon-reload"]);
      expect(systemctlCalls[guardIndex + 2]?.args).toEqual(["--user", "enable", UNIT_NAME]);
      expect(systemctlCalls[guardIndex + 3]?.args).toEqual(["--user", "restart", UNIT_NAME]);
    });
  });

  test("live mixed install skips the cgroup read when no existing unit is loaded", async () => {
    await withInstallFixture(
      { cgroupProcs: "1000\n4242\n", guardStdout: "LoadState=not-found\n" },
      async (fixture) => {
        const code = await runAgentInstallSystemd(
          ["--kill-mode=mixed", ...installArgs(fixture)],
          fixture.deps,
        );

        expect(code).toBe(0);
        expect(fixture.counts.cgroupProcsReads).toBe(0);
        expect(readFileSync(fixture.unitPath, "utf8")).toContain("KillMode=mixed");
      },
    );
  });

  test("live mixed install refuses an inactive unit whose cgroup still holds an engine", async () => {
    await withInstallFixture(
      {
        cgroupProcs: "4242\n",
        guardStdout: guardShow({ activeState: "inactive", mainPid: 0 }),
      },
      async (fixture) => {
        const code = await runAgentInstallSystemd(
          ["--kill-mode=mixed", ...installArgs(fixture)],
          fixture.deps,
        );

        expect(code).toBe(1);
        expect(fixture.counts.cgroupProcsReads).toBe(1);
        expect(fixture.stderrChunks.join("")).toContain("4242");
        expect(mutatingSystemctlCalls(fixture)).toEqual([]);
        expect(fixture.counts.unitWrites).toBe(0);
        expect(fixture.counts.binaryCopies).toBe(0);
      },
    );
  });

  test("live mixed install refuses an activating unit with MainPID=0 and a leftover pid", async () => {
    await withInstallFixture(
      {
        cgroupProcs: "4242\n",
        guardStdout: guardShow({ activeState: "activating", mainPid: 0 }),
      },
      async (fixture) => {
        const code = await runAgentInstallSystemd(
          ["--kill-mode=mixed", ...installArgs(fixture)],
          fixture.deps,
        );

        expect(code).toBe(1);
        expect(fixture.counts.cgroupProcsReads).toBe(1);
        expect(fixture.stderrChunks.join("")).toContain("4242");
        expect(mutatingSystemctlCalls(fixture)).toEqual([]);
        expect(fixture.counts.unitWrites).toBe(0);
        expect(fixture.counts.binaryCopies).toBe(0);
      },
    );
  });

  test("live mixed install proceeds for an inactive unit with an empty cgroup", async () => {
    await withInstallFixture(
      { cgroupProcs: "", guardStdout: guardShow({ activeState: "inactive", mainPid: 0 }) },
      async (fixture) => {
        const code = await runAgentInstallSystemd(
          ["--kill-mode=mixed", ...installArgs(fixture)],
          fixture.deps,
        );

        expect(code).toBe(0);
        expect(fixture.counts.cgroupProcsReads).toBe(1);
        expect(readFileSync(fixture.unitPath, "utf8")).toContain("KillMode=mixed");
      },
    );
  });

  test("live mixed install refuses when an --env-file turns engine scopes off", async () => {
    await withInstallFixture({ cgroupProcs: "1000\n" }, async (fixture) => {
      const envFile = join(fixture.tmp, "agent.env");
      writeFileSync(envFile, "# agent env\nexport LLAMACTL_ENGINE_SCOPE=off\n");
      const code = await runAgentInstallSystemd(
        ["--kill-mode=mixed", `--env-file=${envFile}`, ...installArgs(fixture)],
        fixture.deps,
      );

      expect(code).toBe(1);
      const stderr = fixture.stderrChunks.join("");
      expect(stderr).toContain("LLAMACTL_ENGINE_SCOPE=off");
      expect(stderr).toContain(envFile);
      expect(mutatingSystemctlCalls(fixture)).toEqual([]);
      expect(fixture.counts.unitWrites).toBe(0);
      expect(fixture.counts.binaryCopies).toBe(0);
    });
  });

  test("live mixed install proceeds when an --env-file leaves engine scopes on", async () => {
    await withInstallFixture({ cgroupProcs: "1000\n" }, async (fixture) => {
      const envFile = join(fixture.tmp, "agent.env");
      writeFileSync(envFile, "LLAMACTL_ENGINE_SCOPE=on\n");
      const code = await runAgentInstallSystemd(
        ["--kill-mode=mixed", `--env-file=${envFile}`, ...installArgs(fixture)],
        fixture.deps,
      );

      expect(code).toBe(0);
      expect(readFileSync(fixture.unitPath, "utf8")).toContain("KillMode=mixed");
    });
  });

  test("regression pin: a live install without --kill-mode never queries ControlGroup", async () => {
    await withInstallFixture({ cgroupProcs: "1000\n" }, async (fixture) => {
      const code = await runAgentInstallSystemd(installArgs(fixture), fixture.deps);

      expect(code).toBe(0);
      const systemctlCalls = fixture.spawnCalls.filter((call) => call.command === "systemctl");
      expect(systemctlCalls.some((call) => call.args.includes("ControlGroup"))).toBe(false);
      expect(systemctlCalls[0]?.args).toEqual(["--user", "daemon-reload"]);
      expect(readFileSync(fixture.unitPath, "utf8")).toContain("KillMode=process");
    });
  });
});
