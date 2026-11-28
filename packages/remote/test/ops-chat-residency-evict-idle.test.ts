// #284: `llamactl.residency.evictIdle` Ops Chat dispatch — RED tests pinning
// the read-only projection of the residencyEvictIdle dry run. At the pinned
// base the tool is absent from the dispatch registry, so the registry case
// fails by assertion and the dispatch cases fail on `unknown_tool`.
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
import { KNOWN_OPS_CHAT_TOOLS, OPS_CHAT_TOOLS, toolTier } from "../src/ops-chat/dispatch.js";
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
  auditPath = join(root, "audit.jsonl");
  mkdirSync(workloadsDir, { recursive: true });
  mkdirSync(join(root, "models"), { recursive: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: join(root, "dev"),
    LOCAL_AI_RUNTIME_DIR: join(root, "runtime"),
    LOCAL_AI_PRESET_OVERRIDES_FILE: join(root, "preset-overrides.tsv"),
    LLAMACTL_OPS_CHAT_AUDIT: auditPath,
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
    LLAMACTL_CONFIG: join(root, "config"),
    LLAMACTL_RESIDENCY_STORE: join(root, "residency", "operations.sqlite"),
    LLAMA_CPP_MODELS: join(root, "models"),
    LLAMACTL_NODE_NAME: NODE,
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

type RunToolResult = Awaited<ReturnType<ReturnType<typeof router.createCaller>["operatorRunTool"]>>;

async function runTool(args: Record<string, unknown>): Promise<RunToolResult> {
  return await router.createCaller({}).operatorRunTool({
    name: TOOL,
    arguments: args,
    dryRun: false,
  });
}

function rowFor(result: EvictIdleResult, workload: string): EvictIdleRow | undefined {
  return result.ok ? result.rows.find((row) => row.workload === workload) : undefined;
}

describe("llamactl.residency.evictIdle Ops Chat dispatch", () => {
  test("O1 registry: advertised as a read tool on mcp + ops-chat", () => {
    expect((KNOWN_OPS_CHAT_TOOLS as readonly string[]).includes(TOOL)).toBe(true);
    const entry = OPS_CHAT_TOOLS.find((t) => (t.name as string) === TOOL);
    expect(entry).toBeDefined();
    expect(entry?.tier).toBe("read");
    expect(entry?.surfaces).toEqual(["mcp", "ops-chat"]);
    // GREEN consistency only at the pinned base: toolTier falls back to
    // 'read' for unknown names, so this assertion passes before the fix.
    expect(toolTier(TOOL as Parameters<typeof toolTier>[0])).toBe("read");
  });

  test("O2 preview round trip: reports would-evict and changes neither lifecycle, lease nor hold", async () => {
    const res = await runTool({ node: NODE });

    expect(res.ok).toBe(true);
    expect(res.tier).toBe("read");
    expect(res.result).toMatchObject({ ok: true, dryRun: true, windowSeconds: 60 });
    const payload = res.result as EvictIdleResult;
    expect(rowFor(payload, "w1")).toMatchObject({
      workload: "w1",
      action: "would-evict",
      kind: "modelrun",
    });
    expect(readState("w1")?.state).toBe("ready");
    expect(leases.snapshot("w1").phase).toBe("open");
    expect(
      loadWorkloadByName("w1", workloadsDir).metadata.annotations[IDLE_EVICTED_AT],
    ).toBeUndefined();
  });

  test("O3 wet-path guard: extra targets are ignored and the preview never evicts", async () => {
    const res = await runTool({
      node: NODE,
      targets: [{ workload: "w1", kind: "modelrun" }],
    });

    expect(res.ok).toBe(true);
    const payload = res.result as EvictIdleResult;
    expect(payload.ok ? payload.dryRun : false).toBe(true);
    expect(payload.ok ? payload.rows.some((row) => row.action === "evicted") : false).toBe(false);
    expect(readState("w1")?.state).toBe("ready");
    expect(leases.snapshot("w1").phase).toBe("open");
  });

  test("O4 refusals pass through: Disabled and NotServingNode stay structured payloads", async () => {
    writeNodeRun(NODE);
    const disabled = await runTool({ node: NODE });
    expect(disabled.ok).toBe(true);
    expect(disabled.result).toEqual({ ok: false, reason: "Disabled" });

    writeNodeRun(NODE, { idleEvictSeconds: 60 });
    process.env["LLAMACTL_NODE_NAME"] = "other";
    const offNode = await runTool({ node: NODE });
    expect(offNode.ok).toBe(true);
    expect(offNode.result).toMatchObject({ ok: false, reason: "NotServingNode" });
  });

  test("O5 missing node: surfaces the dispatch validation error", async () => {
    const res = await runTool({});

    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("missing required argument: node");
  });

  test("O6 audit: one successful preview appends one Ops Chat audit entry", async () => {
    await runTool({ node: NODE });

    const tail = readOpsChatAudit({ path: auditPath });
    expect(tail.entries).toHaveLength(1);
    const entry = tail.entries[0];
    expect(entry?.tool).toBe(TOOL);
    expect(entry?.ok).toBe(true);
    expect(entry?.dryRun).toBe(false);
  });
});
