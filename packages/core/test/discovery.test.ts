import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DiscoveryFit } from "../src/discovery.js";
import type { HFModelInfo } from "../src/schemas.js";
import type { MachineProfile } from "../src/types.js";

import {
  classifyRepo,
  discoveryFit,
  eligibleGgufSiblings,
  filterMatches,
  fitScore,
  pickFile,
} from "../src/discovery.js";
import { repoTreeCacheFile } from "../src/hf.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

describe("discovery.classifyRepo", () => {
  test("pipeline=image-text-to-text short-circuits to multimodal", () => {
    expect(classifyRepo("unsloth/anything", "image-text-to-text", "")).toBe("multimodal");
  });
  test("vision/multimodal tag -> multimodal", () => {
    expect(classifyRepo("unsloth/whatever", "", "vision")).toBe("multimodal");
    expect(classifyRepo("unsloth/whatever", "", "multimodal")).toBe("multimodal");
  });
  test("gemma-4-* repo name -> multimodal", () => {
    expect(classifyRepo("unsloth/gemma-4-31B-it-GGUF", "", "")).toBe("multimodal");
  });
  test("reasoning / thinking tags or repo hints -> reasoning", () => {
    expect(classifyRepo("unsloth/deepseek-r1", "", "")).toBe("reasoning");
    expect(classifyRepo("unsloth/qwen-3", "", "")).toBe("reasoning");
    expect(classifyRepo("unsloth/unknown", "", "reasoning")).toBe("reasoning");
    expect(classifyRepo("unsloth/qwq-32b", "", "")).toBe("reasoning");
  });
  test("default fallthrough -> general", () => {
    expect(classifyRepo("unsloth/random-llm", "", "")).toBe("general");
  });
});

describe("discovery.eligibleGgufSiblings", () => {
  test("drops mmproj + fp16 dirs + multi-part shards", () => {
    const info: HFModelInfo = {
      id: "unsloth/test",
      siblings: [
        { rfilename: "model-UD-Q4_K_XL.gguf" },
        { rfilename: "mmproj-BF16.gguf" },
        { rfilename: "bf16/model-BF16.gguf" },
        { rfilename: "fp16/model-FP16.gguf" },
        { rfilename: "model-00001-of-00004.gguf" },
        { rfilename: "model-UD-Q3_K_M.gguf" },
        { rfilename: "README.md" },
      ],
    };
    expect(eligibleGgufSiblings(info)).toEqual(["model-UD-Q4_K_XL.gguf", "model-UD-Q3_K_M.gguf"]);
  });
});

describe("discovery.pickFile", () => {
  test("mac-mini prefers small quants", () => {
    const siblings = ["model-Q8_0.gguf", "model-UD-Q4_K_M.gguf", "model-UD-Q3_K_M.gguf"];
    expect(pickFile("mac-mini-16g", siblings)).toBe("model-UD-Q3_K_M.gguf");
  });
  test("macbook-pro-48g prefers UD-Q4_K_XL", () => {
    const siblings = ["model-Q8_0.gguf", "model-UD-Q4_K_XL.gguf", "model-UD-Q5_K_XL.gguf"];
    expect(pickFile("macbook-pro-48g", siblings)).toBe("model-UD-Q4_K_XL.gguf");
  });
  test("large-128g prefers UD-Q4_K_XL", () => {
    const siblings = ["model-Q8_0.gguf", "model-UD-Q4_K_XL.gguf", "model-UD-Q5_K_XL.gguf"];
    expect(pickFile("large-128g", siblings)).toBe("model-UD-Q4_K_XL.gguf");
  });
  test("falls back to the first sibling when nothing matches preferences", () => {
    const siblings = ["weird.gguf"];
    expect(pickFile("balanced", siblings)).toBe("weird.gguf");
  });
  test("empty siblings returns null", () => {
    expect(pickFile("balanced", [])).toBeNull();
  });
});

describe("discovery.fitScore", () => {
  test("ordinal mapping matches the sort key", () => {
    expect(fitScore("excellent")).toBe(5);
    expect(fitScore("good")).toBe(4);
    expect(fitScore("fair")).toBe(3);
    expect(fitScore("poor")).toBe(2);
    expect(fitScore("unknown")).toBe(1);
  });
});

