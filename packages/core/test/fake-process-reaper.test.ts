import { afterAll, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "../src/safe-fs.js";
import { reapFakeProcesses } from "./fake-process-reaper.js";

type PsRow = { pid: number; pgid: number; stat: string; command: string };

function scanProcesses(): PsRow[] {
  const res = spawnSync("ps", ["-A", "-ww", "-o", "pid=,pgid=,stat=,command="], {
    encoding: "utf8",
  });
  if (res.status !== 0 || res.stdout.trim() === "") {
    throw new Error(`ps scan failed: status=${String(res.status)} stderr=${res.stderr.trim()}`);
  }
  const rows: PsRow[] = [];
  for (const line of res.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*/.exec(line);
    if (m === null) continue;
    const stat = m[3] ?? "";
    if (stat.startsWith("Z")) continue;
    rows.push({
      pid: Number(m[1]),
      pgid: Number(m[2]),
      stat,
      command: line.slice(m[0].length),
    });
  }
  return rows;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function recordedPgids(scratch: string): Set<number> {
  const pgids = new Set<number>();
  for (const sub of ["a", "b"]) {
    const pgidFile = join(scratch, sub, "pgid");
    if (!existsSync(pgidFile)) continue;
    const n = Number(readFileSync(pgidFile, "utf8").trim());
    if (Number.isFinite(n)) pgids.add(n);
  }
  return pgids;
}

function isSurvivor(row: PsRow, scratch: string, pgids: ReadonlySet<number>): boolean {
  return row.pid !== process.pid && (row.command.includes(scratch) || pgids.has(row.pgid));
}

function sigkill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Best-effort teardown; the process may already be gone.
  }
}

function cleanupScratch(scratch: string): void {
  for (const sub of ["a", "b"]) {
    const pgidFile = join(scratch, sub, "pgid");
    if (!existsSync(pgidFile)) continue;
    const pgid = Number(readFileSync(pgidFile, "utf8").trim());
    if (Number.isFinite(pgid)) sigkill(-pgid);
  }
  let rows: PsRow[] = [];
  try {
    rows = scanProcesses();
  } catch {
    rows = [];
  }
  for (const row of rows) {
    if (row.command.includes(scratch)) {
      sigkill(row.pid);
      sigkill(-row.pgid);
    }
  }
  rmSync(scratch, { recursive: true, force: true });
}

const scratchDirs: string[] = [];

afterAll(() => {
  for (const scratch of scratchDirs) cleanupScratch(scratch);
});

// SIG_IGN is inherited through exec, so the fake's bun process and its
// background `sleep` (same pgid, argv carries no scratch path) both need
// SIGKILL plus a group kill to reap.
const FAKE_ENGINE = `#!/bin/bash
trap '' TERM
sleep 600 &
exec -a llama-server "${process.execPath}" -e "process.on('SIGTERM',()=>{});await new Promise(()=>{});" "$1"
`;

function innerTestSource(scratch: string): string {
  const helperPath = join(import.meta.dir, "fake-process-reaper.ts");
  return `import { afterAll, afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRATCH = ${JSON.stringify(scratch)};
const mod = await import(${JSON.stringify(helperPath)}).catch(() => null);

type PsRow = { pid: number; pgid: number; stat: string; command: string };

function scanProcesses(): PsRow[] {
  const res = spawnSync("ps", ["-A", "-ww", "-o", "pid=,pgid=,stat=,command="], {
    encoding: "utf8",
  });
  if (res.status !== 0 || res.stdout.trim() === "") {
    throw new Error("ps scan failed: status=" + String(res.status));
  }
  const rows: PsRow[] = [];
  for (const line of res.stdout.split("\\n")) {
    const m = /^\\s*(\\d+)\\s+(\\d+)\\s+(\\S+)\\s*/.exec(line);
    if (m === null) continue;
    const stat = m[3] ?? "";
    if (stat.startsWith("Z")) continue;
    rows.push({
      pid: Number(m[1]),
      pgid: Number(m[2]),
      stat,
      command: line.slice(m[0].length),
    });
  }
  return rows;
}

function recordedPgids(): Set<number> {
  const pgids = new Set<number>();
  for (const sub of ["a", "b"]) {
    const pgidFile = join(SCRATCH, sub, "pgid");
    if (!existsSync(pgidFile)) continue;
    const n = Number(readFileSync(pgidFile, "utf8").trim());
    if (Number.isFinite(n)) pgids.add(n);
  }
  return pgids;
}

let current = "";

async function spawnFake(dir: string): Promise<void> {
  const child = spawn(join(SCRATCH, "bin", "fake-engine"), [join(dir, "model.gguf")], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  writeFileSync(join(dir, "pgid"), String(child.pid));
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
}

afterEach(async () => {
  if (mod) await mod.reapFakeProcesses({ scratch: current });
}, 10000);

afterAll(async () => {
  const pgids = recordedPgids();
  const leaks = scanProcesses().filter(
    (row) =>
      pgids.has(row.pgid) ||
      row.command.includes(join(SCRATCH, "a")) ||
      row.command.includes(join(SCRATCH, "b")),
  );
  writeFileSync(
    join(SCRATCH, "after-each-ok"),
    leaks.length === 0 ? "ok" : "leak:" + JSON.stringify(leaks),
  );
  if (mod) await mod.reapFakeProcesses({ scratch: SCRATCH });
}, 10000);

test("fails", async () => {
  const dir = join(SCRATCH, "a");
  mkdirSync(dir, { recursive: true });
  current = dir;
  await spawnFake(dir);
  expect(1).toBe(2);
});

test(
  "times out",
  async () => {
    const dir = join(SCRATCH, "b");
    mkdirSync(dir, { recursive: true });
    current = dir;
    await spawnFake(dir);
    await new Promise(() => {});
  },
  500,
);
`;
}

