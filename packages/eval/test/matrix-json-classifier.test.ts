import { describe, expect, test } from "bun:test";

import {
  buildJsonClassifierWorkload,
  memoryEfficacy4wayWorkload,
  memoryEfficacyBinaryWorkload,
} from "../src/index.js";

interface ChatRow {
  messages: { role: string; content: string }[];
}

interface ClassifierScore {
  metrics: { correct: number };
  prediction: string;
  gold: string;
}

function helperRow(goldContent: string): ChatRow {
  return {
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      { role: "assistant", content: goldContent },
    ],
  };
}

describe("buildJsonClassifierWorkload — prompt_builder drops final message", () => {
  test("with 3 messages, prompt returns 2, final dropped", () => {
    const wl = buildJsonClassifierWorkload({
      name: "test-drop",
      corpus_path: "/unused",
      labelField: "classification",
      validLabels: new Set(["a", "b"]),
    });
    const row = helperRow(JSON.stringify({ classification: "a", reason: "r" }));
    const msgs = wl.prompt_builder(row).messages as { role: string; content: string }[];
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.role).toBe("user");
  });
});

describe("buildJsonClassifierWorkload — embedded-JSON fallback (4way)", () => {
  const scorer = (row: unknown, completion: string): ClassifierScore =>
    memoryEfficacy4wayWorkload.scorer(row, completion) as ClassifierScore;

  test("Sure. recall_miss JSON Done. text → pred=recall_miss, gold=recall_miss, correct=1", () => {
    const r = scorer(
      helperRow(JSON.stringify({ classification: "recall_miss", reason: "g" })),
      'Sure. {"classification":"recall_miss","reason":"r"} Done.',
    );
    expect(r.prediction).toBe("recall_miss");
    expect(r.gold).toBe("recall_miss");
    expect(r.metrics.correct).toBe(1);
  });
});

describe("buildJsonClassifierWorkload — fence with no language tag", () => {
  const scorer = (row: unknown, completion: string): ClassifierScore =>
    memoryEfficacy4wayWorkload.scorer(row, completion) as ClassifierScore;

  test("```-fence without lang tag parses to memory_ignored", () => {
    const r = scorer(
      helperRow(JSON.stringify({ classification: "memory_ignored", reason: "g" })),
      '```\n{"classification":"memory_ignored","reason":"r"}\n```\nnote {x}',
    );
    expect(r.prediction).toBe("memory_ignored");
  });
});

describe("buildJsonClassifierWorkload — label outside validLabels", () => {
  const scorer = (row: unknown, completion: string): ClassifierScore =>
    memoryEfficacy4wayWorkload.scorer(row, completion) as ClassifierScore;

  test("bogus classification value → parse_error", () => {
    const r = scorer(
      helperRow(JSON.stringify({ classification: "bogus", reason: "g" })),
      JSON.stringify({ classification: "bogus", reason: "r" }),
    );
    expect(r.prediction).toBe("parse_error");
  });
});

describe("buildJsonClassifierWorkload — missing label field", () => {
  const scorer = (row: unknown, completion: string): ClassifierScore =>
    memoryEfficacy4wayWorkload.scorer(row, completion) as ClassifierScore;

  test("object with only reason key → parse_error", () => {
    const r = scorer(
      helperRow(JSON.stringify({ classification: "recall_miss", reason: "g" })),
      JSON.stringify({ reason: "r" }),
    );
    expect(r.prediction).toBe("parse_error");
  });

  test("classification=null → parse_error", () => {
    const r = scorer(
      helperRow(JSON.stringify({ classification: "recall_miss", reason: "g" })),
      JSON.stringify({ classification: null }),
    );
    expect(r.prediction).toBe("parse_error");
  });

  test("non-JSON text → parse_error", () => {
    const r = scorer(
      helperRow(JSON.stringify({ classification: "recall_miss", reason: "g" })),
      "some plain text",
    );
    expect(r.prediction).toBe("parse_error");
  });
});

describe("buildJsonClassifierWorkload — 4way enum pin (end-to-end behaviour only)", () => {
  const scorer = (row: unknown, completion: string): ClassifierScore =>
    memoryEfficacy4wayWorkload.scorer(row, completion) as ClassifierScore;

  // "3" is not in the validLabels set, so it would be rejected even without the custom normalizeLabel.
  test("classification=3 (integer) → parse_error (pins end-to-end behaviour only)", () => {
    const r = scorer(
      helperRow(JSON.stringify({ classification: "recall_miss", reason: "g" })),
      JSON.stringify({ classification: 3 }),
    );
    expect(r.prediction).toBe("parse_error");
  });
});

