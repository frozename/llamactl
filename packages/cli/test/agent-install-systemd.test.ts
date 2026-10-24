import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FsLike, InstallLaunchdDeps } from "../src/commands/agent-install/index.js";

import { buildSystemdUnit } from "../src/commands/agent-install/systemd-template.js";
import {
  INSTALL_SYSTEMD_USAGE,
  parseInstallSystemdFlags,
  runAgentInstallSystemd,
} from "../src/commands/agent-install/systemd.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../src/safe-fs.js";

// ------------------------------------------------------------------
// Shared fs-shim helpers, mirroring agent-install-launchd.test.ts.
// The shims wrap the real node:fs functions so production code paths
// reach disk in tests where that matters (binary copy + unit write),
// and no-op otherwise. HOME always points into a fresh mkdtemp so
// nothing lands under the real home dir, and systemctl/loginctl are
// always stubbed.
// ------------------------------------------------------------------

const accessFromDisk: FsLike["accessSync"] = (path, mode) => {
  if (typeof path !== "string" && !(path instanceof URL)) {
    throw new Error("access shim requires string or URL path");
  }
  const p = typeof path === "string" ? path : path.pathname;
  if (!existsSync(p)) throw new Error("ENOENT");
  void mode;
};

const writeFileFromDisk: FsLike["writeFileSync"] = (file, data): void => {
  writeFileSync(file, data);
};

