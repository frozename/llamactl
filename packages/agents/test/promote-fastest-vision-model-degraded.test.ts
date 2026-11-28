/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-empty-function -- Test doubles implement async runbook interfaces. */
import { describe, expect, test } from "bun:test";

import {
  type RunbookResult,
  type RunbookToolClient,
  runRunbook,
  type ToolCallInput,
} from "../src/index.js";

interface Call {
  name: string;
  arguments: Record<string, unknown>;
}

function makeClient(responses: Record<string, (args: Record<string, unknown>) => unknown>): {
  client: RunbookToolClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client: RunbookToolClient = {
    async callTool(input: ToolCallInput) {
      calls.push({ name: input.name, arguments: input.arguments });
      const handler = responses[input.name];
      if (!handler) throw new Error(`unexpected tool call: ${input.name}`);
      const payload = handler(input.arguments);
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    },
  };
  return { client, calls };
}

const EXPERIMENTAL_REL = "exp/vision-Q4_K_M.gguf";
const DEGRADED_REL = "degraded/vision-Q4_K_M.gguf";
const DEGRADED_SLOW_REL = "degraded-slow/vision-Q4_K_M.gguf";
const STABLE_REL = "stable/vision-Q4_K_M.gguf";
const HEALTHY_FAST_REL = "healthy-fast/vision-Q4_K_M.gguf";
const HEALTHY_SLOW_REL = "healthy-slow/vision-Q4_K_M.gguf";

type BenchResponseRow = {
  label: string;
  rel: string;
  class: string;
  installed: boolean;
  scope: string;
  mode: string;
  ctx: string;
  build: string;
  machine: string;
  tuned: {
    profile: string;
    gen_tps: string;
    prompt_tps: string;
    updated_at: string;
    legacy: boolean;
  } | null;
  vision: {
    load_ms: string;
    image_encode_ms: string;
    prompt_tps: string;
    gen_tps: string;
    updated_at: string;
  } | null;
  qualificationStage?: string;
};

type BenchInputRow = {
  rel: string;
  class: string;
  installed: boolean;
  gen_tps?: string;
  qualificationStage?: string;
};

function benchResponse(rows: BenchInputRow[]): BenchResponseRow[] {
  return rows.map((r) => ({
    label: r.rel,
    rel: r.rel,
    class: r.class,
    installed: r.installed,
    scope: "candidate",
    mode: "vision",
    ctx: "4096",
    build: "b1",
    machine: "test",
    tuned: r.gen_tps
      ? { profile: "default", gen_tps: r.gen_tps, prompt_tps: "120", updated_at: "", legacy: false }
      : null,
    vision: r.gen_tps
      ? {
          load_ms: "100",
          image_encode_ms: "20",
          prompt_tps: "500",
          gen_tps: r.gen_tps,
          updated_at: "",
        }
      : null,
    ...(r.qualificationStage === undefined ? {} : { qualificationStage: r.qualificationStage }),
  }));
}

function benchStepResult(result: { steps: { tool: string; result: unknown }[] }): {
  excludedExperimental?: unknown;
  candidates?: unknown;
  top?: unknown;
} {
  const step = result.steps.find((s) => s.tool === "llamactl.bench.compare");
  if (!step) throw new Error("no llamactl.bench.compare step");
  return step.result as { excludedExperimental?: unknown; candidates?: unknown; top?: unknown };
}

async function runWithClient(
  client: RunbookToolClient,
  dryRun: boolean,
  params = {},
): Promise<RunbookResult> {
  return await runRunbook("promote-fastest-vision-model", params, {
    dryRun,
    log: () => {},
    toolClient: client,
  });
}

function expectEveryPromoteRel(calls: Call[], rel: string): void {
  const promoteCalls = calls.filter((c) => c.name === "llamactl.catalog.promote");
  expect(promoteCalls.length).toBeGreaterThan(0);
  for (const call of promoteCalls) {
    expect(call.arguments["rel"]).toBe(rel);
  }
}

