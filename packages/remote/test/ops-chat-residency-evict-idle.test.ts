// #519: `llamactl.residency.evictIdle` Ops Chat dispatch — RED tests pinning
// the read-only preview as a read-tier tool. At the pinned base the dispatch
// returns unknown_tool, so the behavioral cases fail by assertion.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import {
  createResidencyLeases,
  type ResidencyLeases,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { setSessionRefcountRegistry } from "@llamactl/core/residency/sessions";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readOpsChatAudit } from "../src/ops-chat/audit.js";
import { KNOWN_OPS_CHAT_TOOLS, OPS_CHAT_TOOLS } from "../src/ops-chat/dispatch.js";
import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../src/residency/apply-profile.js";
import {
  defaultResidencyStorePath,
  openResidencyOperationStore,
  type ResidencyStateRecord,
} from "../src/residency/store.js";
import { router } from "../src/router.js";
import { mkdirSync, mkdtempSync, rmSync } from "../src/safe-fs.js";
import { saveNodeRun } from "../src/workload/noderun-store.js";
import { ModelRunSchema } from "../src/workload/schema.js";
import { loadWorkloadByName, saveWorkload } from "../src/workload/store.js";

const TOOL = "llamactl.residency.evictIdle";
const GROUP = "z13-large-gpu";
const GROUP_LABEL = "llamactl.io/residency-group";
const NODE = "local";
const NOW = 1_000_000_000;
const IDLE_EVICTED_AT = "llamactl.io/idle-evicted-at";

type EvictIdleKind = "modelrun" | "modelhost";
type EvictIdleRow = {
  workload: string;
  action: "would-evict" | "evicted" | "skipped";
  kind?: EvictIdleKind;
  idleSinceMs?: number;
  dueAtMs?: number;
  reason?: string;
  detail?: string;
};
type EvictIdleResult =
  | { ok: false; reason: string }
  | { ok: true; dryRun: boolean; windowSeconds: number; rows: EvictIdleRow[] };

const originalEnv = { ...process.env };
let root = "";
let workloadsDir = "";
let auditPath = "";
let leases: ResidencyLeases;

function seedPathTo(target: ResidencyState): ResidencyState[] {
  switch (target) {
    case "downloaded":
      return ["downloaded"];
    case "loading":
      return ["downloaded", "loading"];
    case "ready":
      return ["downloaded", "loading", "warming", "ready"];
    case "unavailable":
    case "warming":
    case "draining":
    case "unloading":
    case "failed":
      throw new Error(`no seed path to residency state ${target}`);
  }
}

function seed(model: string): void {
  const store = openResidencyOperationStore({ path: defaultResidencyStorePath() });
  try {
    const fence = store.claimOwnership({
      ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
      incarnation: "seed",
    });
    for (const to of seedPathTo("ready")) {
      const result = store.transitionResidencyState({
        fenceToken: fence.fenceToken,
        model,
        ...(to === "loading" ? { group: GROUP } : {}),
        to,
        expectedVersion: store.getResidencyState(model)?.version ?? 0,
        nowMs: NOW,
      });
      expect(result.ok).toBe(true);
    }
  } finally {
    store.close();
  }
}

function readState(model: string): ResidencyStateRecord | null {
  const store = openResidencyOperationStore({ path: defaultResidencyStorePath() });
  try {
    return store.getResidencyState(model);
  } finally {
    store.close();
  }
}

function writeNodeRun(name: string, residency?: { idleEvictSeconds: number }): void {
  saveNodeRun(
    {
      apiVersion: "llamactl/v1",
      kind: "NodeRun",
      metadata: { name, labels: {} },
      spec: {
        node: name,
        ...(residency === undefined ? {} : { residency }),
        infra: [],
      },
    },
    workloadsDir,
  );
}

function writeRun(name: string): void {
  saveWorkload(
    ModelRunSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: {
        name,
        labels: { [GROUP_LABEL]: GROUP },
      },
      spec: {
        node: NODE,
        enabled: true,
        restartPolicy: "Always",
        target: { kind: "rel", value: `${name}/missing.gguf` },
      },
    }),
    workloadsDir,
  );
}

