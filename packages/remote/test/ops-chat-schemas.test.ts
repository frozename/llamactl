/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun's rejects/resolves matchers are typed as void. */
// packages/remote/test/ops-chat-schemas.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  OpsChatPlanProposedSchema,
  OpsChatStepOutcomeSchema,
  OpsChatStreamEventSchema,
} from "../src/ops-chat/loop-schema.js";
import {
  AbortedSchema,
  isTerminal,
  JournalEventSchema,
  PreviewOutcomeSchema,
  SessionStartedSchema,
  ToolTierEnum,
  WetOutcomeSchema,
} from "../src/ops-chat/sessions/journal-schema.js";
import { appendJournalEvent, journalPath, readJournal } from "../src/ops-chat/sessions/journal.js";
import { getSessionSummary } from "../src/ops-chat/sessions/list.js";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "../src/safe-fs.js";

const sessionStartedFixture = {
  type: "session_started",
  ts: "2026-04-25T00:00:00.000Z",
  sessionId: "s1",
  goal: "g",
  historyLen: 0,
  toolCount: 0,
} as const;
const planProposedFixture = {
  type: "plan_proposed",
  ts: "2026-04-25T00:00:01.000Z",
  stepId: "st1",
  iteration: 0,
  tier: "read",
  reasoning: "r",
  step: { tool: "llamactl.catalog.list", args: {}, annotation: "list" },
} as const;
const previewOutcomeFixture = {
  type: "preview_outcome",
  ts: "2026-04-25T00:00:02.000Z",
  stepId: "st1",
  ok: true,
  durationMs: 12,
} as const;
const wetOutcomeFixture = {
  type: "wet_outcome",
  ts: "2026-04-25T00:00:02.500Z",
  stepId: "st1",
  ok: true,
  durationMs: 12,
} as const;
const refusalFixture = { type: "refusal", ts: "2026-04-25T00:00:03.000Z", reason: "r" } as const;
const doneFixture = { type: "done", ts: "2026-04-25T00:00:04.000Z", iterations: 0 } as const;
const abortedFixture = {
  type: "aborted",
  ts: "2026-04-25T00:00:05.000Z",
  reason: "client_abort",
} as const;

