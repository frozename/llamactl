import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAdmissionStore } from "../../src/residency/admission-store.js";
import {
  linuxProcessStat,
  observeLocalDetachedGroup,
  openLocalAdmissionRuntime,
} from "../../src/residency/process-generation.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

test("Linux stat reads birth ticks and PGID despite spaces and closing parentheses in comm", () => {
  const line = [
    42,
    "(job ) worker)",
    "S",
    "0",
    "42",
    ...Array<string>(16).fill("0"),
    "15092847",
    "0",
  ].join(" ");
  expect(linuxProcessStat(line, 42)).toEqual({ startTicks: "15092847", processGroupId: 42 });
  expect(linuxProcessStat(line, 43)).toBeUndefined();
  expect(linuxProcessStat("42 (early) S 0 0", 42)).toBeUndefined();
  expect(linuxProcessStat(line.replace("15092847", "not-a-tick"), 42)).toBeUndefined();
});

const nativePlatform = process.platform === "darwin" || process.platform === "linux";

test("a detached group is absent only for ESRCH on the verified negative PGID", () => {
  const pid = 4242;
  const birthId = `${process.platform}:test-birth`;
  const scope = "test-namespace";
  const scoped = { pid, birthId, processGroupScope: scope };
  const probes: [number, number][] = [];
  const absent = (target: number, signal: 0): never => {
    probes.push([target, signal]);
    throw Object.assign(new Error("test group absent"), { code: "ESRCH" });
  };
  const deps = { probe: absent, scope };
  expect(observeLocalDetachedGroup({ pid, birthId }, deps)).toBe("unknown");
  expect(observeLocalDetachedGroup({ ...scoped, processGroupId: pid + 1 }, deps)).toBe("unknown");
  expect(
    observeLocalDetachedGroup(
      { ...scoped, processGroupId: pid },
      {
        ...deps,
        scope: "other-namespace",
      },
    ),
  ).toBe("unknown");
  expect(observeLocalDetachedGroup({ ...scoped, processGroupId: pid }, deps)).toBe("absent");
  expect(probes).toEqual([[-pid, 0]]);
  expect(
    observeLocalDetachedGroup(
      { ...scoped, processGroupId: pid },
      {
        scope,
        probe: () => {
          throw Object.assign(new Error("test group inaccessible"), { code: "EPERM" });
        },
      },
    ),
  ).toBe("unknown");
});