test("a fake spawned through the helper does not survive a failing or timed-out test (#627)", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "llamactl-reaper-guard-"));
  scratchDirs.push(scratch);
  const binDir = join(scratch, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "fake-engine"), FAKE_ENGINE, { mode: 0o755 });
  writeFileSync(join(scratch, "inner.test.ts"), innerTestSource(scratch));

  const run = spawnSync(process.execPath, ["test", join(scratch, "inner.test.ts")], {
    cwd: scratch,
    encoding: "utf8",
    timeout: 25000,
  });
  expect(run.status).not.toBe(0);
  expect(existsSync(join(scratch, "a", "pgid"))).toBe(true);
  expect(existsSync(join(scratch, "b", "pgid"))).toBe(true);
  expect(readFileSync(join(scratch, "after-each-ok"), "utf8")).toBe("ok");

  const pgids = recordedPgids(scratch);
  const deadline = Date.now() + 3000;
  let survivors = scanProcesses().filter((row) => isSurvivor(row, scratch, pgids));
  while (survivors.length > 0 && Date.now() < deadline) {
    await sleep(50);
    survivors = scanProcesses().filter((row) => isSurvivor(row, scratch, pgids));
  }
  expect(survivors).toEqual([]);
}, 30000);

test("every fake-engine spawn site reaps through the shared helper (#627)", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const spawnSites = [
    "packages/remote/test/server/modelhost-residency-guard.test.ts",
    "packages/remote/test/workload/modelhost-libosmos.test.ts",
    "packages/cli/test/controller-e2e.test.ts",
    "packages/cli/test/expose-e2e.test.ts",
    "packages/cli/test/workload-e2e.test.ts",
    "packages/core/test/rpcServer.test.ts",
    "packages/remote/test/cluster-serverstart.test.ts",
    "packages/remote/test/reconcile-dead-pid.test.ts",
  ];
  const missing = spawnSites.filter(
    (file) => !readFileSync(join(repoRoot, file), "utf8").includes("reapFakeProcesses("),
  );
  expect(missing).toEqual([]);
});

// ---------------------------------------------------------------------------
// Identity guards (#627 review). Every process below is a throwaway `sleep`
// this file spawns itself and tracks; each test kills what it spawned in a
// finally block, and afterAll sweeps anything a failed assertion left.
// ---------------------------------------------------------------------------

const HELPER_PATH = join(import.meta.dir, "fake-process-reaper.ts");
const ENGINE_SLEEP = "exec -a llama-server sleep 600";
const ownedPids = new Set<number>();
const ownedGroups = new Set<number>();

afterAll(() => {
  for (const pgid of ownedGroups) sigkill(-pgid);
  for (const pid of ownedPids) sigkill(pid);
});

function rowOf(pid: number): PsRow | undefined {
  return scanProcesses().find((row) => row.pid === pid);
}

function isLive(pid: number): boolean {
  return rowOf(pid) !== undefined;
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(25);
  }
}

function track(child: ChildProcess, detached: boolean): number {
  const pid = child.pid;
  if (pid === undefined) throw new Error("spawn returned no pid");
  ownedPids.add(pid);
  if (detached) ownedGroups.add(pid);
  return pid;
}

