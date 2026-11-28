// RED tests for frozename/llamactl#518: the recommendations CLI prints the
// per-row skippedExperimental audit trail after the model/promoted fields.
import type { recommendations } from "@llamactl/core";

import { configSchema, type NodeClient } from "@llamactl/remote";
import { afterEach, describe, expect, test } from "bun:test";

import { runRecommendations } from "../src/commands/recommendations.js";
import { __resetTestSeams, __setTestSeams, resetGlobals, setGlobals } from "../src/dispatcher.js";
import { captureProcessStreams } from "./helpers.js";

describe("#518 recommendations CLI prints skippedExperimental", () => {
  function setupRemoteSeam(blocks: recommendations.RecommendationsForProfile[]): void {
    const cfg = configSchema.freshConfig();
    cfg.clusters[0]!.nodes.push({ name: "gpu1", endpoint: "https://gpu1.lan:7843" });
    const mockClient = {
      recommendations: {
        // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the tRPC procedure.
        query: async (_input: string) => blocks,
      },
    } as unknown as NodeClient;
    __setTestSeams({ config: cfg, nodeClient: mockClient });
    setGlobals({ nodeName: "gpu1", contextName: null, configPath: null });
  }

  afterEach(() => {
    __resetTestSeams();
    resetGlobals();
  });

  function makeRow(
    promoted: "env" | "file" | null,
    skipped?: { source: "env" | "file"; rel: string }[],
  ): recommendations.RecommendationRow {
    return {
      target: "best",
      rel: "acme/Foo-GGUF/q4_k_m",
      label: "Foo-Q4_K_M",
      family: "gemma",
      class: "general",
      scope: "best",
      quant: "q4",
      ctx: "32k",
      promoted,
      hf: null,
      ...(skipped !== undefined && { skippedExperimental: skipped }),
    };
  }

  async function dataLineFor(row: recommendations.RecommendationRow): Promise<string> {
    setupRemoteSeam([{ profile: "mac-mini-16g", rows: [row] }]);
    const { stdout } = await captureProcessStreams(() => runRecommendations([]));
    const line = stdout
      .split("\n")
      .find((candidate) => candidate.includes("model=acme/Foo-GGUF/q4_k_m"));
    expect(line).toBeDefined();
    return line!;
  }

  test("prints a file skip after the model on an unpromoted row", async () => {
    const line = await dataLineFor(makeRow(null, [{ source: "file", rel: "exp/X.gguf" }]));
    expect(line.endsWith("model=acme/Foo-GGUF/q4_k_m skipped-experimental=file:exp/X.gguf")).toBe(
      true,
    );
  });

  test("prints an env skip after a file promotion", async () => {
    const line = await dataLineFor(makeRow("file", [{ source: "env", rel: "exp/X.gguf" }]));
    expect(
      line.endsWith("model=acme/Foo-GGUF/q4_k_m promoted=file skipped-experimental=env:exp/X.gguf"),
    ).toBe(true);
  });

  test("prints multiple skips in order as a comma-separated list", async () => {
    const line = await dataLineFor(
      makeRow(null, [
        { source: "env", rel: "exp/A.gguf" },
        { source: "file", rel: "exp/B.gguf" },
      ]),
    );
    expect(
      line.endsWith(
        "model=acme/Foo-GGUF/q4_k_m skipped-experimental=env:exp/A.gguf,file:exp/B.gguf",
      ),
    ).toBe(true);
  });

  test("rows without the field keep the existing promoted-only suffix", async () => {
    const line = await dataLineFor(makeRow("env"));
    expect(line.endsWith("model=acme/Foo-GGUF/q4_k_m promoted=env")).toBe(true);
    expect(line).not.toContain("skipped-experimental");
  });

  test("an empty skip list is not printed", async () => {
    const line = await dataLineFor(makeRow(null, []));
    expect(line).not.toContain("skipped-experimental");
  });
});