const copyFileThrough: FsLike["copyFileSync"] = (src, dest): void => {
  mkdirSync(join(dest as string, ".."), { recursive: true });
  writeFileSync(dest, readFileSync(src));
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
    // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
    fetchAgentRelease: async () => ({
      ok: true,
      version: "v1.2.3",
      target: "linux-x64",
      path: "/tmp/fake-release-binary",
      sha256: "deadbeef",
      bytes: 0,
      signature: { verified: null, reason: "skipped" },
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
    buildAgentBinary: async () => ({ ok: true, outPath: "/tmp/fake-built-binary", code: 0 }),
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

function failExit(stderr: string): SpawnSyncReturns<string> {
  return { pid: 0, output: ["", "", stderr], stdout: "", stderr, status: 1, signal: null };
}

const UNIT_NAME = "llamactl-agent.service";

// -----------------------------------------------------------------------------
// Pure unit template
// -----------------------------------------------------------------------------

describe("buildSystemdUnit", () => {
  test("user scope: full exact shape, no network-online.target, no WorkingDirectory", () => {
    const unit = buildSystemdUnit({
      scope: "user",
      execPath: "/home/tester/.local/bin/llamactl-agent",
      args: ["agent", "serve", "--dir=/home/tester/agent"],
      env: { PATH: "/usr/bin", DEV_STORAGE: "/srv/ai" },
      envFiles: ["/etc/default/llamactl-agent"],
    });
    expect(unit).toBe(
      [
        "[Unit]",
        "Description=llamactl agent",
        "Documentation=https://github.com/frozename/llamactl",
        "",
        "[Service]",
        "Type=simple",
        "ExecStart=/home/tester/.local/bin/llamactl-agent agent serve --dir=/home/tester/agent",
        "Restart=always",
        "RestartSec=10",
        'Environment="PATH=/usr/bin"',
        'Environment="DEV_STORAGE=/srv/ai"',
        "EnvironmentFile=/etc/default/llamactl-agent",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    );
    expect(unit).not.toContain("network-online.target");
    expect(unit).not.toContain("WorkingDirectory");
    expect(unit).not.toContain("StandardOutput");
  });

  test("system scope: network-online deps, WorkingDirectory, log append, multi-user.target", () => {
    const unit = buildSystemdUnit({
      scope: "system",
      execPath: "/usr/local/bin/llamactl-agent",
      args: ["agent", "serve", "--dir=/var/lib/llamactl"],
      env: {},
      envFiles: [],
      logDir: "/var/log/llamactl-agent",
      workingDir: "/var/lib/llamactl",
    });
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain("Wants=network-online.target");
    expect(unit).toContain("WorkingDirectory=/var/lib/llamactl");
    expect(unit).toContain("StandardOutput=append:/var/log/llamactl-agent/stdout.log");
    expect(unit).toContain("StandardError=append:/var/log/llamactl-agent/stderr.log");
    expect(unit).toContain("WantedBy=multi-user.target");
  });

  test("ExecStart args escape backslash, quote, percent and dollar; quote when needed", () => {
    const unit = buildSystemdUnit({
      scope: "user",
      execPath: "/opt/bin/llamactl-agent",
      args: [
        "plain",
        "with space",
        'has"quote',
        "back\\slash",
        "100%",
        "cost$5",
        "semi;colon",
        "single'quote",
        "",
      ],
      env: {},
      envFiles: [],
    });
    const execLine = unit.split("\n").find((l) => l.startsWith("ExecStart="));
    expect(execLine).toBe(
      String.raw`ExecStart=/opt/bin/llamactl-agent plain "with space" "has\"quote" "back\\slash" 100%% cost$$5 "semi;colon" "single'quote" ""`,
    );
  });

  test("execPath with a space is quoted like an argument", () => {
    const unit = buildSystemdUnit({
      scope: "user",
      execPath: "/opt/my agent/bin",
      args: [],
      env: {},
      envFiles: [],
    });
    expect(unit).toContain('ExecStart="/opt/my agent/bin"');
  });

  test("Environment values escape backslash, quote and percent but not dollar", () => {
    const unit = buildSystemdUnit({
      scope: "user",
      execPath: "/opt/bin/agent",
      args: [],
      env: { PCT: "50%", DOLLAR: "keep$1this", QUOTE: 'say"hi', BACK: "a\\b" },
      envFiles: [],
    });
    expect(unit).toContain('Environment="PCT=50%%"');
    expect(unit).toContain('Environment="DOLLAR=keep$1this"');
    expect(unit).toContain('Environment="QUOTE=say\\"hi"');
    expect(unit).toContain('Environment="BACK=a\\\\b"');
  });

  test("path directives escape percent", () => {
    const unit = buildSystemdUnit({
      scope: "system",
      execPath: "/opt/bin/agent",
      args: [],
      env: {},
      envFiles: ["/etc/%name%/env"],
      logDir: "/var/log/%unit%",
      workingDir: "/srv/%u",
    });
    expect(unit).toContain("EnvironmentFile=/etc/%%name%%/env");
    expect(unit).toContain("StandardOutput=append:/var/log/%%unit%%/stdout.log");
    expect(unit).toContain("WorkingDirectory=/srv/%%u");
  });

  test("a newline in any value throws", () => {
    expect(() =>
      buildSystemdUnit({
        scope: "user",
        execPath: "/bin/a",
        args: ["a\nb"],
        env: {},
        envFiles: [],
      }),
    ).toThrow(/newline/);
    expect(() =>
      buildSystemdUnit({
        scope: "user",
        execPath: "/bin/a",
        args: [],
        env: { KEY: "v\ralue" },
        envFiles: [],
      }),
    ).toThrow(/newline/);
  });
});

// -----------------------------------------------------------------------------
// Flag parsing
// -----------------------------------------------------------------------------

describe("parseInstallSystemdFlags", () => {
  test("defaults: scope=user, source=from-source, repo, empty envFiles", () => {
    const parsed = parseInstallSystemdFlags([]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.scope).toBe("user");
    expect(parsed.source).toEqual({ kind: "source" });
    expect(parsed.repo).toBe("frozename/llamactl");
    expect(parsed.dryRun).toBe(false);
    expect(parsed.force).toBe(false);
    expect(parsed.bind).toBeUndefined();
    expect(parsed.port).toBeUndefined();
    expect(parsed.envFiles).toEqual([]);
  });

  test("--help yields the __help sentinel", () => {
    expect(parseInstallSystemdFlags(["--help"])).toEqual({ error: "__help" });
    expect(parseInstallSystemdFlags(["-h"])).toEqual({ error: "__help" });
  });

  test("INSTALL_SYSTEMD_USAGE starts with the install-systemd usage line", () => {
    expect(INSTALL_SYSTEMD_USAGE.startsWith("Usage: llamactl agent install-systemd")).toBe(true);
  });

  test("--install-path absolute is accepted", () => {
    const parsed = parseInstallSystemdFlags(["--install-path=/opt/bin/llamactl-agent"]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.installPath).toBe("/opt/bin/llamactl-agent");
  });

  const relativePathCases: [string, string][] = [
    ["--install-path", "relative/agent"],
    ["--dir", "agent-data"],
    ["--log-dir", "logs"],
    ["--env-file", "etc/env"],
  ];
  for (const [flag, value] of relativePathCases) {
    test(`${flag} rejects a relative path`, () => {
      const parsed = parseInstallSystemdFlags([`${flag}=${value}`]);
      expect("error" in parsed).toBe(true);
      if ("error" in parsed) expect(parsed.error).toContain("absolute");
    });
  }

  test("--env-file is repeatable and accumulates in order", () => {
    const parsed = parseInstallSystemdFlags([
      "--env-file=/etc/default/a",
      "--env-file=/etc/default/b",
    ]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.envFiles).toEqual(["/etc/default/a", "/etc/default/b"]);
  });

  for (const bad of ["0", "70000", "abc"]) {
    test(`--port=${bad} is rejected`, () => {
      const parsed = parseInstallSystemdFlags([`--port=${bad}`]);
      expect("error" in parsed).toBe(true);
      if ("error" in parsed) expect(parsed.error).toContain("--port");
    });
  }

  test("--port=7843 is accepted", () => {
    const parsed = parseInstallSystemdFlags(["--port=7843"]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.port).toBe(7843);
  });

  test("--env with an invalid key is rejected", () => {
    const parsed = parseInstallSystemdFlags(["--env=9BAD=x"]);
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) expect(parsed.error).toContain("--env");
  });

  test("--env without = inside value is rejected", () => {
    const parsed = parseInstallSystemdFlags(["--env=KEY_WITHOUT_VALUE"]);
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) expect(parsed.error).toContain("--env must be KEY=VAL");
  });

  test("--env=FOO_BAR=1 is accepted and repeatable", () => {
    const parsed = parseInstallSystemdFlags(["--env=FOO_BAR=1", "--env=HF_HOME=/foo"]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.envOverrides).toEqual({ FOO_BAR: "1", HF_HOME: "/foo" });
  });

  test("mutually exclusive sources rejected", () => {
    const parsed = parseInstallSystemdFlags(["--binary=/tmp/agent", "--from-source"]);
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) expect(parsed.error).toContain("mutually exclusive");
  });

  test("--from-release with empty tag rejected", () => {
    const parsed = parseInstallSystemdFlags(["--from-release="]);
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) expect(parsed.error).toContain("requires a tag");
  });

  test("--scope must be user|system", () => {
    expect("error" in parseInstallSystemdFlags(["--scope=weird"])).toBe(true);
  });

  test("unknown flag rejected", () => {
    const parsed = parseInstallSystemdFlags(["--weird=foo"]);
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) expect(parsed.error).toContain("agent install-systemd:");
  });
});

