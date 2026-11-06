import type { discovery, recommendations } from "@llamactl/core";

import { configSchema, type NodeClient } from "@llamactl/remote";
import { afterEach, describe, expect, test } from "bun:test";

import { runDiscover } from "../src/commands/discover.js";
import { runRecommendations } from "../src/commands/recommendations.js";
import { __resetTestSeams, __setTestSeams, resetGlobals, setGlobals } from "../src/dispatcher.js";
import { captureProcessStreams } from "./helpers.js";

describe("discover remote", () => {
  let discoverCalls: { filter: string; profile?: string; limit?: number }[];

  function setupRemoteSeam(discoveryResult: discovery.DiscoveryResult | null): void {
    const cfg = configSchema.freshConfig();
    cfg.clusters[0]!.nodes.push({ name: "gpu1", endpoint: "https://gpu1.lan:7843" });
    const mockClient = {
      discover: {
        // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the tRPC procedure.
        query: async (input: { filter: string; profile?: string; limit?: number }) => {
          discoverCalls.push(input);
          return discoveryResult;
        },
      },
    } as unknown as NodeClient;
    __setTestSeams({ config: cfg, nodeClient: mockClient });
    setGlobals({ nodeName: "gpu1", contextName: null, configPath: null });
  }

  afterEach(() => {
    __resetTestSeams();
    resetGlobals();
  });

  test("-h and --help short-circuit: zero stub calls, exit 0", async () => {
    for (const args of [["-h"], ["--help"], ["all", "--help"]]) {
      discoverCalls = [];
      const { result: code, stdout, stderr } = await captureProcessStreams(() => runDiscover(args));
      expect(code).toBe(0);
      expect(stdout).toMatch(/^Usage: llamactl discover/);
      expect(stderr).toBe("");
      expect(discoverCalls).toHaveLength(0);
    }
  });

  test("no args sends { filter: 'other' } with exactly ['filter'] keys", async () => {
    setupRemoteSeam(null);
    discoverCalls = [];
    await captureProcessStreams(() => runDiscover([]));
    expect(discoverCalls).toHaveLength(1);
    expect(discoverCalls[0]).toStrictEqual({ filter: "other" });
    expect(Object.keys(discoverCalls[0]!)).toStrictEqual(["filter"]);
  });

  test("filtered args pass filter, profile, limit (as number)", async () => {
    setupRemoteSeam(null);
    discoverCalls = [];
    await captureProcessStreams(() => runDiscover(["fits-16g", "mac-mini-16g", "7"]));
    expect(discoverCalls).toHaveLength(1);
    expect(discoverCalls[0]).toStrictEqual({
      filter: "fits-16g",
      profile: "mac-mini-16g",
      limit: 7,
    });
  });

  test("stub returns null → exit 1, stderr message, no stdout", async () => {
    setupRemoteSeam(null);
    discoverCalls = [];
    const { result: code, stdout, stderr } = await captureProcessStreams(() => runDiscover([]));
    expect(code).toBe(1);
    expect(stderr).toBe("Unable to fetch Hugging Face discovery feed\n");
    expect(stdout).toBe("");
  });

  test("empty rows prints header + no-discovery-results", async () => {
    const result: discovery.DiscoveryResult = {
      filter: "other",
      profile: "balanced",
      author: "unsloth",
      limit: 5,
      rows: [],
    };
    setupRemoteSeam(result);
    discoverCalls = [];
    const { stdout } = await captureProcessStreams(() => runDiscover([]));
    expect(stdout).toBe(
      "filter=other profile=balanced author=unsloth limit=5\n  no-discovery-results\n",
    );
  });

  test("two rows: new gets try: line, curated does not; widths correct", async () => {
    const newRow: discovery.DiscoveryRow = {
      fit: "good",
      fitScore: 85,
      class: "general",
      catalogStatus: "new",
      repo: "acme/Foo-GGUF",
      file: "foo-q4_k_m.gguf",
      rel: "acme/Foo-GGUF/q4_k_m",
      quant: "q4",
      downloads: 1200,
      likes: 34,
      updated: "2026-05-01",
      pipeline: "text-generation",
      estimatedSize: "4.1G",
      visionStatus: "text",
    };
    const curatedRow: discovery.DiscoveryRow = {
      fit: "excellent",
      fitScore: 95,
      class: "reasoning",
      catalogStatus: "curated",
      repo: "acme/Bar-GGUF",
      file: "bar-q8_0.gguf",
      rel: "acme/Bar-GGUF/q8_0",
      quant: "q8",
      downloads: 500,
      likes: 12,
      updated: "2026-04-15",
      pipeline: "text-generation",
      estimatedSize: "8.2G",
      visionStatus: "ready",
    };
    const result: discovery.DiscoveryResult = {
      filter: "other",
      profile: "balanced",
      author: "unsloth",
      limit: 5,
      rows: [newRow, curatedRow],
    };
    setupRemoteSeam(result);
    discoverCalls = [];
    const { stdout } = await captureProcessStreams(() => runDiscover([]));
    const lines = stdout.split("\n");
    // Line 1: header
    expect(lines[0]).toBe("filter=other profile=balanced author=unsloth limit=5");
    // Line 2: first row (new) — class=general(11), fit=good(10), status=new(11), quant=q4(6), size=4.1G(10), vision=text(11)
    expect(lines[1]).toBe(
      "  general     good       status=new         quant=q4     size=4.1G       vision=text        repo=acme/Foo-GGUF",
    );
    expect(lines[1]!.length).toBeGreaterThan(0);
    // Lines after header: row1-line1, row1-line2(file), row1-line3(try:), row2-line1, row2-line2(file)
    expect(lines[2]!).toBe(
      "             file=foo-q4_k_m.gguf downloads=1200 likes=34 updated=2026-05-01 task=text-generation rel=acme/Foo-GGUF/q4_k_m",
    );
    // try: line appears ONLY after new row (line 3), not for curated (line 5)
    expect(lines).toContain("             try: llama-candidate-test acme/Foo-GGUF");
    const tryLineIdx = lines.findIndex((l) =>
      l.includes("try: llama-candidate-test acme/Foo-GGUF"),
    );
    expect(tryLineIdx).toBe(3);
    expect(lines.some((l) => l.includes("try: llama-candidate-test acme/Bar-GGUF"))).toBe(false);
    // Line 5: second row (curated) file line — no try: line
    expect(lines[5]!).toBe(
      "             file=bar-q8_0.gguf downloads=500 likes=12 updated=2026-04-15 task=text-generation rel=acme/Bar-GGUF/q8_0",
    );
  });

  test("long repo value appears unpadded and untruncated in output", async () => {
    const longRepoRow: discovery.DiscoveryRow = {
      fit: "good",
      fitScore: 85,
      class: "general",
      catalogStatus: "new",
      repo: "acme/VeryLongRepoNameThatExceedsAnyPadWidthInTheOutputGGUF",
      file: "long-q4.gguf",
      rel: "acme/VeryLongRepoNameThatExceedsAnyPadWidthInTheOutputGGUF/q4",
      quant: "q4",
      downloads: 100,
      likes: 5,
      updated: "2026-05-01",
      pipeline: "text-generation",
      estimatedSize: "4.1G",
      visionStatus: "text",
    };
    const result: discovery.DiscoveryResult = {
      filter: "other",
      profile: "balanced",
      author: "unsloth",
      limit: 5,
      rows: [longRepoRow],
    };
    setupRemoteSeam(result);
    discoverCalls = [];
    const { stdout } = await captureProcessStreams(() => runDiscover([]));
    const lines = stdout.split("\n");
    // repo="acme/VeryLongRepoNameThatExceedsAnyPadWidthInTheOutputGGUF" (58 chars) > any pad width (max 11), printed as-is
    expect(lines[1]).toContain("acme/VeryLongRepoNameThatExceedsAnyPadWidthInTheOutputGGUF");
  });
});

