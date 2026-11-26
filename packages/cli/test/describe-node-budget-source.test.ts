import * as remoteMod from "@llamactl/remote";
import { afterEach, describe, expect, test } from "bun:test";

import * as helpersMod from "../src/commands/noderun-helpers.js";
import {
  __resetWorkloadTestSeams,
  __setWorkloadTestSeams,
  renderNodeBudget,
  runDescribe,
} from "../src/commands/workload.js";

const formatNodeBudgetSource = (helpersMod as Record<string, unknown>)["formatNodeBudgetSource"] as
  | ((s: "noderun" | "computed", r?: { defaulted: boolean; value: number }) => string)
  | undefined;
const formatResidencyKnobs = (helpersMod as Record<string, unknown>)["formatResidencyKnobs"] as
  | ((e: { knobs: readonly { defaulted: boolean; name: string; value: number }[] }) => string)
  | undefined;
const effectiveResidencyPolicy = (remoteMod as Record<string, unknown>)[
  "effectiveResidencyPolicy"
] as
  | ((residency: { safetyMarginRatio?: number } | undefined) => {
      knobs: readonly { defaulted: boolean; name: string; value: number }[];
    })
  | undefined;

const payloadR1 = {
  budget: 36,
  budgetSource: "noderun",
  reserved: 11,
  safetyMarginRatio: { defaulted: false, value: 0.5 },
  workloads: [],
};
const payloadR2 = {
  budget: 64,
  budgetSource: "computed",
  reserved: 0,
  safetyMarginRatio: { defaulted: false, value: 0.5 },
  workloads: [],
};
const payloadR3 = {
  budget: 96,
  budgetSource: "computed",
  reserved: 0,
  safetyMarginRatio: { defaulted: true, value: 0.75 },
  workloads: [],
};
const payloadR4 = {
  budget: 48,
  budgetSource: "computed",
  reserved: 0,
  workloads: [],
};
const payloadR5 = {
  budget: 16,
  reserved: 0,
  workloads: [],
};
const payloadR6 = {
  budget: 16,
  budgetSource: "computed",
  reserved: 22.5,
  safetyMarginRatio: { defaulted: false, value: 0.5 },
  workloads: [
    { enabled: true, endpoint: null, expectedMemoryGiB: 22.5, name: "big", phase: "Running" },
  ],
};
const payloadR7 = {
  budget: 24,
  budgetSource: "manual",
  reserved: 0,
  safetyMarginRatio: { defaulted: false, value: 0.5 },
  workloads: [],
};

afterEach(() => {
  __resetWorkloadTestSeams();
});

async function withCapturedIo<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stderr: string; stdout: string }> {
  let stdout = "";
  let stderr = "";
  const stdoutOrig = process.stdout.write.bind(process.stdout);
  const stderrOrig = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  try {
    const result = await fn();
    return { result, stderr, stdout };
  } finally {
    process.stdout.write = stdoutOrig;
    process.stderr.write = stderrOrig;
  }
}

describe("formatNodeBudgetSource", () => {
  // Kills: the noderun source carrying a GiB number or any label other than the manifest field.
  test("H1: an explicit NodeRun budget names spec.budget.memoryGiB", () => {
    expect(typeof formatNodeBudgetSource).toBe("function");
    const format = formatNodeBudgetSource!;
    expect(format("noderun", { defaulted: false, value: 0.5 })).toBe("spec.budget.memoryGiB");
  });

  // Kills: dropping the effective ratio from the computed-source explanation.
  test("H2: a computed budget with an explicit ratio renders the ratio", () => {
    expect(typeof formatNodeBudgetSource).toBe("function");
    const format = formatNodeBudgetSource!;
    expect(format("computed", { defaulted: false, value: 0.5 })).toBe(
      "computed from node memory x safetyMarginRatio 0.5",
    );
  });

  // Kills: omitting the default marker for a resolver-supplied ratio.
  test("H3: a computed budget with a defaulted ratio marks it as default", () => {
    expect(typeof formatNodeBudgetSource).toBe("function");
    const format = formatNodeBudgetSource!;
    expect(format("computed", { defaulted: true, value: 0.75 })).toBe(
      "computed from node memory x safetyMarginRatio 0.75 (default)",
    );
  });

  // Kills: requiring the ratio payload and breaking older agents that omit it.
  test("H4: a computed budget without ratio details renders the unqualified source", () => {
    expect(typeof formatNodeBudgetSource).toBe("function");
    const format = formatNodeBudgetSource!;
    expect(format("computed")).toBe("computed from node memory x safetyMarginRatio");
  });

  // Kills: a second default-marker convention (such as ", default") diverging from formatResidencyKnobs.
  test("H5: the computed-source ratio formatting reuses the residency knob formatter", () => {
    expect(typeof formatNodeBudgetSource).toBe("function");
    const format = formatNodeBudgetSource!;
    const formatKnobs = formatResidencyKnobs!;
    const resolvePolicy = effectiveResidencyPolicy!;
    const k = resolvePolicy(undefined).knobs.find((knob) => knob.name === "safetyMarginRatio");
    expect(k).toBeDefined();
    if (k === undefined) return;
    expect(format("computed", { defaulted: k.defaulted, value: k.value })).toBe(
      "computed from node memory x " + formatKnobs({ knobs: [k] }),
    );
  });
});

