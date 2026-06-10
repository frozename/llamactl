import { describe, expect, test } from "bun:test";

import { router } from "../src/router.js";

async function rejectionOf(promise: PromiseLike<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected rejection");
}

function expectErrorMessage(err: unknown, expected: RegExp): void {
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(expected);
}

describe("router workload validation", () => {
  test("exposes ModelHost lifecycle procedures", () => {
    const caller = router.createCaller({});
    expect(typeof caller.modelHostStatus).toBe("function");
    expect(typeof caller.modelHostStop).toBe("function");
    expect(typeof caller.modelHostStart).toBe("function");
  });

  test("accepts ModelRun manifests", async () => {
    const caller = router.createCaller({});
    const result = await caller.workloadValidate({
      yaml: `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: validate-run
spec:
  node: local
  target:
    value: foo/bar.gguf
`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.kind).toBe("ModelRun");
    expect(result.manifest.metadata.name).toBe("validate-run");
  });

  test("accepts ModelHost manifests", async () => {
    const caller = router.createCaller({});
    const result = await caller.workloadValidate({
      yaml: `
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: validate-host
spec:
  engine: omlx
  node: local
  binary: /usr/bin/true
  endpoint:
    host: 127.0.0.1
    port: 19091
  hostedModels:
    - rel: foo/bar.gguf
`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.kind).toBe("ModelHost");
    expect(result.manifest.metadata.name).toBe("validate-host");
  });

  test("reads ModelHost status from local runtime state", async () => {
    const caller = router.createCaller({});
    const result = await caller.modelHostStatus({ workload: "host-a" });
    expect(result).toEqual({ state: "Stopped" });
  });

  test("modelHostStart validates optional inline manifest payloads", async () => {
    const caller = router.createCaller({});
    const stream = await caller.modelHostStart({ workload: "host-a" });
    expect(typeof stream[Symbol.asyncIterator]).toBe("function");
    expectErrorMessage(
      await rejectionOf(
        caller.modelHostStart({
          workload: "host-a",
          manifest: { kind: "ModelHost" } as never,
        }),
      ),
      /manifest/i,
    );
  });

  test("rejects unknown workload kinds with a clear error", async () => {
    const caller = router.createCaller({});
    const result = await caller.workloadValidate({
      yaml: `
apiVersion: llamactl/v1
kind: NotARealKind
metadata:
  name: broken
spec:
  node: local
`,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/unsupported workload kind/i);
  });
});