/** Spawn `bash -c script` and wait until its row shows `argv0`. */
async function spawnShell(script: string, detached: boolean, argv0: string): Promise<number> {
  const child = spawn("bash", ["-c", script], { detached, stdio: "ignore" });
  if (detached) child.unref();
  const pid = track(child, detached);
  await waitFor(() => (rowOf(pid)?.command ?? "").split(/\s/)[0]?.endsWith(argv0) === true);
  return pid;
}

function killOwned(...pids: number[]): void {
  for (const pid of pids) {
    if (ownedGroups.has(pid)) sigkill(-pid);
    sigkill(pid);
  }
}

function newScratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function writePidFile(dir: string, pid: number, mtimeSec?: number): string {
  const file = join(dir, "engine.pid");
  writeFileSync(file, String(pid));
  if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

/** Run a fresh bun process that loads the reaper and reaps `opts`; returns its stdout. */
function reapInFreshRunner(scratch: string, opts: object): { status: number | null; out: string } {
  const script = join(scratch, `reap-${String(Date.now())}.ts`);
  writeFileSync(
    script,
    `const { reapFakeProcesses } = await import(${JSON.stringify(HELPER_PATH)});
const survivors = await reapFakeProcesses(${JSON.stringify(opts)});
process.stdout.write(JSON.stringify(survivors));
`,
  );
  const run = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 15000 });
  return { status: run.status, out: run.stdout };
}

test("a pidfile naming a live non-fake process outside scratch is not signalled", async () => {
  const scratch = newScratch("llamactl-reaper-nonfake-");
  const pid = await spawnShell("exec /bin/sleep 600", true, "sleep");
  try {
    const pidFile = writePidFile(scratch, pid);
    const survivors = await reapFakeProcesses({
      scratch,
      pidFiles: [pidFile],
      graceMs: 200,
      timeoutMs: 500,
    });
    expect(survivors).toEqual([]);
    expect(isLive(pid)).toBe(true);
  } finally {
    killOwned(pid);
  }
});

test("a pidfile written before an engine-named process took its pid is not signalled", async () => {
  const scratch = newScratch("llamactl-reaper-reuse-");
  const pid = await spawnShell(ENGINE_SLEEP, true, "llama-server");
  try {
    // The record predates the holder's start by an hour: a recycled pid.
    const pidFile = writePidFile(scratch, pid, Math.floor(Date.now() / 1000) - 3600);
    const survivors = await reapFakeProcesses({
      scratch,
      pidFiles: [pidFile],
      graceMs: 200,
      timeoutMs: 500,
    });
    expect(survivors).toEqual([]);
    expect(isLive(pid)).toBe(true);
  } finally {
    killOwned(pid);
  }
});

test("a pidfile naming a fake whose argv carries no scratch path is reaped by argv0", async () => {
  const scratch = newScratch("llamactl-reaper-argv0-");
  const pid = await spawnShell(ENGINE_SLEEP, true, "llama-server");
  try {
    expect(rowOf(pid)?.command.includes(scratch)).toBe(false);
    const pidFile = writePidFile(scratch, pid);
    const survivors = await reapFakeProcesses({ scratch, pidFiles: [pidFile] });
    expect(survivors).toEqual([]);
    expect(isLive(pid)).toBe(false);
  } finally {
    killOwned(pid);
  }
});

test("a target in the runner's own group is killed alone and the group is never signalled", async () => {
  const ownPgid = rowOf(process.pid)?.pgid;
  const target = await spawnShell(ENGINE_SLEEP, false, "llama-server");
  const sibling = await spawnShell("exec /bin/sleep 600", false, "sleep");
  try {
    expect(rowOf(target)?.pgid).toBe(ownPgid);
    expect(rowOf(sibling)?.pgid).toBe(ownPgid);
    const survivors = await reapFakeProcesses({ pids: [target] });
    expect(survivors).toEqual([]);
    expect(isLive(target)).toBe(false);
    expect(isLive(sibling)).toBe(true);
    expect(isLive(process.pid)).toBe(true);
  } finally {
    killOwned(target, sibling);
  }
});

