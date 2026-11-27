// #519: apply-profile must round-trip the planner refusal's held workloads and
// retry guidance. The plans are hand-built refusals, so the mutation returns
// before opening the store or resolving steps.
import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResidencyPlan } from "../../src/residency/procedures.js";

import {
  applyResidencyProfile,
  type ResidencyApplyProfileResult,
} from "../../src/residency/apply-profile.js";
import { existsSync, mkdtempSync, rmSync } from "../../src/safe-fs.js";

type RefusedResidencyPlan = Extract<ResidencyPlan, { ok: false }>;

type RefusalReadout = {
  reason: string;
  detail: string;
  retryAfterMs?: number;
  workloads?: string[];
};

let tmp = "";
let workloadsDir = "";
let storePath = "";

function refusedPlan(input: {
  reason: string;
  detail: string;
  workloads: string[];
  retryAfterMs: number | null;
}): RefusedResidencyPlan {
  return {
    ok: false,
    reason: input.reason,
    detail: input.detail,
    workloads: input.workloads,
    retryAfterMs: input.retryAfterMs,
    steps: [],
  };
}

async function applyRefused(
  plan: RefusedResidencyPlan,
  dryRun: boolean,
): Promise<ResidencyApplyProfileResult> {
  return await applyResidencyProfile({
    plan,
    dryRun,
    storePath,
    workloadsDir,
    registry: null,
    node: "local",
    to: "code",
    from: "chat",
  });
}

function refusalOf(result: ResidencyApplyProfileResult): RefusalReadout | undefined {
  return result.refusal;
}

beforeEach(() => {
  setResidencyLeaseRegistry(null);
  tmp = mkdtempSync(join(tmpdir(), "llamactl-apply-refusal-retry-"));
  workloadsDir = join(tmp, "missing-workloads");
  storePath = join(tmp, "missing-residency", "operations.sqlite");
});

afterEach(() => {
  setResidencyLeaseRegistry(null);
  if (tmp !== "") {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

describe("applyResidencyProfile refusal retry readout", () => {
  test("R1: a Cooldown refusal preserves retryAfterMs and omits an empty workloads list", async () => {
    // kills: plannerRefusal not copying retryAfterMs; copying an empty workloads [].
    const detail = "switch cooldown active (125000ms remaining)";
    const plan = refusedPlan({
      reason: "Cooldown",
      detail,
      workloads: [],
      retryAfterMs: 125_000,
    });

    const dry = await applyRefused(plan, true);
    const wet = await applyRefused(plan, false);

    for (const result of [dry, wet]) {
      expect(result.outcome).toBe("refused");
      expect(refusalOf(result)).toEqual({
        reason: "Cooldown",
        detail,
        retryAfterMs: 125_000,
      });
      expect(existsSync(storePath)).toBe(false);
    }
  });

  test("R2: a MinResidency refusal preserves held workloads and retryAfterMs", async () => {
    // kills: plannerRefusal dropping the held workloads.
    const detail = "2 victim(s) have not met minimum residency";
    const plan = refusedPlan({
      reason: "MinResidency",
      detail,
      workloads: ["chat-a", "code-b"],
      retryAfterMs: 3_590_000,
    });

    const result = await applyRefused(plan, true);

    expect(result.outcome).toBe("refused");
    expect(refusalOf(result)).toEqual({
      reason: "MinResidency",
      detail,
      workloads: ["chat-a", "code-b"],
      retryAfterMs: 3_590_000,
    });
  });

  test("R3: a refusal without retry guidance omits the retryAfterMs key", async () => {
    // kills: emitting retryAfterMs:null.
    const detail = "residency plan refused: NotOptedIn";
    const plan = refusedPlan({
      reason: "NotOptedIn",
      detail,
      workloads: ["x"],
      retryAfterMs: null,
    });

    const result = await applyRefused(plan, true);

    expect(result.outcome).toBe("refused");
    expect(result.refusal).toBeDefined();
    const refusal = refusalOf(result)!;
    expect(refusal).toEqual({
      reason: "NotOptedIn",
      detail,
      workloads: ["x"],
    });
    expect("retryAfterMs" in refusal).toBe(false);
  });
});