beforeEach(() => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  root = mkdtempSync(join(tmpdir(), "llamactl-opschat-evict-idle-"));
  workloadsDir = join(root, "workloads");
  auditPath = join(root, "ops-chat", "audit.jsonl");
  mkdirSync(workloadsDir, { recursive: true });
  mkdirSync(join(root, "models"), { recursive: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: join(root, "dev"),
    LOCAL_AI_RUNTIME_DIR: join(root, "runtime"),
    LOCAL_AI_PRESET_OVERRIDES_FILE: join(root, "preset-overrides.tsv"),
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
    LLAMACTL_EMBERSYNTH_CONFIG: join(root, "embersynth.yaml"),
    LLAMACTL_CONFIG: join(root, "config"),
    LLAMACTL_RESIDENCY_STORE: join(root, "residency", "operations.sqlite"),
    LLAMA_CPP_MODELS: join(root, "models"),
    LLAMACTL_NODE_NAME: NODE,
    LLAMACTL_OPS_CHAT_AUDIT: auditPath,
  });
  leases = createResidencyLeases({ now: () => NOW });
  setResidencyLeaseRegistry(leases);
  writeNodeRun(NODE, { idleEvictSeconds: 60 });
  writeRun("w1");
  seed("w1");
});

afterEach(() => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  if (root !== "") {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

function rowFor(result: EvictIdleResult, workload: string): EvictIdleRow | undefined {
  return result.ok ? result.rows.find((row) => row.workload === workload) : undefined;
}

describe("llamactl.residency.evictIdle Ops Chat dispatch", () => {
  test("OE1 registry: advertised as a read-tier tool on mcp + ops-chat", () => {
    expect((KNOWN_OPS_CHAT_TOOLS as readonly string[]).includes(TOOL)).toBe(true);
    const entry = OPS_CHAT_TOOLS.find((tool) => (tool.name as string) === TOOL);
    expect(entry).toBeDefined();
    expect(entry?.tier).toBe("read");
    expect(entry?.surfaces).toEqual(["mcp", "ops-chat"]);
  });

  test("OE2 dry-run parity: dispatch returns the residencyEvictIdle preview", async () => {
    const caller = router.createCaller({});
    const expected = await caller.residencyEvictIdle({ node: NODE });
    const res = await caller.operatorRunTool({
      name: TOOL,
      arguments: { node: NODE },
      dryRun: false,
    });

    expect(res.ok).toBe(true);
    expect(res.tier).toBe("read");
    expect(res.result).toEqual(expected);
    expect(expected).toMatchObject({ ok: true, dryRun: true });
    expect(rowFor(expected, "w1")).toMatchObject({
      workload: "w1",
      action: "would-evict",
      kind: "modelrun",
    });
  });

  test("OE3 never wet: extra targets stay a dry preview and change nothing", async () => {
    const caller = router.createCaller({});
    const res = await caller.operatorRunTool({
      name: TOOL,
      arguments: { node: NODE, targets: [{ workload: "w1", kind: "modelrun" }] },
      dryRun: false,
    });

    expect(res.ok).toBe(true);
    const payload = res.result as EvictIdleResult;
    expect(payload).toMatchObject({ ok: true, dryRun: true });
    expect(rowFor(payload, "w1")).toMatchObject({
      workload: "w1",
      action: "would-evict",
      kind: "modelrun",
    });
    const persisted = loadWorkloadByName("w1", workloadsDir);
    expect(persisted.metadata.annotations[IDLE_EVICTED_AT]).toBeUndefined();
    expect(persisted.spec.enabled).toBe(true);
    expect(readState("w1")?.state).toBe("ready");
  });

  test("OE4 disabled: a NodeRun without residency policy passes through Disabled", async () => {
    writeNodeRun(NODE);
    const caller = router.createCaller({});
    const expected = await caller.residencyEvictIdle({ node: NODE });
    const res = await caller.operatorRunTool({
      name: TOOL,
      arguments: { node: NODE },
      dryRun: false,
    });

    expect(res.ok).toBe(true);
    expect(res.result).toEqual(expected);
    expect(expected).toEqual({ ok: false, reason: "Disabled" });
  });

  test("OE5 missing node: surfaces the shared required-argument dispatch error", async () => {
    const caller = router.createCaller({});
    const res = await caller.operatorRunTool({
      name: TOOL,
      arguments: {},
      dryRun: false,
    });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("dispatch_error");
    expect(res.error?.message).toContain("missing required argument: node");
  });

  test("OE6 audit: the operatorRunTool call appends one audit entry", async () => {
    const caller = router.createCaller({});
    await caller.operatorRunTool({
      name: TOOL,
      arguments: { node: NODE },
      dryRun: false,
    });

    const { entries } = readOpsChatAudit({ path: auditPath });
    const matching = entries.filter((entry) => entry.tool === TOOL);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.ok).toBe(true);
    expect(matching[0]?.dryRun).toBe(false);
  });
});