test("a target that does not lead its group is killed alone and its group leader survives", async () => {
  // The leader becomes a plain sleep; the engine-named child shares its group.
  const child = spawn("bash", ["-c", `${ENGINE_SLEEP} & echo $!; exec /bin/sleep 600`], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  child.unref();
  const leader = track(child, true);
  try {
    const first = await new Promise<string>((resolve) => {
      child.stdout.once("data", (chunk: Buffer) => {
        resolve(chunk.toString("utf8"));
      });
    });
    child.stdout.destroy();
    const target = Number.parseInt(first.trim(), 10);
    ownedPids.add(target);
    await waitFor(() => (rowOf(target)?.command ?? "").startsWith("llama-server"));
    await waitFor(() => (rowOf(leader)?.command ?? "").startsWith("/bin/sleep"));
    expect(rowOf(target)?.pgid).toBe(leader);
    const survivors = await reapFakeProcesses({ pids: [target] });
    expect(survivors).toEqual([]);
    expect(isLive(target)).toBe(false);
    expect(isLive(leader)).toBe(true);
  } finally {
    killOwned(leader);
  }
});

test("a verified target leading the runner's own group never takes that group down", async () => {
  // The runner here is a bun process whose group is led by an engine-named
  // bash recorded in a fresh pidfile: a verified target with pgid === pid
  // that is also the runner's own group.
  const scratch = newScratch("llamactl-reaper-owngroup-");
  const pidFile = join(scratch, "leader.pid");
  const script = join(scratch, "reap-own-group.ts");
  writeFileSync(
    script,
    `const { reapFakeProcesses } = await import(${JSON.stringify(HELPER_PATH)});
const survivors = await reapFakeProcesses({ pidFiles: [${JSON.stringify(pidFile)}] });
process.stdout.write("survivors=" + JSON.stringify(survivors));
`,
  );
  const inner = `"${process.execPath}" "${script}"; echo`;
  const child = spawn(
    "bash",
    ["-c", `echo $$ > "${pidFile}"; exec -a llama-server bash -c '${inner}'`],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  child.unref();
  const leader = track(child, true);
  try {
    const out = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => {
        reject(new Error(`inner runner timed out: ${buf}`));
      }, 15000);
      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
      });
      child.stdout.on("close", () => {
        clearTimeout(timer);
        resolve(buf);
      });
    });
    expect(out.trim()).toBe("survivors=[]");
    expect(isLive(leader)).toBe(false);
  } finally {
    killOwned(leader);
  }
}, 20000);

test("reapFakeProcesses waits until a TERM-ignoring fake is gone before resolving", async () => {
  const pid = await spawnShell(`trap '' TERM; ${ENGINE_SLEEP}`, true, "llama-server");
  try {
    const survivors = await reapFakeProcesses({ pids: [pid], graceMs: 100, timeoutMs: 2000 });
    // Either it is gone by the time the promise resolves, or it is reported.
    expect(survivors.includes(pid) || !isLive(pid)).toBe(true);
    expect(survivors).toEqual([]);
    expect(isLive(pid)).toBe(false);
  } finally {
    killOwned(pid);
  }
});

test("an explicit pid that started before the reaper module loaded is not signalled", async () => {
  const scratch = newScratch("llamactl-reaper-preexisting-");
  const pid = await spawnShell(ENGINE_SLEEP, true, "llama-server");
  try {
    // ps etime has one-second resolution: leave a clear margin before the
    // fresh runner loads the module.
    await sleep(2200);
    const run = reapInFreshRunner(scratch, { pids: [pid], graceMs: 200, timeoutMs: 500 });
    expect(run.status).toBe(0);
    expect(run.out).toBe("[]");
    expect(isLive(pid)).toBe(true);
  } finally {
    killOwned(pid);
  }
}, 20000);

test("an explicit pid matching neither a needle nor an engine argv0 is not signalled", async () => {
  const scratch = newScratch("llamactl-reaper-unrelated-");
  const pid = await spawnShell("exec /bin/sleep 600", true, "sleep");
  try {
    const survivors = await reapFakeProcesses({
      scratch,
      pids: [pid],
      graceMs: 200,
      timeoutMs: 500,
    });
    expect(survivors).toEqual([]);
    expect(isLive(pid)).toBe(true);
  } finally {
    killOwned(pid);
  }
});

test("an explicit pid that already exited and an unset scratch are a no-op", async () => {
  const pid = await spawnShell(ENGINE_SLEEP, true, "llama-server");
  killOwned(pid);
  await waitFor(() => !isLive(pid));
  expect(await reapFakeProcesses({ scratch: undefined, pids: [pid] })).toEqual([]);
  expect(await reapFakeProcesses({ scratch: [""] })).toEqual([]);
});
