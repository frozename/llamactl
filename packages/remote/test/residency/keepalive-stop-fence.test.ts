/**
 * #520 — RED tests for the keepAliveStop stop fence. At the pinned base the
 * `keepAliveStop` procedure calls `stopKeepAlive` directly, so a
 * `llamactl keep-alive stop` sails past the DF-05 lease drain and the
 * session-refcount check that serverStop/modelHostStop already run through
 * `fenceWorkloadStop`: a live session or held lease cannot refuse it, and a
 * verified supervisor stop never commits the unload — the workload stays
 * `open` and keeps admitting requests against a dead engine. Post-fix the
 * procedure routes through `fenceWorkloadStop` with
 * `isVerifiedStop: (r) => r.stopped && r.pid !== null` (a stop that found no
 * supervisor record proves nothing about the workload's server) and a
 * `refuse` that reports `{ stopped: false, pid: null, killed: false,
 * refused }`. Hermetic: temp dirs, a stale pid record whose owner already
 * exited (stopKeepAlive would reap it, so a surviving file proves the stop
 * never ran), and one fake `keep-alive worker` child for the verified path.
 * Every RED case fails BY ASSERTION at base — never by import, type or
 * exit code.
 */
import { createResidencyLeases, setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import {
  createSessionRefcounts,
  type SessionRefcounts,
  setSessionRefcountRegistry,
} from "@llamactl/core/residency/sessions";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { router } from "../../src/router.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

const W = "w1";

type StopRefusal = {
  reason: string;
  active: string[];
};

type KeepAliveStopOutcome = {
  stopped: boolean;
  pid: number | null;
  killed: boolean;
  refused?: StopRefusal;
};

type KeepAliveCaller = {
  keepAliveStop: (input: {
    workload: string;
    graceSeconds?: number;
  }) => Promise<KeepAliveStopOutcome>;
};

const originalEnv = { ...process.env };
let tmp = "";
let runtimeDir = "";

// Fake supervisors left running by the verified-stop test. Killed before the
// temp runtime dir is torn down so a failed assertion cannot leak a Bun
// child across iterations.
const fakeSupervisorPids = new Set<number>();

function killFakeSupervisors(): void {
  for (const pid of fakeSupervisorPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone or not ours to signal; nothing to clean.
    }
  }
  fakeSupervisorPids.clear();
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-keepalive-stop-fence-"));
  runtimeDir = join(tmp, "dev", "ai-models", "local-ai");
  mkdirSync(runtimeDir, { recursive: true });
  Object.assign(process.env, {
    DEV_STORAGE: join(tmp, "dev"),
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
    LLAMACTL_WORKLOADS_DIR: tmp,
  });
});

