// #806 phase 3: systemd user-scope helpers — argv/naming (T1), the launcher
// capability resolve (T2), and the exec handshake + outcome classification (T3).
// Fakes are test-owned bash processes under a temp dir; the real systemd-run is
// never run and every wait is bounded.

import type { ChildProcess } from "node:child_process";

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  awaitScopeExec,
  buildScopeArgv,
  classifyScopeExit,
  createEngineScopeLauncher,
  isScopeFallback,
  isScopeUnit,
  readScopePending,
  removeScopePendingIfOwned,
  scopeMarkerSeen,
  type ScopeOutcome,
  scopeUnitBase,
  shapeScopeEnv,
  writeScopePending,
} from "../../src/engines/scope.js";
import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "../../src/safe-fs.js";

const BASE = "llamactl-engine-fake-000000000000";
const MARKER = `Running scope as unit: ${BASE}.scope`;

const ownedChildren: ChildProcess[] = [];

afterAll(() => {
  for (const child of ownedChildren) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
});

describe("T1 argv and naming", () => {
  const argv = buildScopeArgv("llamactl-engine-gufo-0123456789ab", "gufo", "/opt/llama-server", [
    "-m",
    "/m/$HOME.gguf",
    "--alias",
    "x",
    "-ngl",
    "99",
  ]);
  const dashDash = argv.indexOf("--");

  test("the pre-`--` tokens are exactly the scope prefix", () => {
    expect(argv.slice(0, dashDash)).toEqual([
      "--user",
      "--scope",
      "--unit=llamactl-engine-gufo-0123456789ab",
      "--description=llamactl engine gufo",
      "--collect",
      "--slice=llamactl-engines.slice",
      "--expand-environment=no",
    ]);
  });

  test("no forbidden systemd-run token appears before `--`", () => {
    const forbidden = [
      "--quiet",
      "-q",
      "-E",
      "--setenv",
      "-p",
      "--property",
      "--pty",
      "--pipe",
      "--wait",
      "--service-type",
      "--remain-after-exit",
      "--no-block",
    ];
    const before = argv.slice(0, dashDash);
    for (const token of forbidden) {
      expect(before).not.toContain(token);
    }
  });

  test("the tail after `--` is verbatim, including the literal `$`", () => {
    expect(argv.slice(dashDash)).toEqual([
      "--",
      "/opt/llama-server",
      "-m",
      "/m/$HOME.gguf",
      "--alias",
      "x",
      "-ngl",
      "99",
    ]);
  });

  test("two default suffixes differ and are 12 hex chars", () => {
    const launcher = createEngineScopeLauncher({});
    const a = launcher.unitSuffix();
    const b = launcher.unitSuffix();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(b).toMatch(/^[0-9a-f]{12}$/);
  });

  test("isScopeUnit accepts a real unit and rejects malformed names", () => {
    expect(isScopeUnit(scopeUnitBase("gufo", "0123456789ab") + ".scope")).toBe(true);
    expect(isScopeUnit("llamactl-engine-gufo")).toBe(false);
    expect(isScopeUnit("x/y")).toBe(false);
    expect(isScopeUnit("a b")).toBe(false);
  });

  test("scopeUnitBase sanitizes mixed input and truncates the workload to 63 chars", () => {
    const suffix = "0123456789ab";
    expect(scopeUnitBase("Gufo.Q4/x y", suffix)).toBe(`llamactl-engine-gufo_q4_x_y-${suffix}`);
    const truncated = scopeUnitBase("A".repeat(70), suffix);
    expect(truncated).toBe(`llamactl-engine-${"a".repeat(63)}-${suffix}`);
    expect(isScopeUnit(`${truncated}.scope`)).toBe(true);
  });
});

describe("scope env shaping", () => {
  test("strips every SYSTEMD_* key and JOURNAL_STREAM, then adds agent bus keys", () => {
    const shaped = shapeScopeEnv(
      {
        JOURNAL_STREAM: "8:123",
        SYSTEMD_COLORS: "1",
        SYSTEMD_LOG_LEVEL: "debug",
        PATH: "/usr/bin:/bin",
      },
      {
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      },
      [],
    );
    expect(shaped).toEqual({
      env: {
        PATH: "/usr/bin:/bin",
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      },
    });
  });

  test("a declared SYSTEMD_* key is an env conflict", () => {
    expect(shapeScopeEnv({}, {}, ["SYSTEMD_FOO"])).toEqual({ conflict: "SYSTEMD_FOO" });
  });
});