describe("buildJsonClassifierWorkload — binary (no validLabels, normalizeLabel is the only guard)", () => {
  const scorer = (row: unknown, completion: string): ClassifierScore =>
    memoryEfficacyBinaryWorkload.scorer(row, completion) as ClassifierScore;

  test('memory_related=false boolean → prediction "false"', () => {
    const r = scorer(
      helperRow(JSON.stringify({ memory_related: false, reason: "g" })),
      JSON.stringify({ memory_related: false, reason: "r" }),
    );
    expect(r.prediction).toBe("false");
  });

  // Only booleans are accepted by normalizeLabel, so the string "true" is rejected.
  test('memory_related="true" (string) → parse_error (normalizeLabel guard)', () => {
    const r = scorer(
      helperRow(JSON.stringify({ memory_related: true, reason: "g" })),
      JSON.stringify({ memory_related: "true" }),
    );
    expect(r.prediction).toBe("parse_error");
  });

  test("mismatched gold (pred true, gold false) → correct 0", () => {
    const r = scorer(
      helperRow(JSON.stringify({ memory_related: false, reason: "g" })),
      JSON.stringify({ memory_related: true, reason: "r" }),
    );
    expect(r.metrics.correct).toBe(0);
  });

  // Pin this as current behaviour: when both sides are unparseable, prediction and gold are
  // both "parse_error" and correct is 1.
  test("both sides unparseable → prediction=gold=parse_error, correct=1", () => {
    const r = scorer(
      helperRow(JSON.stringify({ memory_related: "not-a-boolean", reason: "g" })),
      JSON.stringify({ memory_related: "also-not-a-boolean" }),
    );
    expect(r.prediction).toBe("parse_error");
    expect(r.gold).toBe("parse_error");
    expect(r.metrics.correct).toBe(1);
  });
});

describe("buildJsonClassifierWorkload — custom normalizeLabel takes precedence", () => {
  const wl = buildJsonClassifierWorkload({
    name: "x",
    corpus_path: "/unused",
    labelField: "label",
    validLabels: new Set(["3", "y"]),
    normalizeLabel: (v: unknown) => (typeof v === "string" ? v : "parse_error"),
  });

  test('custom normalizeLabel scores label=3 (int) as "parse_error"', async () => {
    const r = (await wl.scorer(
      {
        messages: [
          { role: "user", content: "u" },
          { role: "assistant", content: JSON.stringify({ label: 3 }) },
        ],
      },
      JSON.stringify({ label: 3 }),
    )) as ClassifierScore;
    expect(r.prediction).toBe("parse_error");
  });

  test('same options without normalizeLabel scores label=3 (int) as "3"', () => {
    const wlNoNorm = buildJsonClassifierWorkload({
      name: "x",
      corpus_path: "/unused",
      labelField: "label",
      validLabels: new Set(["3", "y"]),
    });
    const r = wlNoNorm.scorer(
      {
        messages: [
          { role: "user", content: "u" },
          { role: "assistant", content: JSON.stringify({ label: 3 }) },
        ],
      },
      JSON.stringify({ label: 3 }),
    ) as ClassifierScore;
    expect(r.prediction).toBe("3");
  });
});

describe("buildJsonClassifierWorkload — default normalize with no validLabels", () => {
  test('scores label=42 (int) as "42"', () => {
    const wl = buildJsonClassifierWorkload({
      name: "x",
      corpus_path: "/unused",
      labelField: "label",
    });
    const r = wl.scorer(
      {
        messages: [
          { role: "user", content: "u" },
          { role: "assistant", content: JSON.stringify({ label: 42 }) },
        ],
      },
      JSON.stringify({ label: 42 }),
    ) as ClassifierScore;
    expect(r.prediction).toBe("42");
  });

  test('scores label=null → "parse_error" (pins raw===null guard)', () => {
    const wl = buildJsonClassifierWorkload({
      name: "x",
      corpus_path: "/unused",
      labelField: "label",
    });
    const r = wl.scorer(
      {
        messages: [
          { role: "user", content: "u" },
          { role: "assistant", content: JSON.stringify({ label: "gold" }) },
        ],
      },
      JSON.stringify({ label: null }),
    ) as ClassifierScore;
    expect(r.prediction).toBe("parse_error");
  });
});

describe("buildJsonClassifierWorkload — response_format schema name", () => {
  test('name "a-b.c d" → json_schema.name "a_b_c_d"', () => {
    const wl = buildJsonClassifierWorkload({
      name: "a-b.c d",
      corpus_path: "/unused",
      labelField: "label",
      validLabels: new Set(["y", "n"]),
    });
    const responseFormat = wl.response_format as
      | {
          type?: string;
          json_schema?: {
            name?: string;
            schema?: {
              properties?: Record<string, unknown>;
              required?: string[];
            };
          };
        }
      | undefined;
    expect(responseFormat?.json_schema?.name).toBe("a_b_c_d");
  });

  test('without requireReason, required equals [label] and no "reason" key in properties', () => {
    const wl = buildJsonClassifierWorkload({
      name: "a-b.c d",
      corpus_path: "/unused",
      labelField: "label",
      validLabels: new Set(["y", "n"]),
    });
    const responseFormat = wl.response_format as
      | {
          type?: string;
          json_schema?: {
            name?: string;
            schema?: {
              properties?: Record<string, unknown>;
              required?: string[];
            };
          };
        }
      | undefined;
    const schema = responseFormat?.json_schema?.schema as
      | {
          properties?: Record<string, unknown>;
          required?: string[];
        }
      | undefined;
    expect(schema?.required).toEqual(["label"]);
    expect("reason" in (schema?.properties ?? {})).toBe(false);
  });
});
