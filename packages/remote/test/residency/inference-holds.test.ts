import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InferenceHolds } from "../../src/residency/inference-holds.js";

import { createDurableInferenceHolds } from "../../src/residency/inference-holds.js";
import { openResidencyOperationStore } from "../../src/residency/store.js";
import { renameSync } from "../../src/safe-fs.js";

function fixture(): { path: string; open: () => InferenceHolds; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "llamactl-inference-holds-"));
  const path = join(directory, "transition.db");
  openResidencyOperationStore({ path }).close();
  return {
    path,
    open: (): InferenceHolds =>
      createDurableInferenceHolds({ path, verifyJournal: () => undefined }),
    cleanup: (): void => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("normal stores stay at schema one, and managed holds advance it without excluding active peers", () => {
  const { path, open, cleanup } = fixture();
  try {
    const db = new Database(path, { readonly: true });
    try {
      const version = db.query("SELECT version FROM schema_version");
      expect(version.get()).toEqual({ version: 1 });
      const first = open();
      const receipt = first.begin("victim");
      const peer = first.begin("victim");
      expect(receipt).toBeDefined();
      expect(peer).toBeDefined();
      expect(version.get()).toEqual({ version: 2 });
      expect(first.state("victim")).toBe("current");

      const reopened = open();
      expect(reopened.state("victim")).toBe("prior");
      expect(reopened.begin("victim")).toBeUndefined();
      expect(reopened.state("other")).toBe("clear");
      expect(reopened.begin("other")?.confirmCompletion()).toBe(true);
      expect(receipt?.confirmCompletion()).toBe(true);
      expect(receipt?.confirmCompletion()).toBe(false);
      expect(reopened.state("victim")).toBe("prior");
      expect(peer?.confirmCompletion()).toBe(true);
      expect(reopened.state("victim")).toBe("clear");
      expect(reopened.begin("victim")?.confirmCompletion()).toBe(true);
      openResidencyOperationStore({ path, requireExisting: true }).close();
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test("unknown journal identity blocks holds and settlement without discarding a receipt", () => {
  const { path, cleanup } = fixture();
  try {
    let mismatch = false;
    const holds = createDurableInferenceHolds({
      path,
      verifyJournal: () => (mismatch ? "ManagedTransitionJournalMismatch" : undefined),
    });
    const receipt = holds.begin("victim");
    expect(receipt).toBeDefined();
    mismatch = true;
    expect(holds.state("victim")).toBe("unknown");
    expect(holds.begin("other")).toBeUndefined();
    expect(receipt?.confirmCompletion()).toBe(false);
    mismatch = false;
    expect(holds.state("victim")).toBe("current");
    renameSync(path, path + ".offline");
    expect(holds.state("victim")).toBe("unknown");
    expect(holds.begin("other")).toBeUndefined();
    expect(receipt?.confirmCompletion()).toBe(false);
    expect(() => new Database(path, { readonly: true })).toThrow();
  } finally {
    cleanup();
  }
});

test("a subprocess killed during the owner engine dial leaves a durable workload hold", async () => {
  const { path, open, cleanup } = fixture();
  const importPath = (module: string): string => JSON.stringify(new URL(module, import.meta.url));
  const program = `
    import { createResidencyLeases, setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
    import { createDurableInferenceHolds } from ${importPath("../../src/residency/inference-holds.js")};
    import { createOwnerAdmission } from ${importPath("../../src/residency/owner-admission.js")};
    setResidencyLeaseRegistry(createResidencyLeases());
    const inferenceHolds = createDurableInferenceHolds({
      path: ${JSON.stringify(path)},
      verifyJournal: () => undefined,
    });
    const gate = createOwnerAdmission([{
      name: "fixture", foregroundPorts: [18200], backgroundPorts: [18210],
      foregroundConcurrency: 2, maxQueued: 4, maxQueueWaitMs: 1000,
      starvationBoundMs: 1000, maxQueuedBytes: 65536, maxPerPrincipal: 4,
    }], { inferenceHolds });
    await gate.forward({
      target: "http://127.0.0.1:18200/v1/chat/completions",
      deadlineMs: Date.now() + 5000,
      workload: "victim",
      body: "{}",
      clientSignal: new AbortController().signal,
      principal: { bearer: null },
      send: async () => {
        await Bun.write(Bun.stdout, "engine dial reached\\n");
        process.kill(process.pid, "SIGKILL");
      },
    });
  `;
  const child = Bun.spawn([process.execPath, "-e", program], {
    cwd: import.meta.dirname,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(stdout).toBe("engine dial reached\n");
    expect(child.signalCode).toBe("SIGKILL");
    const reopened = open();
    expect(reopened.state("victim")).toBe("prior");
    expect(reopened.begin("victim")).toBeUndefined();
    expect(reopened.state("unrelated")).toBe("clear");
    expect(reopened.begin("unrelated")?.confirmCompletion()).toBe(true);
  } finally {
    child.kill();
    await child.exited;
    cleanup();
  }
});