describe("recommendations remote", () => {
  let recCalls: string[];

  function setupRemoteSeam(blocks: recommendations.RecommendationsForProfile[]): void {
    const cfg = configSchema.freshConfig();
    cfg.clusters[0]!.nodes.push({ name: "gpu1", endpoint: "https://gpu1.lan:7843" });
    const mockClient = {
      recommendations: {
        // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the tRPC procedure.
        query: async (input: string) => {
          recCalls.push(input);
          return blocks;
        },
      },
    } as unknown as NodeClient;
    __setTestSeams({ config: cfg, nodeClient: mockClient });
    setGlobals({ nodeName: "gpu1", contextName: null, configPath: null });
  }

  afterEach(() => {
    __resetTestSeams();
    resetGlobals();
  });

  test("-h / --help: exit 0, zero stub calls", async () => {
    for (const args of [["-h"], ["--help"]]) {
      recCalls = [];
      const { result: code, stdout } = await captureProcessStreams(() => runRecommendations(args));
      expect(code).toBe(0);
      expect(stdout).toMatch(/^Usage: llamactl recommendations/);
      expect(recCalls).toHaveLength(0);
    }
  });

  test("no args sends 'current'; args ['all'] sends 'all'", async () => {
    setupRemoteSeam([]);
    recCalls = [];
    await captureProcessStreams(() => runRecommendations([]));
    expect(recCalls).toStrictEqual(["current"]);
    recCalls = [];
    await captureProcessStreams(() => runRecommendations(["all"]));
    expect(recCalls).toStrictEqual(["all"]);
  });

  test("two blocks: mac-mini-16g with promoted rows, balanced empty", async () => {
    const rowA: recommendations.RecommendationRow = {
      target: "best",
      rel: "acme/Foo-GGUF/q4_k_m",
      label: "Foo-Q4_K_M",
      family: "gemma",
      class: "general",
      scope: "best",
      quant: "q4",
      ctx: "32k",
      promoted: "env",
      hf: "downloads=1 likes=2",
    };
    const rowB: recommendations.RecommendationRow = {
      target: "vision",
      rel: "acme/Bar-GGUF/q8_0",
      label: "Bar-Q8_0",
      family: "llama",
      class: "multimodal",
      scope: "vision",
      quant: "q8",
      ctx: "32k",
      promoted: "file",
      hf: null,
    };
    const blocks: recommendations.RecommendationsForProfile[] = [
      { profile: "mac-mini-16g", rows: [rowA, rowB] },
      { profile: "balanced", rows: [] },
    ];
    setupRemoteSeam(blocks);
    recCalls = [];
    const { stdout } = await captureProcessStreams(() => runRecommendations([]));
    expect(stdout).toBe(
      "profile=mac-mini-16g\n" +
        "  best      Foo-Q4_K_M               class=general     scope=best             quant=q4     ctx=32k    model=acme/Foo-GGUF/q4_k_m promoted=env\n" +
        "             hf=downloads=1 likes=2\n" +
        "  vision    Bar-Q8_0                 class=multimodal  scope=vision           quant=q8     ctx=32k    model=acme/Bar-GGUF/q8_0 promoted=file\n" +
        "\n" +
        "profile=balanced\n" +
        "\n",
    );
  });

  test("row with promoted=null has no 'promoted=' on the line", async () => {
    const rowNoPromote: recommendations.RecommendationRow = {
      target: "fast",
      rel: "acme/Baz-GGUF/q5_k_m",
      label: "Baz-Q5_K_M",
      family: "qwen",
      class: "reasoning",
      scope: "fast",
      quant: "q5",
      ctx: "32k",
      promoted: null,
      hf: null,
    };
    const blocks: recommendations.RecommendationsForProfile[] = [
      { profile: "balanced", rows: [rowNoPromote] },
    ];
    setupRemoteSeam(blocks);
    recCalls = [];
    const { stdout } = await captureProcessStreams(() => runRecommendations([]));
    const lines = stdout.split("\n");
    const dataLine = lines.find((l) => l.includes("model=acme/Baz-GGUF/q5_k_m"));
    expect(dataLine).toBeDefined();
    expect(dataLine).toMatch(/model=acme\/Baz-GGUF\/q5_k_m$/);
    expect(dataLine).not.toContain("promoted=");
  });
});
