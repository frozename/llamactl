import { server } from "@llamactl/core";
import { expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openNodeManagedAdmission } from "../../src/residency/target-admission-policy.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { pinModelHostStartup } from "../../src/server/modelhost.js";
import { modelRunStartInvocation } from "../../src/workload/apply.js";
import { parseModelHost, saveModelHost } from "../../src/workload/modelhost-store.js";
import { parseNodeRun, saveNodeRun } from "../../src/workload/noderun-store.js";
import { parseWorkload, saveWorkload } from "../../src/workload/store.js";

const target = "fixture-owner";
const alias = "fixture-alias";

test("the target authorizes an exact enabled manifest and rejects forged plans", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-admission-policy-"));
  const workloads = join(dir, "workloads");
  const runtimeDir = join(dir, "runtime");
  const old = process.env["LOCAL_AI_RUNTIME_DIR"];
  process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
  mkdirSync(workloads, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  const manifest = parseModelHost(`
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: fixture-ml
spec:
  engine: llamacpp
  node: ${alias}
  binary: /usr/bin/false
  endpoint:
    host: 127.0.0.1
    port: 19095
  hostedModels:
    - rel: trusted.gguf
  resources:
    expectedMemoryGiB: 16
`);
  saveModelHost(manifest, workloads);
  saveNodeRun(
    parseNodeRun(`
apiVersion: llamactl/v1
kind: NodeRun
metadata:
  name: ${target}
spec:
  node: ${target}
  budget:
    memoryGiB: 24
`),
    workloads,
  );

  const pinned = pinModelHostStartup(manifest);
  const policy = await openNodeManagedAdmission({
    nodeName: target,
    aliases: [alias],
    workloadsDir: workloads,
  });
  const ready = mock(() =>
    Promise.resolve({ ran: false as const, detail: "fixture did not start an engine" }),
  );
  const signal = new AbortController().signal;
  const request = {
    kind: "ModelHost" as const,
    runtimeKey: manifest.metadata.name,
    launch: { manifest },
    effectiveSpecDigest: pinned.effectiveSpecDigest,
    effectiveLaunch: pinned.effectiveLaunch,
  };
  try {
    expect(
      await policy.admission.run({ ...request, effectiveSpecDigest: "forged" }, signal, ready),
    ).toEqual({ ran: false, detail: "ManagedSpecUnknown" });
    expect(ready).not.toHaveBeenCalled();
    expect(policy.authority.snapshot()).toEqual([]);
    await policy.admission.run(request, signal, ready);
    expect(ready).toHaveBeenCalledTimes(1);

    const unaccounted = join(runtimeDir, "workloads", "legacy-resident");
    mkdirSync(unaccounted, { recursive: true });
    writeFileSync(join(unaccounted, "llama-server.pid"), String(process.pid));
    expect(await policy.admission.run(request, signal, ready)).toEqual({
      ran: false,
      detail: "ManagedRuntimeInventoryUnknown",
    });
    rmSync(unaccounted, { recursive: true, force: true });
    expect(ready).toHaveBeenCalledTimes(1);

    saveModelHost({ ...manifest, spec: { ...manifest.spec, enabled: false } }, workloads);
    const disabled = pinModelHostStartup({
      ...manifest,
      spec: { ...manifest.spec, enabled: false },
    });
    expect(
      await policy.admission.run(
        { ...request, effectiveSpecDigest: disabled.effectiveSpecDigest },
        signal,
        ready,
      ),
    ).toEqual({ ran: false, detail: "ManagedSpecUnknown" });
    expect(ready).toHaveBeenCalledTimes(1);
  } finally {
    policy.authority.close();
    if (old === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
    else process.env["LOCAL_AI_RUNTIME_DIR"] = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ModelRun uses the target budget, which outranks fresh capacity and rejects unverified fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-node-budget-"));
  const runtimeDir = join(dir, "runtime");
  const modelsDir = join(dir, "models");
  const env = {
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMA_CPP_MODELS: modelsDir,
    LLAMA_CPP_USE_TUNED_ARGS: "false",
  };
  const before = new Map(Object.keys(env).map((name) => [name, process.env[name]] as const));
  Object.assign(process.env, env);
  mkdirSync(modelsDir);
  writeFileSync(join(modelsDir, "exact.gguf"), "GGUF-fixture");
  const manifest = parseWorkload(`
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: fixture-run
spec:
  node: ${alias}
  target: { kind: rel, value: exact.gguf }
  binary: /usr/bin/false
  resources: { expectedMemoryGiB: 26 }
`);
  saveWorkload(manifest, dir);
  const nowMs = 100_000;
  let sample = { nodeName: "foreign", memBytes: 64 * 1024 ** 3, observedAtMs: nowMs };
  const policy = await openNodeManagedAdmission({
    nodeName: target,
    aliases: [alias],
    workloadsDir: dir,
    nowMs: () => nowMs,
    verifiedCapacity: () => sample,
  });
  try {
    const { workload, ...launch } = modelRunStartInvocation(manifest);
    const prepared = server.prepareManagedServerStart({ ...launch, key: { name: workload } });
    if ("result" in prepared) throw new Error(prepared.result.error);
    const request = {
      kind: "ModelRun" as const,
      runtimeKey: workload,
      effectiveSpecDigest: prepared.effectiveSpecDigest,
      effectiveLaunch: prepared.launch,
      launch,
    };
    const signal = new AbortController().signal;
    const refusal = { ran: false as const, detail: "fixture did not start" };
    const callback = mock(() => Promise.resolve(refusal));
    for (const unverified of [
      sample,
      { ...sample, nodeName: target, observedAtMs: nowMs - 30_001 },
      { ...sample, nodeName: alias, observedAtMs: nowMs + 1 },
    ]) {
      sample = unverified;
      const result = await policy.admission.run(request, signal, callback);
      expect(result.ran).toBe(false);
      if (!result.ran) expect(result.detail).toMatch(/^BudgetUnknown:/);
    }
    expect(callback).not.toHaveBeenCalled();
    sample = { ...sample, nodeName: alias, observedAtMs: nowMs };
    expect(await policy.admission.run(request, signal, callback)).toEqual(refusal);
    expect(callback).toHaveBeenCalledTimes(1);

    saveNodeRun(
      parseNodeRun(`
apiVersion: llamactl/v1
kind: NodeRun
metadata:
  name: ${target}
spec:
  node: ${target}
  budget: { memoryGiB: 24 }
`),
      dir,
    );
    const result = await policy.admission.run(request, signal, callback);
    expect(result.ran).toBe(false);
    if (!result.ran) expect(result.detail).toMatch(/^BudgetExceeded:/);
    expect(callback).toHaveBeenCalledTimes(1);
  } finally {
    policy.authority.close();
    for (const [name, value] of before) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