function goodDeps(overrides: {
  runProbe?: (
    path: string,
    argv: string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<{ code: number; stderr: string }>;
  now?: () => number;
  exists?: (path: string) => boolean;
}): {
  calls: number[];
  argvs: string[][];
  launcher: ReturnType<typeof createEngineScopeLauncher>;
  now: () => number;
} {
  const argvs: string[][] = [];
  const calls: number[] = [];
  const nowState = { value: 1_000_000 };
  const launcher = createEngineScopeLauncher({
    platform: () => "linux",
    isSocket: (p) => p === "/run/user/1000/bus",
    exists:
      overrides.exists ??
      ((p: string): boolean => p === "/usr/bin/systemd-run" || p === "/usr/bin/true"),
    runProbe:
      overrides.runProbe ??
      ((_path: string, probeArgv: string[]): Promise<{ code: number; stderr: string }> => {
        argvs.push([...probeArgv]);
        calls.push(1);
        return Promise.resolve({
          code: 0,
          stderr: "Running scope as unit: llamactl-probe-abcdef012345.scope\n",
        });
      }),
    now: overrides.now ?? ((): number => nowState.value),
    unitSuffix: () => "abcdef012345",
  });
  return { calls, argvs, launcher, now: overrides.now ?? ((): number => nowState.value) };
}

const GOOD_ENV: NodeJS.ProcessEnv = { XDG_RUNTIME_DIR: "/run/user/1000", PATH: "/usr/bin:/bin" };

describe("T2 launcher resolve", () => {
  test("a non-linux platform gives not-linux", async () => {
    const launcher = createEngineScopeLauncher({ platform: () => "darwin" });
    expect(await launcher.resolve(GOOD_ENV)).toEqual({ ok: false, reason: "not-linux" });
  });

  test("an unset XDG_RUNTIME_DIR gives no-runtime-dir", async () => {
    const launcher = createEngineScopeLauncher({ platform: () => "linux" });
    expect(await launcher.resolve({ PATH: "/bin" })).toEqual({
      ok: false,
      reason: "no-runtime-dir",
    });
  });

  test("a relative XDG_RUNTIME_DIR gives no-runtime-dir", async () => {
    const launcher = createEngineScopeLauncher({ platform: () => "linux" });
    expect(await launcher.resolve({ XDG_RUNTIME_DIR: "run/user/1000", PATH: "/bin" })).toEqual({
      ok: false,
      reason: "no-runtime-dir",
    });
  });

  test("a bus path that is not a socket gives no-user-bus", async () => {
    const launcher = createEngineScopeLauncher({
      platform: () => "linux",
      isSocket: () => false,
    });
    expect(await launcher.resolve(GOOD_ENV)).toEqual({ ok: false, reason: "no-user-bus" });
  });

  test("neither systemd-run path existing gives no-systemd-run", async () => {
    const launcher = createEngineScopeLauncher({
      platform: () => "linux",
      isSocket: (p) => p === "/run/user/1000/bus",
      exists: () => false,
    });
    expect(await launcher.resolve(GOOD_ENV)).toEqual({ ok: false, reason: "no-systemd-run" });
  });

  test("a probe that prints no marker gives probe-failed", async () => {
    const { launcher } = goodDeps({
      runProbe: (): Promise<{ code: number; stderr: string }> =>
        Promise.resolve({ code: 0, stderr: "" }),
    });
    expect(await launcher.resolve(GOOD_ENV)).toEqual({ ok: false, reason: "probe-failed" });
  });

  test("noteFailure then resolve inside the TTL gives recent-pre-exec-failure", async () => {
    const { launcher } = goodDeps({});
    expect(await launcher.resolve(GOOD_ENV)).toEqual({
      ok: true,
      systemdRunPath: "/usr/bin/systemd-run",
    });
    launcher.noteFailure();
    expect(await launcher.resolve(GOOD_ENV)).toEqual({
      ok: false,
      reason: "recent-pre-exec-failure",
    });
  });

  test("all good resolves ok and memoizes the probe across two resolves", async () => {
    let nowValue = 1_000_000;
    let calls = 0;
    const launcher = createEngineScopeLauncher({
      platform: () => "linux",
      isSocket: (p) => p === "/run/user/1000/bus",
      exists: (p) => p === "/usr/bin/systemd-run" || p === "/usr/bin/true",
      runProbe: (): Promise<{ code: number; stderr: string }> => {
        calls += 1;
        return Promise.resolve({
          code: 0,
          stderr: "Running scope as unit: llamactl-probe-abcdef012345.scope\n",
        });
      },
      now: () => nowValue,
      unitSuffix: () => "abcdef012345",
    });
    expect(await launcher.resolve(GOOD_ENV)).toEqual({
      ok: true,
      systemdRunPath: "/usr/bin/systemd-run",
    });
    expect(await launcher.resolve(GOOD_ENV)).toEqual({
      ok: true,
      systemdRunPath: "/usr/bin/systemd-run",
    });
    expect(calls).toBe(1);
    nowValue += 600_001;
    await launcher.resolve(GOOD_ENV);
    expect(calls).toBe(2);
  });

  test("the probe argv reuses the scope prefix with a llamactl-probe- unit", async () => {
    const { argvs, launcher } = goodDeps({});
    await launcher.resolve(GOOD_ENV);
    const probeArgv = argvs[0] ?? [];
    const dash = probeArgv.indexOf("--");
    expect(dash).toBeGreaterThan(0);
    expect(probeArgv.slice(0, dash)).toEqual([
      "--user",
      "--scope",
      "--unit=llamactl-probe-abcdef012345",
      "--description=llamactl engine probe",
      "--collect",
      "--slice=llamactl-engines.slice",
      "--expand-environment=no",
    ]);
    expect(probeArgv.slice(dash + 1)).toEqual(["/usr/bin/true"]);
  });
});

const tmpRoot = mkdtempSync(join(tmpdir(), "llamactl-scope-"));

function spawnFake(script: string): { child: ChildProcess; logPath: string; pid: number } {
  const logPath = join(tmpRoot, `log-${Math.random().toString(16).slice(2)}.txt`);
  const fd = openSync(logPath, "a");
  const child = spawn("/bin/bash", ["-c", script], {
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  closeSync(fd);
  ownedChildren.push(child);
  const pid = child.pid ?? -1;
  return { child, logPath, pid };
}

describe("scopeMarkerSeen", () => {
  test("matches a prefixed line after the offset, not another nonce or an earlier marker", () => {
    const logPath = join(tmpRoot, "marker-prefixed.log");
    const before = `${MARKER}\n`;
    writeFileSync(logPath, before);
    const offset = Buffer.byteLength(before);
    expect(scopeMarkerSeen(logPath, offset, BASE)).toBe(false);

    appendFileSync(logPath, `12:00:00 run.c:42 ${MARKER}\n`);
    expect(scopeMarkerSeen(logPath, offset, BASE)).toBe(true);

    const otherPath = join(tmpRoot, "marker-other-nonce.log");
    appendFileSync(
      otherPath,
      "12:00:00 run.c:42 Running scope as unit: llamactl-engine-fake-111111111111.scope\n",
    );
    expect(scopeMarkerSeen(otherPath, 0, BASE)).toBe(false);
  });
});

describe("scope pending ownership", () => {
  test("removeScopePendingIfOwned leaves another pid's pending record in place", () => {
    const unit = "llamactl-engine-owner-0123456789ab.scope";
    writeScopePending(tmpRoot, "llama-server", 2222, unit);
    removeScopePendingIfOwned(tmpRoot, "llama-server", 1111);
    expect(readScopePending(tmpRoot, "llama-server")).toEqual({ pid: 2222, scopeUnit: unit });
    removeScopePendingIfOwned(tmpRoot, "llama-server", 2222);
    expect(readScopePending(tmpRoot, "llama-server")).toBeNull();
  });
});

describe("T3 classifyScopeExit table", () => {
  test("marker present means the engine exited", () => {
    expect(classifyScopeExit(true, 2, null)).toEqual({
      kind: "engine-exited",
      code: 2,
      signal: null,
    });
  });

  test("no marker, nonzero exit is pre-exec-failed", () => {
    expect(classifyScopeExit(false, 1, null)).toEqual({ kind: "pre-exec-failed", code: 1 });
  });

  test("no marker, signalled is signalled-pre-exec", () => {
    expect(classifyScopeExit(false, null, "SIGKILL")).toEqual({
      kind: "signalled-pre-exec",
      signal: "SIGKILL",
    });
  });

  test("no marker, clean exit is engine-exited", () => {
    expect(classifyScopeExit(false, 0, null)).toEqual({
      kind: "engine-exited",
      code: 0,
      signal: null,
    });
  });

  test("isScopeFallback is true only for pre-exec-failed and hung-killed", () => {
    const kinds: ScopeOutcome["kind"][] = [
      "established",
      "engine-exited",
      "pre-exec-failed",
      "signalled-pre-exec",
      "hung-killed",
      "engine-killed",
      "hung-unreaped",
      "aborted",
    ];
    const outcomeFor = (kind: ScopeOutcome["kind"]): ScopeOutcome => {
      switch (kind) {
        case "engine-exited":
          return { kind, code: 1, signal: null };
        case "pre-exec-failed":
          return { kind, code: 1 };
        case "signalled-pre-exec":
          return { kind, signal: "SIGKILL" };
        case "established":
          return { kind };
        case "hung-killed":
          return { kind };
        case "engine-killed":
          return { kind };
        case "hung-unreaped":
          return { kind };
        case "aborted":
          return { kind };
      }
    };
    for (const kind of kinds) {
      const expected = kind === "pre-exec-failed" || kind === "hung-killed";
      expect(isScopeFallback(outcomeFor(kind))).toBe(expected);
    }
  });
});

describe("T3 awaitScopeExec handshake", () => {
  test("a marker seen while alive is established", async () => {
    const { child, logPath, pid } = spawnFake(`echo ${MARKER} >&2; exec sleep 30`);
    const outcome = await awaitScopeExec({
      child,
      pid,
      logPath,
      offset: 0,
      base: BASE,
      timeoutMs: 4000,
    });
    expect(outcome.kind).toBe("established");
  });

  test("a collision unit exits pre-exec with code 1", async () => {
    const { child, logPath, pid } = spawnFake(
      `echo "Failed to start transient scope unit: Unit ${BASE}.scope was already loaded or has a fragment file." >&2; exit 1`,
    );
    const outcome = await awaitScopeExec({
      child,
      pid,
      logPath,
      offset: 0,
      base: BASE,
      timeoutMs: 4000,
    });
    expect(outcome).toEqual({ kind: "pre-exec-failed", code: 1 });
  });

  test("marker then exit 2 with a slow poll classifies engine-exited", async () => {
    const { child, logPath, pid } = spawnFake(`sleep 0.1; echo ${MARKER} >&2; exit 2`);
    const outcome = await awaitScopeExec({
      child,
      pid,
      logPath,
      offset: 0,
      base: BASE,
      timeoutMs: 4000,
      pollMs: 500,
    });
    expect(outcome).toEqual({ kind: "engine-exited", code: 2, signal: null });
  });

  test("a hang is killed and reported hung-killed with the pid dead", async () => {
    const { child, logPath, pid } = spawnFake("while :; do sleep 0.05; done");
    const outcome = await awaitScopeExec({
      child,
      pid,
      logPath,
      offset: 0,
      base: BASE,
      timeoutMs: 200,
      killWaitMs: 1500,
    });
    expect(outcome.kind).toBe("hung-killed");
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  test("an external SIGKILL before exec is signalled-pre-exec", async () => {
    const { child, logPath, pid } = spawnFake("while :; do sleep 0.05; done");
    const killer = setTimeout(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }, 100);
    const outcome = await awaitScopeExec({
      child,
      pid,
      logPath,
      offset: 0,
      base: BASE,
      timeoutMs: 4000,
    });
    clearTimeout(killer);
    expect(outcome).toEqual({ kind: "signalled-pre-exec", signal: "SIGKILL" });
  });

  test("an abort mid-handshake is aborted and the child is dead", async () => {
    const { child, logPath, pid } = spawnFake("exec sleep 30");
    const controller = new AbortController();
    const aborter = setTimeout(() => {
      controller.abort();
    }, 50);
    const outcome = await awaitScopeExec({
      child,
      pid,
      logPath,
      offset: 0,
      base: BASE,
      timeoutMs: 4000,
      killWaitMs: 1500,
      signal: controller.signal,
    });
    clearTimeout(aborter);
    expect(outcome.kind).toBe("aborted");
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});