describe("promote-fastest-vision-model degraded tier", () => {
  test("V1: a degraded rel loses to a slower healthy rel but remains a candidate", async () => {
    const { client, calls } = makeClient({
      "llamactl.bench.compare": () =>
        benchResponse([
          {
            rel: DEGRADED_REL,
            class: "multimodal",
            installed: true,
            gen_tps: "90",
            qualificationStage: "degraded",
          },
          { rel: STABLE_REL, class: "multimodal", installed: true, gen_tps: "40" },
        ]),
      "llamactl.catalog.promote": () => ({ dryRun: true }),
      "llamactl.embersynth.sync": () => ({ dryRun: true }),
    });

    const result = await runWithClient(client, true);

    expect(result.ok).toBe(true);
    expectEveryPromoteRel(calls, STABLE_REL);
    const benchStep = benchStepResult(result);
    expect(benchStep.top).toBe(STABLE_REL);
    expect(benchStep.candidates).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(benchStep, "excludedExperimental")).toBe(false);
  });

  test("V2: a degraded rel is promoted when it is the only eligible rel", async () => {
    const { client, calls } = makeClient({
      "llamactl.bench.compare": () =>
        benchResponse([
          {
            rel: DEGRADED_REL,
            class: "multimodal",
            installed: true,
            gen_tps: "90",
            qualificationStage: "degraded",
          },
        ]),
      "llamactl.catalog.promote": () => ({ dryRun: true }),
      "llamactl.embersynth.sync": () => ({ dryRun: true }),
    });

    const result = await runWithClient(client, true);

    expect(result.ok).toBe(true);
    expectEveryPromoteRel(calls, DEGRADED_REL);
    expect(benchStepResult(result).top).toBe(DEGRADED_REL);
  });

  test("V3: experimental exclusion still leaves a healthy rel ahead of degraded", async () => {
    const { client, calls } = makeClient({
      "llamactl.bench.compare": () =>
        benchResponse([
          {
            rel: EXPERIMENTAL_REL,
            class: "multimodal",
            installed: true,
            gen_tps: "95",
            qualificationStage: "experimental",
          },
          {
            rel: DEGRADED_REL,
            class: "multimodal",
            installed: true,
            gen_tps: "90",
            qualificationStage: "degraded",
          },
          { rel: STABLE_REL, class: "multimodal", installed: true, gen_tps: "40" },
        ]),
      "llamactl.catalog.promote": () => ({ dryRun: true }),
      "llamactl.embersynth.sync": () => ({ dryRun: true }),
    });

    const result = await runWithClient(client, true);

    expect(result.ok).toBe(true);
    expectEveryPromoteRel(calls, STABLE_REL);
    const benchStep = benchStepResult(result);
    expect(benchStep.excludedExperimental).toEqual([EXPERIMENTAL_REL]);
    expect(benchStep.top).toBe(STABLE_REL);
  });

  test("V4: healthy rels are still sorted by gen_tps ahead of degraded rels", async () => {
    const { client, calls } = makeClient({
      "llamactl.bench.compare": () =>
        benchResponse([
          {
            rel: DEGRADED_REL,
            class: "multimodal",
            installed: true,
            gen_tps: "90",
            qualificationStage: "degraded",
          },
          { rel: HEALTHY_SLOW_REL, class: "multimodal", installed: true, gen_tps: "30" },
          {
            rel: DEGRADED_SLOW_REL,
            class: "multimodal",
            installed: true,
            gen_tps: "80",
            qualificationStage: "degraded",
          },
          { rel: HEALTHY_FAST_REL, class: "multimodal", installed: true, gen_tps: "40" },
        ]),
      "llamactl.catalog.promote": () => ({ dryRun: true }),
      "llamactl.embersynth.sync": () => ({ dryRun: true }),
    });

    const result = await runWithClient(client, true);

    expect(result.ok).toBe(true);
    expectEveryPromoteRel(calls, HEALTHY_FAST_REL);
    expect(benchStepResult(result).top).toBe(HEALTHY_FAST_REL);
  });
});
