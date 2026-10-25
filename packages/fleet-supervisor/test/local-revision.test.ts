import { resolveEnv } from "@llamactl/core/env";
import { computeWorkloadEpoch } from "@llamactl/core/kvstore";
import { ensureWorkloadRuntimeDir, workloadRuntimeDir } from "@llamactl/core/workloadRuntime";
import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkloadTarget } from "../src/workload-probe.js";

import { makeLocalRevisionReader } from "../src/local-revision.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

const TARGET: WorkloadTarget = {
  name: "granite-judge",
  endpoint: "http://127.0.0.1:8080",
  kind: "ModelRun",
};

describe("makeLocalRevisionReader", () => {
  let dev: string | null = null;

  afterEach(() => {
    if (dev !== null) {
      rmSync(dev, { recursive: true, force: true });
      dev = null;
    }
  });

  function tempEnv(): NodeJS.ProcessEnv {
    dev = mkdtempSync(join(tmpdir(), "local-rev-"));
    return {
      DEV_STORAGE: dev,
      LOCAL_AI_RUNTIME_DIR: join(dev, "ai-models", "local-ai"),
      LLAMA_CPP_MODELS: join(dev, "ai-models", "llama.cpp", "models"),
      LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
      LOCAL_AI_RECOMMENDATIONS_SOURCE: "off",
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "/tmp",
    };
  }

  function writeRecord(env: NodeJS.ProcessEnv, name: string, startedAt: string, rel: string): void {
    const resolved = resolveEnv(env);
    ensureWorkloadRuntimeDir(resolved, { name });
    const runtimeDir = workloadRuntimeDir(resolved, { name });
    writeFileSync(
      join(runtimeDir, "llama-server.state"),
      JSON.stringify({
        rel,
        extraArgs: [],
        host: "127.0.0.1",
        port: "8080",
        binary: "/tmp/llama-server",
        pid: 43210,
        startedAt,
        tunedProfile: null,
      }),
    );
  }

  it("returns null when there is no runtime record", () => {
    const reader = makeLocalRevisionReader(tempEnv());
    expect(reader(TARGET)).toBeNull();
  });

  it("returns the workload epoch for an existing record", () => {
    const env = tempEnv();
    const startedAt = "2026-10-24T15:30:00.000Z";
    const rel = "granite-3b-q8_0.gguf";
    writeRecord(env, TARGET.name, startedAt, rel);

    const reader = makeLocalRevisionReader(env);
    expect(reader(TARGET)).toBe(computeWorkloadEpoch({ startedAt, rel }));
  });

  it("returns a different revision after the record is rewritten with a new startedAt (restart)", () => {
    const env = tempEnv();
    const rel = "granite-3b-q8_0.gguf";
    writeRecord(env, TARGET.name, "2026-10-24T15:30:00.000Z", rel);

    const reader = makeLocalRevisionReader(env);
    const before = reader(TARGET);
    expect(before).not.toBeNull();

    writeRecord(env, TARGET.name, "2026-10-24T16:45:00.000Z", rel);
    const after = reader(TARGET);

    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });
});