afterEach(() => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  killFakeSupervisors();
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

function keepAliveStopCaller(): KeepAliveCaller {
  return router.createCaller({});
}

function keepAlivePidFile(): string {
  return join(runtimeDir, "llama-keep-alive.pid");
}

// The recorded pid belongs to a child that already exited: stopKeepAlive
// reads the record as dead/reused, unlinks it and reports
// `{ stopped: true, pid: null, killed: false }` — so the file surviving a
// keepAliveStop call proves stopKeepAlive never ran (a fence refusal).
function writeStaleRecord(): void {
  const dead = Bun.spawnSync(["true"]);
  writeFileSync(keepAlivePidFile(), `${String(dead.pid)}\n`);
}

function psPath(): string {
  for (const candidate of ["/bin/ps", "/usr/bin/ps"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "ps";
}

function psCommand(pid: number): string | null {
  try {
    return execFileSync(psPath(), ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    });
  } catch {
    return null;
  }
}

// The fake supervisor's argv must be visible to ps — and match
// KEEPALIVE_EXPECTATION — before the pid record is written, or the first
// identity check inside stopKeepAlive can race the exec and read "unknown".
async function waitForWorkerArgv(pid: number, timeoutMs = 3_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let command = psCommand(pid);
  while (Date.now() < deadline) {
    if (command?.includes("keep-alive worker") === true) return command;
    await new Promise((r) => setTimeout(r, 50));
    command = psCommand(pid);
  }
  return command?.includes("keep-alive worker") === true ? command : null;
}

describe("keepAliveStop lease + session fence (#520)", () => {
  test("R1: an idle-bound session refuses the stop as SessionsActive", async () => {
    // Kills: keepAliveStop calling stopKeepAlive without fenceWorkloadStop —
    // at base the stale record is reaped ({stopped:true}) and the pid file is
    // gone; and a fence that releases sessions instead of refusing.
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const sessions = createSessionRefcounts({ idleTimeoutMs: 60_000 });
    setSessionRefcountRegistry(sessions);
    const acquired = sessions.acquire("s1", W);
    if (!acquired.ok) {
      throw new Error("expected session acquire to succeed");
    }
    sessions.release("s1", acquired.generation);
    writeStaleRecord();

    const result = await keepAliveStopCaller().keepAliveStop({ workload: W });

    expect(result).toEqual({
      stopped: false,
      pid: null,
      killed: false,
      refused: { reason: "SessionsActive", active: ["s1"] },
    });
    expect(existsSync(keepAlivePidFile())).toBe(true);
    expect(reg.snapshot(W).phase).toBe("open");
    expect(sessions.activeSessions(W)).toEqual(["s1"]);
  });

  test("R2: a throwing session registry refuses the stop as SessionsUnknown", async () => {
    // Kills: dropping the throwing-registry branch or letting it fail open —
    // at base stopKeepAlive runs, reaps the stale record and returns
    // {stopped:true} with the file gone; and a fence that stops anyway.
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const sessions: SessionRefcounts = {
      acquire: () => ({ ok: true, workload: W, refs: 1, generation: 1 }),
      release: () => undefined,
      touch: () => undefined,
      forceRelease: () => [],
      activeSessions: () => [],
      checkUnload: () => {
        throw new Error("boom");
      },
    };
    setSessionRefcountRegistry(sessions);
    writeStaleRecord();

    const result = await keepAliveStopCaller().keepAliveStop({ workload: W });

    expect(result).toEqual({
      stopped: false,
      pid: null,
      killed: false,
      refused: { reason: "SessionsUnknown", active: [] },
    });
    expect(existsSync(keepAlivePidFile())).toBe(true);
    expect(reg.snapshot(W).phase).toBe("open");
  });

  test("R3: a held lease refuses the stop as LeasesActive", async () => {
    // Kills: fencing sessions only — a held DF-05 lease must refuse before
    // any session check or stop runs; at base the stop reaps the stale
    // record and reports {stopped:true}.
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const acquired = reg.acquire(W);
    if (!acquired.ok) {
      throw new Error("expected lease acquire to succeed");
    }
    const lease = acquired.lease;
    writeStaleRecord();

    const result = await keepAliveStopCaller().keepAliveStop({ workload: W });

    expect(result).toEqual({
      stopped: false,
      pid: null,
      killed: false,
      refused: { reason: "LeasesActive", active: [lease.id] },
    });
    expect(lease.signal.aborted).toBe(false);
    expect(existsSync(keepAlivePidFile())).toBe(true);
    expect(reg.snapshot(W).phase).toBe("open");
  });

  test("R7: a verified supervisor stop commits the unload", async () => {
    // Kills: no fence around keepAliveStop (the workload stays open and keeps
    // admitting requests against the dead engine), an isVerifiedStop of
    // `() => false` or `r => !r.stopped`, and a dropped commitUnload — any of
    // those leaves a stopped workload open.
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);

    const script = join(tmp, "fake-supervisor.ts");
    writeFileSync(script, "setInterval(() => {}, 1000);\n");
    const child = Bun.spawn([process.execPath, script, "keep-alive", "worker", W], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    fakeSupervisorPids.add(child.pid);

    expect(await waitForWorkerArgv(child.pid)).not.toBeNull();
    // Written after the spawn so the record mtime postdates process start —
    // the pid-identity check then reads the child as "alive", not "reused".
    writeFileSync(keepAlivePidFile(), `${String(child.pid)}\n`);

    const result = await keepAliveStopCaller().keepAliveStop({ workload: W, graceSeconds: 1 });

    expect(result.stopped).toBe(true);
    expect(result.pid).toBe(child.pid);
    expect(result.refused).toBeUndefined();
    expect(reg.snapshot(W).phase).toBe("unloaded");
    expect(existsSync(keepAlivePidFile())).toBe(false);
  }, 15_000);

  test("G1: no registries installed leaves the unfenced path untouched", async () => {
    // GUARD — passes at base and post-fix: pins that the unfenced path is
    // byte-identical and that the stale-record observable works (a dead pid
    // record is reaped and reported stopped).
    writeStaleRecord();

    const result = await keepAliveStopCaller().keepAliveStop({ workload: W });

    expect(result).toEqual({ stopped: true, pid: null, killed: false });
    expect(existsSync(keepAlivePidFile())).toBe(false);
  });

  test("G2: a stop that found no supervisor record does not commit the unload", async () => {
    // GUARD — passes at base: pins the verified-stop contract the fix must
    // keep — `stopped: true` with `pid: null` means no live record was found,
    // which says nothing about the workload's server, so the drain must be
    // cancelled (phase stays open) and admission must keep working. Kills an
    // isVerifiedStop of `r => r.stopped`, which would commitUnload a workload
    // whose keep-alive never touched.
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    writeStaleRecord();

    const result = await keepAliveStopCaller().keepAliveStop({ workload: W });

    expect(result).toEqual({ stopped: true, pid: null, killed: false });
    expect(reg.snapshot(W).phase).toBe("open");
    expect(reg.acquire(W).ok).toBe(true);
  });
});
