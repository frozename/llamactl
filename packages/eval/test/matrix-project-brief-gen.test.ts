import { describe, expect, test } from "bun:test";

import { projectBriefGenWorkload } from "../src/matrix/workloads/project-brief-gen.js";

const row = {
  id: "r1",
  project_id: "proj-x",
  window_start: "2026-05-01",
  window_end: "2026-05-07",
  memories: [
    {
      memory_id: "m1",
      title: "First",
      body: "Body one",
      obs_type: "",
      created_at: "2026-05-02T03:04:05.000Z",
    },
    {
      memory_id: "m2",
      title: "Second",
      body: "Body two",
      obs_type: "",
      created_at: "2026-05-03T00:00:00Z",
    },
  ],
};

type BriefScore = Awaited<ReturnType<typeof projectBriefGenWorkload.scorer>>;

async function score(completion: string): Promise<BriefScore> {
  return await projectBriefGenWorkload.scorer({}, completion);
}

describe("project-brief-gen workload static config", () => {
  test("pins name, corpus_path, primary_metric_name, maxTokens, temperature", () => {
    expect(projectBriefGenWorkload.name).toBe("project-brief-gen");
    expect(projectBriefGenWorkload.corpus_path).toBe(
      "packages/eval/corpora/project-brief-gen/v0/test.jsonl",
    );
    expect(projectBriefGenWorkload.primary_metric_name).toBe("mean_brief_quality");
    expect(projectBriefGenWorkload.maxTokens).toBe(2048);
    expect(projectBriefGenWorkload.temperature).toBe(0.3);
  });
});

describe("project-brief-gen prompt_builder", () => {
  test("returns 2 messages with system then user roles", () => {
    const msgs = projectBriefGenWorkload.prompt_builder(row).messages as {
      role: string;
      content: string;
    }[];
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!.role).toBe("user");
  });

  test("system content contains section headers instruction", () => {
    const msgs = projectBriefGenWorkload.prompt_builder(row).messages as {
      role: string;
      content: string;
    }[];
    expect(msgs[0]!.content).toContain("## section headers");
  });

  test("user content formats memories with 1-based numbering and date truncation", () => {
    const msgs = projectBriefGenWorkload.prompt_builder(row).messages as {
      role: string;
      content: string;
    }[];
    expect(msgs[1]!.content).toBe(
      "Project: proj-x | Period: 2026-05-01 to 2026-05-07\n\nRecent memories:\n\n1. **First** (2026-05-02)\nBody one\n\n2. **Second** (2026-05-03)\nBody two\n\nWrite a project brief covering the above activity.",
    );
  });
});

describe("project-brief-gen scorer — token_count_score", () => {
  test("len 2400 → 600 tokens → score 0.5", async () => {
    const r = await score("x".repeat(2400));
    expect(r.metrics["token_count_score"]).toBe(0.5);
    expect(r.metrics["estimated_tokens"]).toBe(600);
  });

  test("len 4800 → 1200 tokens → score 1, also assert estimated_tokens", async () => {
    const r = await score("x".repeat(4800));
    expect(r.metrics["token_count_score"]).toBe(1);
    expect(r.metrics["estimated_tokens"]).toBe(1200);
  });

  test("len 9600 → 2400 tokens → score 1 (value only, continuous at the bound)", async () => {
    const r = await score("x".repeat(9600));
    expect(r.metrics["token_count_score"]).toBe(1);
  });

  test("len 14400 → 3600 tokens → score 0.5", async () => {
    const r = await score("x".repeat(14400));
    expect(r.metrics["token_count_score"]).toBe(0.5);
  });

  test("len 19200 → 4800 tokens → score 0", async () => {
    const r = await score("x".repeat(19200));
    expect(r.metrics["token_count_score"]).toBe(0);
  });

  test("len 24000 → 6000 tokens → score exactly 0 (pins the clamp)", async () => {
    const r = await score("x".repeat(24000));
    expect(r.metrics["token_count_score"]).toBe(0);
  });
});

describe("project-brief-gen scorer — structure_score", () => {
  test("3 ## lines → structure_score 1, section_count 3", async () => {
    const r = await score("## A\nx\n## B\ny\n## C\nz");
    expect(r.metrics["structure_score"]).toBe(1);
    expect(r.metrics["section_count"]).toBe(3);
  });

  test("2 ## lines → structure_score 0.5, section_count 2", async () => {
    const r = await score("## A\nx\n## B\ny");
    expect(r.metrics["structure_score"]).toBe(0.5);
    expect(r.metrics["section_count"]).toBe(2);
  });

  test("1 ## line → structure_score 0, section_count 1", async () => {
    const r = await score("## A\nx");
    expect(r.metrics["structure_score"]).toBe(0);
    expect(r.metrics["section_count"]).toBe(1);
  });

  test("### Sub and '  ## indented' do not count as sections", async () => {
    const r = await score("### Sub\nx\n  ## indented\ny");
    expect(r.metrics["section_count"]).toBe(0);
    expect(r.metrics["structure_score"]).toBe(0);
  });
});

describe("project-brief-gen scorer — paragraph_score", () => {
  test("4 paragraphs → paragraph_score 1", async () => {
    const r = await score("a\n\nb\n\nc\n\nd");
    expect(r.metrics["paragraph_score"]).toBe(1);
    expect(r.metrics["paragraph_count"]).toBe(4);
  });

  test("3 paragraphs → paragraph_score 0.5", async () => {
    const r = await score("a\n\nb\n\nc");
    expect(r.metrics["paragraph_score"]).toBe(0.5);
    expect(r.metrics["paragraph_count"]).toBe(3);
  });

  test("2 paragraphs → paragraph_score 0", async () => {
    const r = await score("a\n\nb");
    expect(r.metrics["paragraph_score"]).toBe(0);
    expect(r.metrics["paragraph_count"]).toBe(2);
  });

  test("whitespace-only lines count as blank lines for paragraph splitting", async () => {
    const r = await score("a\n   \nb");
    expect(r.metrics["paragraph_count"]).toBe(2);
  });
});

describe("project-brief-gen scorer — composite brief_quality", () => {
  test('"x".repeat(4800) has token=1, sections=0, paragraphs=1 → brief_quality ≈ 1/3', async () => {
    const r = await score("x".repeat(4800));
    expect(r.metrics["brief_quality"]).toBeCloseTo(1 / 3);
  });
});

describe("project-brief-gen scorer — empty completion", () => {
  test("empty string → all metrics 0, prediction shows zeros", async () => {
    const r = await score("");
    expect(r.metrics["token_count_score"]).toBe(0);
    expect(r.metrics["structure_score"]).toBe(0);
    expect(r.metrics["paragraph_score"]).toBe(0);
    expect(r.metrics["brief_quality"]).toBe(0);
    expect(r.metrics["estimated_tokens"]).toBe(0);
    expect(r.metrics["section_count"]).toBe(0);
    expect(r.metrics["paragraph_count"]).toBe(0);
    expect(r.prediction).toBe("tokens=0 sections=0 paragraphs=0");
    expect(r.gold).toBe("n/a");
  });
});

describe("project-brief-gen scorer — prediction format", () => {
  test("prediction format is tokens=<n> sections=<s> paragraphs=<p>", async () => {
    const r = await score("## A\nx\n## B\ny\n## C\nz\na\n\nb\n\nc\n\nd");
    expect(r.prediction).toMatch(/^tokens=\d+ sections=\d+ paragraphs=\d+$/);
  });
});
