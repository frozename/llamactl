// packages/remote/test/composite-destroy-catalog-cleanup.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Composite } from "../src/composite/schema.js";
import type { RuntimeBackend } from "../src/runtime/backend.js";
import type { SiriusProvider } from "../src/config/sirius-providers.js";
import type { WorkloadClient } from "../src/workload/apply.js";

import { destroyComposite } from "../src/composite/apply.js";
import { readGatewayCatalog, writeGatewayCatalog } from "../src/workload/gateway-catalog/io.js";

const manifest: Composite = {
  apiVersion: "llamactl/v1",
  kind: "Composite",
  metadata: { name: "mc", labels: {} },
  spec: {
    services: [],
    workloads: [],
    ragNodes: [],
    gateways: [],
    pipelines: [],
    dependencies: [],
    onFailure: "rollback",
  },
};
const boundaryBackend = {
  destroyCompositeBoundary: () => Promise.resolve(),
} as unknown as RuntimeBackend;
const unusedWorkloadClient = (): WorkloadClient => {
  throw new Error("unused workload client");
};

describe("destroyComposite catalog cleanup", () => {
  let tmp: string;
  let prevSp: string | undefined;
  let prevEm: string | undefined;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cd-"));
    prevSp = process.env.LLAMACTL_SIRIUS_PROVIDERS;
    prevEm = process.env.LLAMACTL_EMBERSYNTH_CONFIG;
    process.env.LLAMACTL_SIRIUS_PROVIDERS = join(tmp, "sp.yaml");
    process.env.LLAMACTL_EMBERSYNTH_CONFIG = join(tmp, "em.yaml");
    origFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(new Response("ok", { status: 200 }))) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    if (prevSp === undefined) delete process.env.LLAMACTL_SIRIUS_PROVIDERS;
    else process.env.LLAMACTL_SIRIUS_PROVIDERS = prevSp;
    if (prevEm === undefined) delete process.env.LLAMACTL_EMBERSYNTH_CONFIG;
    else process.env.LLAMACTL_EMBERSYNTH_CONFIG = prevEm;
    globalThis.fetch = origFetch;
    rmSync(tmp, { recursive: true, force: true });
  });

  const own = (names: string[]) => ({
    source: "composite" as const,
    compositeNames: names,
    specHash: "h",
  });

  test("removes solely-owned entries from sirius catalog", async () => {
    writeGatewayCatalog("sirius", [
      {
        name: "mc-llama",
        kind: "openai-compatible",
        baseUrl: "http://h/v1",
        ownership: own(["mc"]),
      } satisfies SiriusProvider,
    ]);
    await destroyComposite({
      manifest,
      backend: boundaryBackend,
      getWorkloadClient: unusedWorkloadClient,
    });
    const after = readGatewayCatalog("sirius");
    expect(after.find((e) => e.name === "mc-llama")).toBeUndefined();
  });

  test("keeps co-owned entries with shorter compositeNames", async () => {
    writeGatewayCatalog("sirius", [
      {
        name: "mc-llama",
        kind: "openai-compatible",
        baseUrl: "http://h/v1",
        ownership: own(["mc", "other"]),
      } satisfies SiriusProvider,
    ]);
    await destroyComposite({
      manifest,
      backend: boundaryBackend,
      getWorkloadClient: unusedWorkloadClient,
    });
    const after = readGatewayCatalog("sirius");
    expect(after[0]!.name).toBe("mc-llama");
    expect(after[0]!.ownership?.compositeNames).toEqual(["other"]);
  });

  test("triggers reload only when changed", async () => {
    const calls: string[] = [];
    globalThis.fetch = ((url: Parameters<typeof globalThis.fetch>[0]) => {
      calls.push(url instanceof Request ? url.url : url instanceof URL ? url.href : url);
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    await destroyComposite({
      manifest,
      backend: boundaryBackend,
      getWorkloadClient: unusedWorkloadClient,
    });
    expect(calls.filter((c) => c.includes("/providers/reload")).length).toBe(0);
    expect(calls.filter((c) => c.includes("/config/reload")).length).toBe(0);
  });
});