describe("OpsChatStreamEventSchema / loop-schema", () => {
  const validPlanProposed = {
    type: "plan_proposed",
    sessionId: "s1",
    stepId: "st1",
    iteration: 0,
    step: { tool: "llamactl.catalog.list", args: { limit: 5 }, annotation: "list" },
    tier: "read",
    reasoning: "r",
  } as const;

  test("plan_proposed parses and preserves step args", () => {
    expect(OpsChatStreamEventSchema.parse(validPlanProposed)).toEqual(validPlanProposed);
  });

  test("plan_proposed step without args defaults args to {}", () => {
    const input = {
      ...validPlanProposed,
      step: { tool: "llamactl.catalog.list", annotation: "list" },
    };
    const parsed = OpsChatPlanProposedSchema.parse(input);
    expect(parsed.step.args).toEqual({});
  });

  test.each([
    ["negative iteration", { ...validPlanProposed, iteration: -1 }],
    ["non-integer iteration", { ...validPlanProposed, iteration: 1.5 }],
    ["unknown tier", { ...validPlanProposed, tier: "admin" }],
    ["empty sessionId", { ...validPlanProposed, sessionId: "" }],
    ["empty stepId", { ...validPlanProposed, stepId: "" }],
    [
      "empty step annotation",
      { ...validPlanProposed, step: { tool: "llamactl.catalog.list", args: {}, annotation: "" } },
    ],
  ])("plan_proposed rejects %s", (_label, input) => {
    expect(OpsChatStreamEventSchema.safeParse(input).success).toBe(false);
  });

  test("refusal with empty reason is rejected", () => {
    expect(OpsChatStreamEventSchema.safeParse({ type: "refusal", reason: "" }).success).toBe(false);
  });

  test("refusal with a reason parses", () => {
    expect(OpsChatStreamEventSchema.parse({ type: "refusal", reason: "nope" })).toEqual({
      type: "refusal",
      reason: "nope",
    });
  });

  test("done with zero iterations parses", () => {
    expect(OpsChatStreamEventSchema.parse({ type: "done", iterations: 0 })).toEqual({
      type: "done",
      iterations: 0,
    });
  });

  test("done with negative iterations is rejected", () => {
    expect(OpsChatStreamEventSchema.safeParse({ type: "done", iterations: -1 }).success).toBe(
      false,
    );
  });

  test("stream event union rejects aborted", () => {
    expect(
      OpsChatStreamEventSchema.safeParse({ type: "aborted", reason: "client_abort" }).success,
    ).toBe(false);
  });

  test("step outcome without abort defaults abort to false", () => {
    const parsed = OpsChatStepOutcomeSchema.parse({
      sessionId: "s1",
      stepId: "st1",
      ok: true,
      summary: "done",
    });
    expect(parsed.abort).toBe(false);
  });

  test("step outcome abort true round-trips", () => {
    const parsed = OpsChatStepOutcomeSchema.parse({
      sessionId: "s1",
      stepId: "st1",
      ok: true,
      summary: "done",
      abort: true,
    });
    expect(parsed.abort).toBe(true);
  });

  test("step outcome ok false with summary parses", () => {
    const parsed = OpsChatStepOutcomeSchema.parse({
      sessionId: "s1",
      stepId: "st1",
      ok: false,
      summary: "boom",
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.summary).toBe("boom");
  });

  test("step outcome with empty sessionId is rejected", () => {
    expect(
      OpsChatStepOutcomeSchema.safeParse({
        sessionId: "",
        stepId: "st1",
        ok: true,
        summary: "done",
      }).success,
    ).toBe(false);
  });
});

describe("JournalEventSchema / journal-schema", () => {
  test("ToolTierEnum options are the three safety tiers in order", () => {
    expect(ToolTierEnum.options).toEqual(["read", "mutation-dry-run-safe", "mutation-destructive"]);
  });

  test("session_started without nodeId or model omits those keys", () => {
    const parsed = SessionStartedSchema.parse(sessionStartedFixture);
    expect("nodeId" in parsed).toBe(false);
    expect("model" in parsed).toBe(false);
  });

  test.each([
    ["empty goal", { ...sessionStartedFixture, goal: "" }],
    ["negative historyLen", { ...sessionStartedFixture, historyLen: -1 }],
    [
      "missing ts",
      { type: "session_started", sessionId: "s1", goal: "g", historyLen: 0, toolCount: 0 },
    ],
  ])("session_started rejects %s", (_label, input) => {
    expect(SessionStartedSchema.safeParse(input).success).toBe(false);
  });

  test("preview_outcome accepts a full outcome body", () => {
    const event = {
      ...previewOutcomeFixture,
      result: { n: 1 },
      resultRedacted: "truncated" as const,
    };
    expect(PreviewOutcomeSchema.parse(event)).toEqual(event);
  });

  test("wet_outcome accepts a full outcome body", () => {
    const event = {
      ...wetOutcomeFixture,
      result: { n: 1 },
      resultRedacted: "truncated" as const,
    };
    expect(WetOutcomeSchema.parse(event)).toEqual(event);
  });

  test.each([
    ["resultRedacted", { resultRedacted: "partial" }],
    ["durationMs", { durationMs: 1.5 }],
  ])("outcome schemas reject invalid %s", (_field, patch) => {
    const preview = { ...previewOutcomeFixture, ...patch };
    const wet = { ...wetOutcomeFixture, ...patch };
    expect(PreviewOutcomeSchema.safeParse(preview).success).toBe(false);
    expect(WetOutcomeSchema.safeParse(wet).success).toBe(false);
  });

  test("outcome error object is accepted", () => {
    const error = { code: "E", message: "m" };
    const preview = { ...previewOutcomeFixture, ok: false, error };
    const wet = { ...wetOutcomeFixture, ok: false, error };
    expect(PreviewOutcomeSchema.parse(preview)).toEqual(preview);
    expect(WetOutcomeSchema.parse(wet)).toEqual(wet);
  });

  test.each(["client_abort", "signal", "timeout"])("aborted accepts reason %s", (reason) => {
    const parsed = AbortedSchema.parse({ type: "aborted", ts: "t", reason });
    expect(parsed.reason).toBe(reason);
  });

  test("aborted rejects reason crash", () => {
    expect(AbortedSchema.safeParse({ type: "aborted", ts: "t", reason: "crash" }).success).toBe(
      false,
    );
  });

  test("JournalEventSchema rejects an unknown event type", () => {
    expect(JournalEventSchema.safeParse({ type: "unknown", ts: "t" }).success).toBe(false);
  });

  test("JournalEventSchema accepts a minimal fixture of each event type", () => {
    expect(JournalEventSchema.parse(sessionStartedFixture).type).toBe("session_started");
    expect(JournalEventSchema.parse(planProposedFixture).type).toBe("plan_proposed");
    expect(JournalEventSchema.parse(previewOutcomeFixture).type).toBe("preview_outcome");
    expect(JournalEventSchema.parse(wetOutcomeFixture).type).toBe("wet_outcome");
    expect(JournalEventSchema.parse(refusalFixture).type).toBe("refusal");
    expect(JournalEventSchema.parse(doneFixture).type).toBe("done");
    expect(JournalEventSchema.parse(abortedFixture).type).toBe("aborted");
  });

  test("isTerminal returns true for done, refusal and aborted", () => {
    expect(isTerminal(JournalEventSchema.parse(doneFixture))).toBe(true);
    expect(isTerminal(JournalEventSchema.parse(refusalFixture))).toBe(true);
    expect(isTerminal(JournalEventSchema.parse(abortedFixture))).toBe(true);
  });

  test("isTerminal returns false for non-terminal event types", () => {
    expect(isTerminal(JournalEventSchema.parse(sessionStartedFixture))).toBe(false);
    expect(isTerminal(JournalEventSchema.parse(planProposedFixture))).toBe(false);
    expect(isTerminal(JournalEventSchema.parse(previewOutcomeFixture))).toBe(false);
    expect(isTerminal(JournalEventSchema.parse(wetOutcomeFixture))).toBe(false);
  });
});

describe("readJournal / getSessionSummary schema gating", () => {
  let tmp: string;
  let prevDevStorage: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ops-schemas-"));
    prevDevStorage = process.env["DEV_STORAGE"];
    process.env["DEV_STORAGE"] = tmp;
  });

  afterEach(() => {
    if (prevDevStorage === undefined) delete process.env["DEV_STORAGE"];
    else process.env["DEV_STORAGE"] = prevDevStorage;
    rmSync(tmp, { recursive: true, force: true });
  });

  function rawLine(id: string, obj: unknown): void {
    mkdirSync(dirname(journalPath(id)), { recursive: true });
    appendFileSync(journalPath(id), JSON.stringify(obj) + "\n", "utf8");
  }

  test("readJournal drops lines that fail the event schema", async () => {
    await appendJournalEvent("s-gate", {
      type: "session_started",
      ts: "2026-04-25T00:00:00.000Z",
      sessionId: "s-gate",
      goal: "g",
      historyLen: 0,
      toolCount: 0,
    });
    rawLine("s-gate", { type: "aborted", ts: "t", reason: "crash" });
    rawLine("s-gate", { type: "done", ts: "t", iterations: -1 });
    rawLine("s-gate", { type: "mystery", ts: "t" });
    await appendJournalEvent("s-gate", {
      type: "done",
      ts: "2026-04-25T00:00:01.000Z",
      iterations: 0,
    });
    const events = await readJournal("s-gate");
    expect(events.map((e) => e.type)).toEqual(["session_started", "done"]);
  });

  test("getSessionSummary reports refused status with endedAt", async () => {
    await appendJournalEvent("s-ref", {
      type: "session_started",
      ts: "2026-04-25T00:00:00.000Z",
      sessionId: "s-ref",
      goal: "g",
      historyLen: 0,
      toolCount: 0,
    });
    await appendJournalEvent("s-ref", {
      type: "refusal",
      ts: "2026-04-25T00:00:02.000Z",
      reason: "r",
    });
    const summary = await getSessionSummary("s-ref");
    expect(summary.status).toBe("refused");
    expect(summary.endedAt).toBe("2026-04-25T00:00:02.000Z");
  });

  test("getSessionSummary reports aborted status with endedAt", async () => {
    await appendJournalEvent("s-abort", {
      type: "session_started",
      ts: "2026-04-25T00:00:00.000Z",
      sessionId: "s-abort",
      goal: "g",
      historyLen: 0,
      toolCount: 0,
    });
    await appendJournalEvent("s-abort", {
      type: "aborted",
      ts: "2026-04-25T00:00:03.000Z",
      reason: "signal",
    });
    const summary = await getSessionSummary("s-abort");
    expect(summary.status).toBe("aborted");
    expect(summary.endedAt).toBe("2026-04-25T00:00:03.000Z");
  });

  test("getSessionSummary rejects when the only event fails the schema", async () => {
    await appendJournalEvent("s-bad", {
      type: "session_started",
      ts: "2026-04-25T00:00:00.000Z",
      sessionId: "s-bad",
      goal: "",
      historyLen: 0,
      toolCount: 0,
    });
    expect(existsSync(journalPath("s-bad"))).toBe(true);
    expect((await readJournal("s-bad")).length).toBe(0);
    await expect(getSessionSummary("s-bad")).rejects.toThrow("has no session_started event");
  });
});