describe("discovery.discoveryFit size tiers", () => {
  const GIB = 1024 ** 3;
  const FILE = "model.gguf";

  async function withSeededTree(
    fn: (
      probe: (repo: string, bytes: number, profile: MachineProfile) => Promise<DiscoveryFit>,
    ) => Promise<void>,
  ): Promise<void> {
    const runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-fit-"));
    const keys = [
      "LOCAL_AI_RUNTIME_DIR",
      "LOCAL_AI_RECOMMENDATIONS_SOURCE",
      "LOCAL_AI_HF_CACHE_TTL_SECONDS",
    ];
    const saved = new Map(keys.map((k) => [k, process.env[k]]));
    process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
    process.env["LOCAL_AI_RECOMMENDATIONS_SOURCE"] = "hf";
    process.env["LOCAL_AI_HF_CACHE_TTL_SECONDS"] = "3600";
    const probe = async (
      repo: string,
      bytes: number,
      profile: MachineProfile,
    ): Promise<DiscoveryFit> => {
      const tree = [{ type: "file", path: FILE, size: bytes, lfs: { size: bytes } }];
      writeFileSync(repoTreeCacheFile(runtimeDir, repo), JSON.stringify(tree));
      return await discoveryFit(profile, repo, "general", FILE);
    };
    try {
      await fn(probe);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  }

  test("large-128g tiers break at 72 / 96 / 112 GiB", async () => {
    await withSeededTree(async (probe) => {
      const repo = "meta/sizefit-neutral";
      expect(await probe(repo, 72 * GIB, "large-128g")).toBe("excellent");
      expect(await probe(repo, 72 * GIB + 1, "large-128g")).toBe("good");
      expect(await probe(repo, 96 * GIB, "large-128g")).toBe("good");
      expect(await probe(repo, 96 * GIB + 1, "large-128g")).toBe("fair");
      expect(await probe(repo, 112 * GIB, "large-128g")).toBe("fair");
      expect(await probe(repo, 112 * GIB + 1, "large-128g")).toBe("poor");
    });
  });

  test("a ~60 GiB 120b repo is poor on 48g but not on large-128g", async () => {
    await withSeededTree(async (probe) => {
      const repo = "meta/sizefit-120b";
      expect(await probe(repo, 60 * GIB, "macbook-pro-48g")).toBe("poor");
      expect(await probe(repo, 60 * GIB, "large-128g")).toBe("excellent");
    });
  });

  test("405b stays poor even on large-128g", async () => {
    await withSeededTree(async (probe) => {
      expect(await probe("meta/sizefit-405b", 60 * GIB, "large-128g")).toBe("poor");
    });
  });
});

describe("discovery.filterMatches", () => {
  test("`all` passes everything", () => {
    expect(filterMatches("all", "general", "unsloth/foo", "poor")).toBe(true);
  });
  test("class filters match on class", () => {
    expect(filterMatches("multimodal", "multimodal", "unsloth/x", "good")).toBe(true);
    expect(filterMatches("multimodal", "reasoning", "unsloth/x", "good")).toBe(false);
  });
  test("fits-* filters keep only excellent / good", () => {
    expect(filterMatches("fits-16g", "general", "x", "excellent")).toBe(true);
    expect(filterMatches("fits-16g", "general", "x", "good")).toBe(true);
    expect(filterMatches("fits-16g", "general", "x", "fair")).toBe(false);
    expect(filterMatches("fits-16g", "general", "x", "poor")).toBe(false);
  });
  test("fallback matches on repo substring", () => {
    expect(filterMatches("qwen", "general", "unsloth/qwen-2.5-7b", "fair")).toBe(true);
    expect(filterMatches("qwen", "general", "unsloth/gemma-4", "fair")).toBe(false);
  });
  test("fallback substring is case-insensitive (lowercase filter against mixed-case repo)", () => {
    // Real HF repos use mixed case: `unsloth/Qwen3.6-27B-GGUF`.
    // Operators type lowercase filters: `discover qwen3`.
    expect(filterMatches("qwen3", "general", "unsloth/Qwen3.6-27B-GGUF", "good")).toBe(true);
    expect(filterMatches("qwen3", "general", "unsloth/Qwen3.5-9B-GGUF", "good")).toBe(true);
    expect(filterMatches("GEMMA", "general", "unsloth/gemma-4-27B-it-GGUF", "good")).toBe(true);
    expect(filterMatches("qwen3", "general", "unsloth/gemma-4-27B-it-GGUF", "good")).toBe(false);
  });
});
