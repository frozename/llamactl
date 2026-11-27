import {
  createResidencyLeases,
  getResidencyLeaseRegistry,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { router } from "../../src/router.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { acquireLock, releaseLock } from "../../src/workload/lock.js";
import { parseWorkload, saveWorkload, workloadPath } from "../../src/workload/store.js";

function managedFixture(): {
  root: string;
  workloadsDir: string;
  [Symbol.dispose](): void;
} {
  const root = mkdtempSync(join(tmpdir(), "llamactl-managed-mutations-"));
  const workloadsDir = join(root, "workloads");
  const runtime = join(root, "runtime");
  const settings = {
    LOCAL_AI_RUNTIME_DIR: runtime,
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
    LLAMACTL_RESIDENCY_STORE: join(root, "operations.sqlite"),
  };
  const previous = Object.entries(settings).map(([key]) => [key, process.env[key]] as const);
  Object.assign(process.env, settings);
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "managed-residency-v1"), "fixture\n");
  return {
    root,
    workloadsDir,
    [Symbol.dispose](): void {
      for (const [key, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("legacy workload deletion preserves managed desired state even with keepRunning", async () => {
  using fixture = managedFixture();
  saveWorkload(
    parseWorkload(`
apiVersion: llamactl/v1
kind: ModelRun
metadata: { name: managed }
spec:
  node: local
  target: { kind: rel, value: model.gguf }
`),
    fixture.workloadsDir,
  );
  const path = workloadPath("managed", fixture.workloadsDir);
  const before = readFileSync(path, "utf8");
  const outcome = await router
    .createCaller({})
    .workloadDelete({ name: "managed", keepRunning: true });
  expect(outcome).toMatchObject({ ok: false, error: "ManagedWorkloadRetirementRequired" });
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("legacy force unload leaves a managed workload's active lease intact", async () => {
  using _fixture = managedFixture();
  const registry = createResidencyLeases();
  const previous = getResidencyLeaseRegistry();
  setResidencyLeaseRegistry(registry);
  const acquired = registry.acquire("managed");
  if (!acquired.ok) throw new Error("lease fixture unavailable");
  try {
    const outcome = await router
      .createCaller({})
      .residencyForceUnload({
        workload: "managed",
        reason: "fixture",
        confirm: true,
      })
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("ManagedForceUnloadRequiresOwner");
    expect(acquired.lease.signal.aborted).toBe(false);
    expect(registry.snapshot("managed").active).toContain(acquired.lease.id);
  } finally {
    acquired.lease.release();
    setResidencyLeaseRegistry(previous);
  }
});

test("the legacy controller cannot claim a marked managed runtime", () => {
  using fixture = managedFixture();
  const handle = acquireLock(fixture.workloadsDir);
  if (!("error" in handle)) releaseLock(handle);
  expect(handle).toEqual({ error: "ManagedControllerOwnerConflict" });
});

test("ordinary legacy stop procedures cannot mutate a managed runtime", async () => {
  using _fixture = managedFixture();
  const caller = router.createCaller({});
  expect(await caller.serverStop({ workload: "managed" })).toMatchObject({
    stopped: false,
    managedRefusal: "ManagedStopIntentRequired",
  });
  expect(await caller.modelHostStop({ workload: "managed" })).toMatchObject({
    ok: false,
    error: "ManagedStopIntentRequired",
  });
});