test.skipIf(!nativePlatform)(
  "the local ledger retains a detached group after its leader exits",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-native-detached-group-"));
    const finish = join(dir, "finish");
    const finished = join(dir, "finished");
    const leader = spawn(
      "/bin/sh",
      [
        "-c",
        '(while [ -d "$3" ] && [ ! -e "$1" ]; do sleep 0.02; done; [ ! -d "$3" ] || : > "$2") & printf "ready\\n"; read -r done || true',
        "group-fixture",
        finish,
        finished,
        dir,
      ],
      { detached: true, stdio: ["pipe", "pipe", "ignore"] },
    );
    const ready = new Promise<void>((resolve) => {
      leader.stdout.once("data", () => {
        resolve();
      });
    });
    const exited = new Promise<number | null>((resolve) => leader.once("exit", resolve));
    const pid = leader.pid;
    let runtime: Awaited<ReturnType<typeof openLocalAdmissionRuntime>> | undefined;
    try {
      await ready;
      if (pid === undefined) throw new Error("fixture leader pid is missing");
      const opts = {
        storePath: join(dir, "admission.db"),
        budgetGiB: (): number => 8,
        readPidFile: (): number => pid,
      };
      runtime = await openLocalAdmissionRuntime(opts);
      const generation = runtime.capture(pid);
      if (generation?.birthId === undefined) throw new Error("fixture generation is missing");
      const result = runtime.authority.admit({
        runtimeKey: "group",
        kind: "ModelHost",
        specDigest: "fixture",
        allocationGiB: 8,
      });
      if (result.kind !== "admitted") throw new Error("fixture admission refused");
      expect(
        runtime.authority.recordGeneration(result.claimId, result.fenceToken, generation),
      ).toBe(true);
      expect(runtime.authority.completeReady(result.claimId, result.fenceToken)).toBe(true);
      const proof = runtime.authority.prepareStopRelease("group", "ModelHost");
      expect(proof?.verifyGeneration(pid)).toBe("alive");

      leader.stdin.end();
      expect(await exited).toBe(0);
      expect(runtime.capture(pid)).toBeUndefined();
      expect(runtime.authority.tryRelease(result.claimId)).toMatchObject({
        kind: "retained",
        reason: "live-detached-group",
      });
      expect(proof?.verifyGeneration(pid)).toBe("unknown");
      expect(proof?.release(pid)).toMatchObject({
        kind: "retained",
        reason: "live-detached-group",
      });
      runtime.authority.close();
      runtime = await openLocalAdmissionRuntime(opts);
      expect(runtime.authority.snapshot()).toMatchObject([
        {
          allocationGiB: 8,
          generations: [{ processGroupId: pid, processGroupScope: generation.processGroupScope }],
        },
      ]);
      expect(runtime.authority.tryRelease(result.claimId)).toMatchObject({
        kind: "retained",
        reason: "live-detached-group",
      });
    } finally {
      runtime?.authority.close();
      leader.stdin.end();
      writeFileSync(finish, "");
      await exited;
      for (let i = 0; i < 100 && !existsSync(finished); i += 1) await Bun.sleep(10);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!nativePlatform)(
  "the local authority retains a live generation and releases it only after exit",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-native-identity-"));
    const child = spawn(process.execPath, ["-e", "await Bun.stdin.text()"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const pid = child.pid;
    let trackedPid = pid;
    let runtime: Awaited<ReturnType<typeof openLocalAdmissionRuntime>> | undefined;
    try {
      if (pid === undefined) throw new Error("fixture pid is missing");
      runtime = await openLocalAdmissionRuntime({
        storePath: join(dir, "admission.db"),
        budgetGiB: () => 24,
        readPidFile: () => trackedPid,
      });
      const generation = runtime.capture(pid);
      await Bun.sleep(80);
      expect(runtime.capture(pid)).toEqual(generation);
      expect(generation?.birthId).toMatch(/^(linux|darwin):/);
      if (generation?.birthId === undefined) throw new Error("fixture generation is unavailable");
      const result = runtime.authority.admit({
        runtimeKey: "fixture",
        kind: "ModelRun",
        specDigest: "test",
        allocationGiB: 8,
      });
      if (result.kind !== "admitted") throw new Error(`fixture claim was ${result.kind}`);
      const { claimId, fenceToken } = result;
      expect(runtime.authority.recordGeneration(claimId, fenceToken, generation)).toBe(true);
      expect(runtime.authority.completeReady(claimId, fenceToken)).toBe(true);
      expect(runtime.authority.tryRelease(claimId)).toEqual({
        kind: "retained",
        claimId,
        reason: "live-generation",
      });
      const stopProof = runtime.authority.prepareStopRelease("fixture", "ModelRun");
      expect(runtime.authority.prepareStopRelease("fixture", "ModelHost")).toBeUndefined();
      if (stopProof === undefined) throw new Error("fixture stop is missing required evidence");
      expect(stopProof.verifyGeneration(pid)).toBe("alive");
      expect(stopProof.release(pid + 1)).toMatchObject({
        kind: "retained",
        reason: "pid-record-conflict",
      });
      expect(stopProof.release(pid)).toMatchObject({
        kind: "retained",
        reason: "live-generation",
      });
      child.stdin.end();
      expect(await exited).toBe(0);
      expect(runtime.capture(pid)).toBeUndefined();
      expect(stopProof.verifyGeneration(pid)).toBe("dead");
      trackedPid = pid + 1;
      expect(stopProof.release(pid)).toMatchObject({
        kind: "retained",
        reason: "pid-record-conflict",
      });
      trackedPid = undefined;
      expect(stopProof.release(pid)).toEqual({
        kind: "released",
        claimId,
      });
    } finally {
      runtime?.authority.close();
      child.stdin.end();
      await exited;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!nativePlatform)(
  "the local authority recovers an exited owner and keeps its incomplete claim charged",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-native-owner-"));
    const child = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], { stdin: "pipe" });
    const opts = {
      storePath: join(dir, "owned.db"),
      budgetGiB: (): number => 8,
      readPidFile: (): undefined => undefined,
    };
    let runtime: Awaited<ReturnType<typeof openLocalAdmissionRuntime>> | undefined;
    try {
      runtime = await openLocalAdmissionRuntime({ ...opts, storePath: join(dir, "probe.db") });
      const owner = runtime.capture(child.pid);
      if (owner?.birthId === undefined) throw new Error("fixture owner is unavailable");
      const initial = openAdmissionStore({ path: opts.storePath, owner });
      try {
        const admitted = initial.claim({
          runtimeKey: "incomplete",
          specDigest: "test",
          allocationGiB: 8,
          budgetGiB: 8,
        });
        expect(admitted.kind).toBe("admitted");
        expect(initial.recordedOwner()).toEqual(owner);
      } finally {
        initial.close();
      }

      const request = { runtimeKey: "retry", specDigest: "test", allocationGiB: 1 };
      const whileAlive = await openLocalAdmissionRuntime(opts);
      try {
        expect(whileAlive.authority.admit(request)).toMatchObject({
          kind: "refuse",
          reason: "AuthorityUnavailable",
        });
      } finally {
        whileAlive.authority.close();
      }

      await child.stdin.end();
      expect(await child.exited).toBe(0);
      const afterExit = await openLocalAdmissionRuntime(opts);
      try {
        expect(afterExit.authority.snapshot()).toMatchObject([
          { runtimeKey: "incomplete", state: "uncertain", allocationGiB: 8 },
        ]);
        expect(afterExit.authority.admit(request)).toMatchObject({
          kind: "refuse",
          reason: "BudgetExceeded",
        });
      } finally {
        afterExit.authority.close();
      }
    } finally {
      runtime?.authority.close();
      await child.stdin.end();
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