describe("renderNodeBudget budgetSource", () => {
  // Kills: renderNodeBudget ignoring budgetSource for an explicit NodeRun budget.
  test("R1: an explicit budget suffixes the first line with the manifest source", () => {
    const out = renderNodeBudget(payloadR1);
    expect(out.split("\n")[0]).toBe("Budget:   11.0 / 36.0 GiB (spec.budget.memoryGiB)");
  });

  // Kills: the computed source rendering without the effective ratio.
  test("R2: a computed budget suffixes the first line with source and explicit ratio", () => {
    const out = renderNodeBudget(payloadR2);
    expect(out.split("\n")[0]).toBe(
      "Budget:   0.0 / 64.0 GiB (computed from node memory x safetyMarginRatio 0.5)",
    );
  });

  // Kills: a computed default ratio losing its default marker in describe node.
  test("R3: a computed budget suffixes the first line with a defaulted ratio", () => {
    const out = renderNodeBudget(payloadR3);
    expect(out.split("\n")[0]).toBe(
      "Budget:   0.0 / 96.0 GiB (computed from node memory x safetyMarginRatio 0.75 (default))",
    );
  });

  // Kills: renderNodeBudget requiring safetyMarginRatio and breaking older computed payloads.
  test("R4: a computed payload without ratio details renders the unqualified suffix", () => {
    const out = renderNodeBudget(payloadR4);
    expect(out.split("\n")[0]).toBe(
      "Budget:   0.0 / 48.0 GiB (computed from node memory x safetyMarginRatio)",
    );
  });

  // Kills: older payloads gaining a suffix they never sent.
  test("R5: an older-agent payload without source fields keeps the legacy first line", () => {
    const out = renderNodeBudget(payloadR5);
    expect(out.split("\n")[0]).toBe("Budget:   0.0 / 16.0 GiB");
  });

  // Kills: the source suffix suppressing or rewriting the over-budget warning.
  test("R6: an over-budget computed payload keeps the warning and source suffix", () => {
    const out = renderNodeBudget(payloadR6);
    expect(out).toContain("WARNING: budget exceeded (22.5 > 16.0 GiB)");
    expect(out.split("\n")[0]).toBe(
      "Budget:   22.5 / 16.0 GiB (computed from node memory x safetyMarginRatio 0.5)",
    );
  });

  // Kills: an unrecognised budgetSource from a newer agent being mislabelled as computed.
  test("R7: an unknown budget source renders the plain first line with no suffix", () => {
    const out = renderNodeBudget(payloadR7);
    expect(out.split("\n")[0]).toBe("Budget:   0.0 / 24.0 GiB");
  });
});

describe("describe node budgetSource", () => {
  // Kills: renderNodeBudget ignoring budgetSource, or older payloads gaining a suffix.
  test("CL1: describe node renders the source suffix in human mode and raw payload in json mode", async () => {
    __setWorkloadTestSeams({
      getNodeClientByName: () =>
        ({
          nodeBudget: { query: () => Promise.resolve(payloadR2) },
        }) as unknown as remoteMod.NodeClient,
      nodeQueryTimeoutMs: 1000,
    });

    const json = await withCapturedIo(() => runDescribe(["node", "gpu1", "--json"]));
    expect(json.result).toBe(0);
    expect(json.stderr).toBe("");
    expect(json.stdout).toBe(JSON.stringify(payloadR2, null, 2) + "\n");

    const human = await withCapturedIo(() => runDescribe(["node", "gpu1"]));
    expect(human.result).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).toContain("(computed from node memory x safetyMarginRatio 0.5)");
  });
});
