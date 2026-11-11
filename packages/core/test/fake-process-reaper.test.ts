import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../src/safe-fs.js";

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
