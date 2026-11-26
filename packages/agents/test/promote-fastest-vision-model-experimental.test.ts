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
const STABLE_REL = "stable/vision-Q4_K_M.gguf";
const PROFILE = "macbook-pro-48g";

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
} {
  const step = result.steps.find((s) => s.tool === "llamactl.bench.compare");
  if (!step) throw new Error("no llamactl.bench.compare step");
  return step.result as { excludedExperimental?: unknown; candidates?: unknown };
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

describe("promote-fastest-vision-model experimental exclusion", () => {
  test("dry-run skips a faster experimental rel and reports it as excluded", async () => {
    const { client, calls } = makeClient({
      "llamactl.bench.compare": () =>
        benchResponse([
          {
            rel: EXPERIMENTAL_REL,
            class: "multimodal",
            installed: true,
            gen_tps: "90",
            qualificationStage: "experimental",
          },
          { rel: STABLE_REL, class: "multimodal", installed: true, gen_tps: "40" },
        ]),
      "llamactl.catalog.promote": () => ({ dryRun: true }),
      "llamactl.embersynth.sync": () => ({ dryRun: true }),
    });

    const result = await runWithClient(client, true);

    // Kills: dropping the experimental filter.
    expect(result.ok).toBe(true);
    const promoteCalls = calls.filter((c) => c.name === "llamactl.catalog.promote");
    expect(promoteCalls.length).toBeGreaterThan(0);
    for (const call of promoteCalls) {
      expect(call.arguments["rel"]).toBe(STABLE_REL);
    }
    expect(benchStepResult(result).excludedExperimental).toEqual([EXPERIMENTAL_REL]);
  });

  test("fails without promoting when every benched installed multimodal rel is experimental", async () => {
    const { client, calls } = makeClient({
      "llamactl.bench.compare": () =>
        benchResponse([
          {
            rel: EXPERIMENTAL_REL,
            class: "multimodal",
            installed: true,
            gen_tps: "90",
            qualificationStage: "experimental",
          },
        ]),
      "llamactl.catalog.promote": () => ({ dryRun: true }),
      "llamactl.embersynth.sync": () => ({ dryRun: true }),
    });

    const result = await runWithClient(client, true);

    // Kills: falling through to promote, or reusing the "no installed multimodal models" error.
    expect(result.ok).toBe(false);
    expect(result.error).toContain("every benched installed multimodal rel is experimental");
    expect(result.error).toContain(EXPERIMENTAL_REL);
    expect(result.error).toContain(
      "experimental models are served only on an exact model pin and never as a preset default",
    );
    expect(calls.map((c) => c.name)).toEqual(["llamactl.bench.compare"]);
  });

  test("an uninstalled, unbenched experimental rel is not reported as excluded", async () => {
    const { client, calls } = makeClient({
      "llamactl.bench.compare": () =>
        benchResponse([
          {
            rel: EXPERIMENTAL_REL,
            class: "multimodal",
            installed: false,
            qualificationStage: "experimental",
          },
          { rel: STABLE_REL, class: "multimodal", installed: false },
        ]),
      "llamactl.catalog.promote": () => ({ dryRun: true }),
      "llamactl.embersynth.sync": () => ({ dryRun: true }),
    });

    const result = await runWithClient(client, true);

    // Kills: running the experimental check before the installed/tuned filter.
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "no installed multimodal models with a recorded bench run — pull + bench one first",
    );
    expect(result.error).not.toContain("experimental");
    expect(benchStepResult(result).excludedExperimental).toBeUndefined();
    expect(calls.map((c) => c.name)).toEqual(["llamactl.bench.compare"]);
  });

  test("an uninstalled experimental rel is not excluded alongside an eligible stable rel", async () => {
    const { client } = makeClient({
      "llamactl.bench.compare": () =>
        benchResponse([
          {
            rel: EXPERIMENTAL_REL,
            class: "multimodal",
            installed: false,
            gen_tps: "90",
            qualificationStage: "experimental",
          },
          { rel: STABLE_REL, class: "multimodal", installed: true, gen_tps: "40" },
        ]),
      "llamactl.catalog.promote": () => ({ dryRun: true }),
      "llamactl.embersynth.sync": () => ({ dryRun: true }),
    });

    const result = await runWithClient(client, true);

    expect(result.ok).toBe(true);
    expect(benchStepResult(result).excludedExperimental).toBeUndefined();
  });

  test("a refused wet promote fails before embersynth sync", async () => {
    const { client, calls } = makeClient({
      "llamactl.bench.compare": () =>
        benchResponse([{ rel: STABLE_REL, class: "multimodal", installed: true, gen_tps: "40" }]),
      "llamactl.catalog.promote": () => ({ ok: false, error: "refused-x" }),
      "llamactl.embersynth.sync": () => ({ ok: true }),
    });

    const result = await runWithClient(client, false, { profile: PROFILE });

    // Kills: ignoring promote results.
    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      `llamactl.catalog.promote refused ${STABLE_REL} for profile ${PROFILE}: refused-x`,
    );
    expect(calls.filter((c) => c.name === "llamactl.embersynth.sync")).toHaveLength(0);
    expect(calls.filter((c) => c.name === "llamactl.catalog.promote")).toHaveLength(1);
  });

  test("a dry-run promote refusal fails before embersynth sync", async () => {
    const { client, calls } = makeClient({
      "llamactl.bench.compare": () =>
        benchResponse([{ rel: STABLE_REL, class: "multimodal", installed: true, gen_tps: "40" }]),
      "llamactl.catalog.promote": () => ({ dryRun: true, refused: "refused-y" }),
      "llamactl.embersynth.sync": () => ({ dryRun: true }),
    });

    const result = await runWithClient(client, true, { profile: PROFILE });

    // Kills: checking only ok === false.
    expect(result.ok).toBe(false);
    expect(result.error).toContain("refused-y");
    expect(calls.filter((c) => c.name === "llamactl.embersynth.sync")).toHaveLength(0);
  });

  test("candidate, degraded and validated rows stay eligible", async () => {
    const candidateRel = "candidate/vision.gguf";
    const degradedRel = "degraded/vision.gguf";
    const validatedRel = "validated/vision.gguf";
    const { client, calls } = makeClient({
      "llamactl.bench.compare": () =>
        benchResponse([
          {
            rel: candidateRel,
            class: "multimodal",
            installed: true,
            gen_tps: "30",
            qualificationStage: "candidate",
          },
          {
            rel: degradedRel,
            class: "multimodal",
            installed: true,
            gen_tps: "20",
            qualificationStage: "degraded",
          },
          {
            rel: validatedRel,
            class: "multimodal",
            installed: true,
            gen_tps: "40",
            qualificationStage: "validated",
          },
        ]),
      "llamactl.catalog.promote": () => ({ dryRun: true }),
      "llamactl.embersynth.sync": () => ({ dryRun: true }),
    });

    const result = await runWithClient(client, true, { profile: PROFILE });

    // Kills: an over-broad filter that excludes every staged rel.
    expect(result.ok).toBe(true);
    expect(benchStepResult(result).candidates).toBe(3);
    const promoteCalls = calls.filter((c) => c.name === "llamactl.catalog.promote");
    expect(promoteCalls).toHaveLength(1);
    expect(promoteCalls[0]?.arguments["rel"]).toBe(validatedRel);
  });
});
