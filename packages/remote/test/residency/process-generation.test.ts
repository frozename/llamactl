import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAdmissionStore } from "../../src/residency/admission-store.js";
import {
  linuxProcessStartTicks,
  openLocalAdmissionRuntime,
} from "../../src/residency/process-generation.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

test("Linux stat start ticks survive spaces and closing parentheses in comm", () => {
  const line = [42, "(job ) worker)", "S", ...Array<string>(18).fill("0"), "15092847", "0"].join(
    " ",
  );
  expect(linuxProcessStartTicks(line, 42)).toBe("15092847");
  expect(linuxProcessStartTicks(line, 43)).toBeUndefined();
  expect(linuxProcessStartTicks("42 (early) S 0 0", 42)).toBeUndefined();
  expect(linuxProcessStartTicks(line.replace("15092847", "not-a-tick"), 42)).toBeUndefined();
});

const nativePlatform = process.platform === "darwin" || process.platform === "linux";

test.skipIf(!nativePlatform)(
  "the local authority retains a live generation and releases it only after exit",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-native-identity-"));
    const child = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], { stdin: "pipe" });
    let trackedPid: number | undefined = child.pid;
    let runtime: Awaited<ReturnType<typeof openLocalAdmissionRuntime>> | undefined;
    try {
      runtime = await openLocalAdmissionRuntime({
        storePath: join(dir, "admission.db"),
        budgetGiB: () => 24,
        readPidFile: () => trackedPid,
      });
      const generation = runtime.capture(child.pid);
      await Bun.sleep(80);
      expect(runtime.capture(child.pid)).toEqual(generation);
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
      expect(stopProof(child.pid + 1)).toMatchObject({
        kind: "retained",
        reason: "pid-record-conflict",
      });
      expect(stopProof(child.pid)).toMatchObject({ kind: "retained", reason: "live-generation" });
      await child.stdin.end();
      expect(await child.exited).toBe(0);
      expect(runtime.capture(child.pid)).toBeUndefined();
      trackedPid = child.pid + 1;
      expect(stopProof(child.pid)).toMatchObject({
        kind: "retained",
        reason: "pid-record-conflict",
      });
      trackedPid = undefined;
      expect(stopProof(child.pid)).toEqual({
        kind: "released",
        claimId,
      });
    } finally {
      runtime?.authority.close();
      await child.stdin.end();
      await child.exited;
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
