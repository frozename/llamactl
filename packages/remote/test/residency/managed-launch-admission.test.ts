import { expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AdmissionAuthority,
  openAdmissionAuthority,
} from "../../src/residency/admission-authority.js";
import {
  type CommitLaunchReadiness,
  createManagedLaunchAdmission,
  type ManagedLaunchRequest,
} from "../../src/residency/managed-launch-admission.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

const request: ManagedLaunchRequest = { kind: "ModelRun", runtimeKey: "alpha", launch: {} };
const signal = new AbortController().signal;
const generation = { pid: 2468, startTimeMs: 101 };
const ready = { ran: true as const, result: { ok: true, pid: generation.pid } };

function simulateRuntimeReady(commitReadiness: CommitLaunchReadiness): Promise<{
  readonly ran: true;
  result: { ok: boolean; pid: number; error?: string };
}> {
  const error = commitReadiness(generation.pid);
  return Promise.resolve(
    error === undefined ? ready : { ran: true, result: { ...ready.result, ok: false, error } },
  );
}

function fixture(): {
  authority: AdmissionAuthority;
  resolve: () => { specDigest: string; allocationGiB: number };
  [Symbol.dispose](): void;
} {
  const dir = mkdtempSync(join(tmpdir(), "managed-launch-"));
  const authority = openAdmissionAuthority({
    storePath: join(dir, "admission.db"),
    budgetGiB: () => 24,
    observe: () => undefined,
    readPidFile: () => undefined,
    owner: { pid: process.pid },
  });
  return {
    authority,
    resolve: (): { specDigest: string; allocationGiB: number } => ({
      specDigest: "approved-spec",
      allocationGiB: 16,
    }),
    [Symbol.dispose](): void {
      authority.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("reserves before starting and publishes readiness only after recording a generation", async () => {
  using f = fixture();
  const gate = createManagedLaunchAdmission({ ...f, capture: () => generation });
  const started = Promise.withResolvers<undefined>();
  const resume = Promise.withResolvers<undefined>();
  const start = mock(async (commit: CommitLaunchReadiness) => {
    started.resolve(undefined);
    await resume.promise;
    return await simulateRuntimeReady(commit);
  });
  const pending = gate.run(request, signal, start);
  try {
    await started.promise;
    expect(f.authority.snapshot()).toMatchObject([{ state: "pending", allocationGiB: 16 }]);
    expect(await gate.run(request, signal, start)).toEqual({
      ran: false,
      detail: "ManagedLaunchPending",
    });
    const contender = await gate.run(
      { ...request, kind: "ModelHost", runtimeKey: "beta", launch: { manifest: {} } },
      signal,
      start,
    );
    expect(contender.ran).toBe(false);
    if (!contender.ran) expect(contender.detail).toMatch(/^BudgetExceeded:/);
    expect(start).toHaveBeenCalledTimes(1);
  } finally {
    resume.resolve(undefined);
    await pending;
  }
  expect(await pending).toEqual(ready);
  expect(f.authority.snapshot()).toMatchObject([{ state: "resident", generations: [generation] }]);
  expect(await gate.run(request, signal, start)).toEqual({
    ran: false,
    detail: "ManagedRuntimeResident",
  });
  expect(start).toHaveBeenCalledTimes(1);
});

test("retains a charge when reported readiness has no stable process identity", async () => {
  using f = fixture();
  const gate = createManagedLaunchAdmission({
    ...f,
    capture: () => ({ pid: generation.pid, executable: "/fixture/engine" }),
  });
  expect(await gate.run(request, signal, simulateRuntimeReady)).toEqual({
    ran: true,
    result: { ok: false, pid: generation.pid, error: "ManagedGenerationUnverified" },
  });
  expect(f.authority.snapshot()).toMatchObject([
    { state: "uncertain", allocationGiB: 16, generations: [] },
  ]);
});

test("persists the spawned generation even if the runtime later fails", async () => {
  using f = fixture();
  const gate = createManagedLaunchAdmission({ ...f, capture: () => generation });
  const failed = {
    ran: true as const,
    result: { ok: false, pid: null, spawnedPid: generation.pid },
  };
  expect(await gate.run(request, signal, () => Promise.resolve(failed))).toEqual(failed);
  expect(f.authority.snapshot()).toMatchObject([{ state: "uncertain", generations: [generation] }]);
});

test("a transport abort during launch retains the charge and suppresses readiness", async () => {
  using f = fixture();
  const gate = createManagedLaunchAdmission({ ...f, capture: () => generation });
  const aborter = new AbortController();
  const start = (
    commitReadiness: CommitLaunchReadiness,
  ): ReturnType<typeof simulateRuntimeReady> => {
    aborter.abort();
    return simulateRuntimeReady(commitReadiness);
  };
  expect(await gate.run(request, aborter.signal, start)).toEqual({
    ran: true,
    result: { ok: false, pid: generation.pid, error: "LaunchCanceled" },
  });
  expect(f.authority.snapshot()).toMatchObject([{ state: "uncertain", generations: [generation] }]);
});

test("rejects an unknown spec, a restart, and a pre-aborted launch before reserving", async () => {
  using f = fixture();
  const gate = createManagedLaunchAdmission({
    ...f,
    resolve: () => undefined,
    capture: () => undefined,
  });
  const start = mock(() => Promise.resolve(ready));
  expect(await gate.run(request, signal, start)).toEqual({
    ran: false,
    detail: "ManagedSpecUnknown",
  });
  expect(await gate.run({ ...request, launch: { restart: true } }, signal, start)).toEqual({
    ran: false,
    detail: "ManagedRestartUnavailable",
  });
  expect(await gate.run(request, AbortSignal.abort(), start)).toEqual({
    ran: false,
    detail: "LaunchCanceled",
  });
  expect(start).not.toHaveBeenCalled();
  expect(f.authority.snapshot()).toEqual([]);
});

test("retains the generation and returns a refusal when the ready commit cannot persist", async () => {
  using f = fixture();
  const gate = createManagedLaunchAdmission({
    ...f,
    authority: { ...f.authority, completeReady: () => false },
    capture: () => generation,
  });
  expect(await gate.run(request, signal, simulateRuntimeReady)).toEqual({
    ran: true,
    result: { ok: false, pid: generation.pid, error: "ManagedReadyUnverified" },
  });
  expect(f.authority.snapshot()).toMatchObject([{ state: "uncertain", generations: [generation] }]);
});

test("a lifecycle refusal before invoking the engine does not strand capacity", async () => {
  using f = fixture();
  const gate = createManagedLaunchAdmission({ ...f, capture: () => generation });
  const refused = {
    ran: false as const,
    detail: "profile switch already holds the lifecycle fence",
  };
  expect(await gate.run(request, signal, () => Promise.resolve(refused))).toEqual(refused);
  expect(f.authority.snapshot()).toEqual([]);

  const next = { kind: "ModelHost" as const, runtimeKey: "beta", launch: { manifest: {} } };
  expect(await gate.run(next, signal, simulateRuntimeReady)).toEqual(ready);
  expect(f.authority.snapshot()).toMatchObject([{ runtimeKey: "beta", state: "resident" }]);
});

test("a managed ModelHost must supply the manifest being admitted", async () => {
  using f = fixture();
  const resolve = mock(f.resolve);
  const start = mock(() => Promise.resolve(ready));
  const gate = createManagedLaunchAdmission({ ...f, resolve, capture: () => generation });

  expect(await gate.run({ ...request, kind: "ModelHost" }, signal, start)).toEqual({
    ran: false,
    detail: "ManagedManifestRequired",
  });
  expect(resolve).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(f.authority.snapshot()).toEqual([]);
});

test("a runtime cannot report success without committing publication for its PID", async () => {
  using f = fixture();
  const gate = createManagedLaunchAdmission({ ...f, capture: () => generation });
  expect(await gate.run(request, signal, () => Promise.resolve(ready))).toEqual({
    ran: false,
    detail: "ManagedReadyUnverified",
  });
  expect(f.authority.snapshot()).toMatchObject([{ state: "uncertain" }]);
});

test("the ledger uses the runtime-derived digest when admission includes a pinned plan", async () => {
  using f = fixture();
  const gate = createManagedLaunchAdmission({ ...f, capture: () => generation });
  const prepared = { ...request, effectiveSpecDigest: "pinned-runtime-digest" };
  expect(await gate.run(prepared, signal, simulateRuntimeReady)).toEqual(ready);
  expect(f.authority.snapshot()).toMatchObject([{ specDigest: "pinned-runtime-digest" }]);
});