// -----------------------------------------------------------------------------
// Handler: exit-1 preconditions
// -----------------------------------------------------------------------------

describe("runAgentInstallSystemd preconditions", () => {
  test("--scope=system without root → exit 1 with requires root", async () => {
    const { deps, stderrChunks } = makeTestDeps({ getuid: () => 501, platform: "linux" });
    const code = await runAgentInstallSystemd(["--scope=system"], deps);
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("requires root");
  });

  test("--scope=system non-root with a user-writable install path → exit 1, zero spawns", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-systemd-nonroot-"));
    try {
      const stub = makeSpawnStub({});
      const { deps, stderrChunks } = makeTestDeps({
        getuid: () => 501,
        spawnSync: stub.spawn,
        env: { HOME: tmp, USER: "tester" },
      });
      const code = await runAgentInstallSystemd(
        ["--scope=system", `--install-path=${join(tmp, "bin", "llamactl-agent")}`],
        deps,
      );
      expect(code).toBe(1);
      expect(stderrChunks.join("")).toContain("requires root");
      expect(stub.calls.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("non-linux live run → exit 1 with only-supported-on-Linux", async () => {
    const { deps, stderrChunks } = makeTestDeps({ platform: "darwin" });
    const code = await runAgentInstallSystemd(["--from-source"], deps);
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("only supported on Linux");
  });

  test("existing unit file without --force → exit 1 before any spawn", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-systemd-exists-"));
    try {
      const unitDir = join(tmp, ".config", "systemd", "user");
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(join(unitDir, UNIT_NAME), "# existing\n");

      const stub = makeSpawnStub({});
      const { deps, stderrChunks } = makeTestDeps({
        spawnSync: stub.spawn,
        env: { HOME: tmp, USER: "tester" },
        fs: {
          ...defaultFs(),
          writeFileSync: () => {
            throw new Error("should not write when the unit guard blocks");
          },
        } as unknown as FsLike,
      });

      const code = await runAgentInstallSystemd([`--binary=${join(tmp, "no-such")}`], deps);
      expect(code).toBe(1);
      expect(stderrChunks.join("")).toContain("already exists at");
      expect(stderrChunks.join("")).toContain("pass --force");
      expect(stub.calls.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// Handler: dry-run
// -----------------------------------------------------------------------------

describe("runAgentInstallSystemd --dry-run", () => {
  test("prints the unit + systemctl plan with zero spawns and zero writes", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-systemd-dryrun-"));
    try {
      const binary = join(tmp, "agent-bin");
      writeFileSync(binary, "#!/bin/sh\necho ok\n", { mode: 0o755 });
      chmodSync(binary, 0o755);
      const installPath = join(tmp, "bin", "llamactl-agent");
      const dirArg = join(tmp, "agent");

      let wroteCount = 0;
      const stub = makeSpawnStub({});
      const { deps, stdoutChunks } = makeTestDeps({
        spawnSync: stub.spawn,
        env: { HOME: tmp, USER: "tester" },
        fs: {
          ...defaultFs(),
          existsSync,
          mkdirSync: ((..._args: Parameters<FsLike["mkdirSync"]>): void => {
            wroteCount++;
          }) as FsLike["mkdirSync"],
          chmodSync,
          accessSync: accessFromDisk,
          writeFileSync: () => {
            wroteCount++;
          },
          copyFileSync: () => {
            wroteCount++;
          },
        } as unknown as FsLike,
      });

      const code = await runAgentInstallSystemd(
        [
          "--dry-run",
          `--binary=${binary}`,
          `--install-path=${installPath}`,
          `--dir=${dirArg}`,
          "--bind=0.0.0.0",
          "--port=7843",
        ],
        deps,
      );
      expect(code).toBe(0);
      expect(wroteCount).toBe(0);
      expect(stub.calls.length).toBe(0);

      const out = stdoutChunks.join("");
      expect(out).toContain("[Unit]");
      expect(out).toContain(
        `ExecStart=${installPath} agent serve --dir=${dirArg} --bind=0.0.0.0 --port=7843\n`,
      );
      expect(out).toContain("Restart=always");
      expect(out).toContain("WantedBy=default.target");
      expect(out).toContain(`# unit path: ${join(tmp, ".config", "systemd", "user", UNIT_NAME)}`);
      expect(out).toContain("# systemctl --user daemon-reload");
      expect(out).toContain(`# systemctl --user enable ${UNIT_NAME}`);
      expect(out).toContain(`# systemctl --user restart ${UNIT_NAME}`);
      expect(out).toContain("# loginctl enable-linger tester  (if Linger=no)");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--env value with a newline exits 1 before anything is copied", async () => {
    const stub = makeSpawnStub({});
    let wroteCount = 0;
    const { deps, stderrChunks } = makeTestDeps({
      spawnSync: stub.spawn,
      fs: {
        ...defaultFs(),
        copyFileSync: (..._args: Parameters<FsLike["copyFileSync"]>): void => {
          wroteCount++;
        },
      },
    });
    const code = await runAgentInstallSystemd(["--dry-run", "--env=FOO=a\nb"], deps);
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toContain("newline");
    expect(stub.calls.length).toBe(0);
    expect(wroteCount).toBe(0);
  });

  test("system scope: multi-user.target, WorkingDirectory, /etc unit path, no --user plans", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-systemd-dryrun-system-"));
    try {
      const binary = join(tmp, "agent-bin");
      writeFileSync(binary, "#!/bin/sh\necho ok\n", { mode: 0o755 });
      chmodSync(binary, 0o755);
      const dirArg = join(tmp, "agent");

      let wroteCount = 0;
      const stub = makeSpawnStub({});
      const { deps, stdoutChunks } = makeTestDeps({
        getuid: () => 0,
        spawnSync: stub.spawn,
        env: { HOME: tmp, USER: "tester" },
        fs: {
          ...defaultFs(),
          existsSync,
          mkdirSync: ((..._args: Parameters<FsLike["mkdirSync"]>): void => {
            wroteCount++;
          }) as FsLike["mkdirSync"],
          chmodSync,
          accessSync: accessFromDisk,
          writeFileSync: () => {
            wroteCount++;
          },
          copyFileSync: () => {
            wroteCount++;
          },
        } as unknown as FsLike,
      });

      const code = await runAgentInstallSystemd(
        ["--dry-run", "--scope=system", `--binary=${binary}`, `--dir=${dirArg}`],
        deps,
      );
      expect(code).toBe(0);
      expect(wroteCount).toBe(0);
      expect(stub.calls.length).toBe(0);

      const out = stdoutChunks.join("");
      expect(out).toContain("WantedBy=multi-user.target");
      expect(out).toContain(`WorkingDirectory=${dirArg}`);
      expect(out).toContain(`# unit path: /etc/systemd/system/${UNIT_NAME}`);
      expect(out).toContain("# systemctl daemon-reload");
      expect(out).toContain(`# systemctl enable ${UNIT_NAME}`);
      expect(out).toContain(`# systemctl restart ${UNIT_NAME}`);
      expect(out).not.toContain("# systemctl --user");
      expect(out).not.toContain("loginctl");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// Handler: loopback warning
// -----------------------------------------------------------------------------

describe("runAgentInstallSystemd loopback warning", () => {
  async function stderrForBind(bindArg: string | null): Promise<string> {
    const { deps, stderrChunks } = makeTestDeps();
    const argv = ["--dry-run"];
    if (bindArg !== null) argv.push(bindArg);
    const code = await runAgentInstallSystemd(argv, deps);
    expect(code).toBe(0);
    return stderrChunks.join("");
  }

  test("omitted --bind warns about loopback", async () => {
    expect(await stderrForBind(null)).toContain("loopback");
  });

  test("--bind=127.0.0.1 warns about loopback", async () => {
    expect(await stderrForBind("--bind=127.0.0.1")).toContain("loopback");
  });

  test("--bind=localhost warns about loopback", async () => {
    expect(await stderrForBind("--bind=localhost")).toContain("loopback");
  });

  test("--bind=::1 warns about loopback", async () => {
    expect(await stderrForBind("--bind=::1")).toContain("loopback");
  });

  test("--bind=0.0.0.0 does not warn", async () => {
    expect(await stderrForBind("--bind=0.0.0.0")).not.toContain("loopback");
  });
});

// -----------------------------------------------------------------------------
// Handler: live success + systemctl interactions
// -----------------------------------------------------------------------------

describe("runAgentInstallSystemd live install", () => {
  test("success: unit on disk, systemctl sequence, pid in summary", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-systemd-success-"));
    try {
      const binary = join(tmp, "agent-bin");
      writeFileSync(binary, "#!/bin/sh\necho ok\n", { mode: 0o755 });
      chmodSync(binary, 0o755);
      const installPath = join(tmp, "bin", "llamactl-agent");
      const unitPath = join(tmp, ".config", "systemd", "user", UNIT_NAME);

      const stub = makeSpawnStub({
        // Fallback: systemctl show reports a healthy unit; enable/restart/
        // daemon-reload/loginctl all exit 0.
        fallback: okExit("ActiveState=active\nMainPID=4242\n"),
      });
      const { deps, stdoutChunks } = makeTestDeps({
        spawnSync: stub.spawn,
        env: { HOME: tmp, USER: "tester" },
        fs: {
          ...defaultFs(),
          existsSync,
          mkdirSync,
          chmodSync,
          accessSync: accessFromDisk,
          writeFileSync: writeFileFromDisk,
          copyFileSync: copyFileThrough,
        },
      });

      const code = await runAgentInstallSystemd(
        [
          `--binary=${binary}`,
          `--install-path=${installPath}`,
          `--dir=${join(tmp, "agent")}`,
          `--env=DEV_STORAGE=${join(tmp, "storage")}`,
        ],
        deps,
      );
      expect(code).toBe(0);

      expect(existsSync(unitPath)).toBe(true);
      const unit = readFileSync(unitPath, "utf8");
      expect(unit).toContain(`ExecStart=${installPath} agent serve --dir=${join(tmp, "agent")}`);
      expect(unit).toContain('Environment="DEV_STORAGE=');

      const systemctlCalls = stub.calls.filter((c) => c.command === "systemctl");
      expect(systemctlCalls[0]?.args).toEqual(["--user", "daemon-reload"]);
      expect(systemctlCalls[1]?.args).toEqual(["--user", "enable", UNIT_NAME]);
      expect(systemctlCalls[2]?.args).toEqual(["--user", "restart", UNIT_NAME]);
      expect(systemctlCalls[3]?.args).toEqual([
        "--user",
        "show",
        "-p",
        "ActiveState",
        "-p",
        "MainPID",
        UNIT_NAME,
      ]);

      const out = stdoutChunks.join("");
      expect(out).toContain("Installed:");
      expect(out).toContain(installPath);
      expect(out).toContain(unitPath);
      expect(out).toContain("scope:  user");
      expect(out).toContain("4242");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("Linger=no warns and names loginctl enable-linger", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-systemd-linger-no-"));
    try {
      const stub = makeSpawnStub({
        responses: [
          {
            match: (c): boolean => c === "loginctl",
            response: okExit("Linger=no\n"),
          },
        ],
        fallback: okExit("ActiveState=active\nMainPID=7\n"),
      });
      const { deps, stderrChunks } = makeTestDeps({
        spawnSync: stub.spawn,
        env: { HOME: tmp, USER: "tester" },
        fs: { ...defaultFs(), existsSync, mkdirSync, writeFileSync: writeFileFromDisk },
      });
      const code = await runAgentInstallSystemd([], deps);
      expect(code).toBe(0);
      expect(stderrChunks.join("")).toContain("loginctl enable-linger tester");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("Linger=yes does not warn", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-systemd-linger-yes-"));
    try {
      const stub = makeSpawnStub({
        responses: [
          {
            match: (c): boolean => c === "loginctl",
            response: okExit("Linger=yes\n"),
          },
        ],
        fallback: okExit("ActiveState=active\nMainPID=7\n"),
      });
      const { deps, stderrChunks } = makeTestDeps({
        spawnSync: stub.spawn,
        env: { HOME: tmp, USER: "tester" },
        fs: { ...defaultFs(), existsSync, mkdirSync, writeFileSync: writeFileFromDisk },
      });
      const code = await runAgentInstallSystemd([], deps);
      expect(code).toBe(0);
      expect(stderrChunks.join("")).not.toContain("enable-linger");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("loginctl returning null stdout+status warns without crashing the install", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-systemd-linger-null-"));
    try {
      const brokenLoginctl = {
        pid: 0,
        output: [null, null, null],
        stdout: null,
        stderr: null,
        status: null,
        signal: null,
        error: new Error("spawnSync loginctl ENOENT"),
      } as unknown as SpawnSyncReturns<string>;
      const stub = makeSpawnStub({
        responses: [
          {
            match: (c): boolean => c === "loginctl",
            response: brokenLoginctl,
          },
        ],
        fallback: okExit("ActiveState=active\nMainPID=7\n"),
      });
      const { deps, stdoutChunks, stderrChunks } = makeTestDeps({
        spawnSync: stub.spawn,
        env: { HOME: tmp, USER: "tester" },
        fs: { ...defaultFs(), existsSync, mkdirSync, writeFileSync: writeFileFromDisk },
      });
      const code = await runAgentInstallSystemd([], deps);
      expect(code).toBe(0);
      expect(stdoutChunks.join("")).toContain("Installed:");
      const err = stderrChunks.join("");
      expect(err).toContain("could not check lingering");
      expect(err).toContain("loginctl enable-linger tester");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("systemctl restart failure → exit 1 surfacing its stderr", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-systemd-restartfail-"));
    try {
      const stub = makeSpawnStub({
        responses: [
          {
            match: (c, a): boolean => c === "systemctl" && a.includes("restart"),
            response: failExit("Failed to restart llamactl-agent.service: Permission denied\n"),
          },
        ],
        fallback: okExit("ActiveState=active\nMainPID=7\n"),
      });
      const { deps, stderrChunks } = makeTestDeps({
        spawnSync: stub.spawn,
        env: { HOME: tmp, USER: "tester" },
        fs: { ...defaultFs(), existsSync, mkdirSync, writeFileSync: writeFileFromDisk },
      });
      const code = await runAgentInstallSystemd([], deps);
      expect(code).toBe(1);
      const err = stderrChunks.join("");
      expect(err).toContain("restart");
      expect(err).toContain("Failed to restart");
      // Never polls or touches loginctl after a failed restart.
      expect(stub.calls.some((c) => c.command === "loginctl")).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("poll timeout → exit 1 with the journalctl hint", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-systemd-timeout-"));
    try {
      let ticks = 0;
      const stub = makeSpawnStub({
        fallback: okExit("ActiveState=activating\nMainPID=0\n"),
      });
      const { deps, stderrChunks } = makeTestDeps({
        spawnSync: stub.spawn,
        env: { HOME: tmp, USER: "tester" },
        now: () => {
          ticks += 500;
          return ticks;
        },
        fs: { ...defaultFs(), existsSync, mkdirSync, writeFileSync: writeFileFromDisk },
      });
      const code = await runAgentInstallSystemd([], deps);
      expect(code).toBe(1);
      const err = stderrChunks.join("");
      expect(err).toContain("did not become active");
      expect(err).toContain(`journalctl --user -u ${UNIT_NAME} -n 50`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("poll keeps waiting on ActiveState=active with MainPID=0 → exit 1", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-systemd-zeropid-"));
    try {
      let ticks = 0;
      const stub = makeSpawnStub({
        fallback: okExit("ActiveState=active\nMainPID=0\n"),
      });
      const { deps, stderrChunks, stdoutChunks } = makeTestDeps({
        spawnSync: stub.spawn,
        env: { HOME: tmp, USER: "tester" },
        now: () => {
          ticks += 500;
          return ticks;
        },
        fs: { ...defaultFs(), existsSync, mkdirSync, writeFileSync: writeFileFromDisk },
      });
      const code = await runAgentInstallSystemd([], deps);
      expect(code).toBe(1);
      expect(stderrChunks.join("")).toContain("did not become active");
      expect(stdoutChunks.join("")).not.toContain("Installed:");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("poll: activating then active → success with the delayed pid", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "install-systemd-poll-activate-"));
    try {
      const stub = makeSpawnStub({
        responses: [
          {
            match: (c, a): boolean => c === "systemctl" && a.includes("show"),
            response: okExit("ActiveState=activating\nMainPID=0\n"),
          },
        ],
        fallback: okExit("ActiveState=active\nMainPID=4321\n"),
      });
      const { deps, stdoutChunks } = makeTestDeps({
        spawnSync: stub.spawn,
        env: { HOME: tmp, USER: "tester" },
        fs: { ...defaultFs(), existsSync, mkdirSync, writeFileSync: writeFileFromDisk },
      });
      const code = await runAgentInstallSystemd([], deps);
      expect(code).toBe(0);
      expect(stdoutChunks.join("")).toContain("4321");
      const showCalls = stub.calls.filter(
        (c) => c.command === "systemctl" && c.args.includes("show"),
      );
      expect(showCalls.length).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
