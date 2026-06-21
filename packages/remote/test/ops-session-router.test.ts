import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionEventBus } from "../src/ops-chat/sessions/event-bus";
import { appendJournalEvent } from "../src/ops-chat/sessions/journal";
import { router } from "../src/router";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

describe("ops-session router", () => {
  let tmp: string;
  let prev: string | undefined;
  let caller: ReturnType<typeof router.createCaller>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ops-router-"));
    prev = process.env["DEV_STORAGE"];
    process.env["DEV_STORAGE"] = tmp;
    caller = router.createCaller({});
  });

  afterEach(() => {
    if (prev === undefined) delete process.env["DEV_STORAGE"];
    else process.env["DEV_STORAGE"] = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("opsSessionList returns recently-started sessions", async () => {
    await appendJournalEvent("s-a", {
      type: "session_started",
      ts: "2026-04-25T00:00:00.000Z",
      sessionId: "s-a",
      goal: "audit",
      historyLen: 0,
      toolCount: 0,
    });
    const out = await caller.opsSessionList({ limit: 10 });
    expect(out.sessions.length).toBe(1);
    expect(out.sessions[0]!.sessionId).toBe("s-a");
  });

  test("opsSessionDelete rejects in-flight", async () => {
    sessionEventBus.create("s-live");
    await appendJournalEvent("s-live", {
      type: "session_started",
      ts: "2026-04-25T00:00:00.000Z",
      sessionId: "s-live",
      goal: "g",
      historyLen: 0,
      toolCount: 0,
    });
    await caller.opsSessionDelete({ sessionId: "s-live" }).then(
      () => {
        throw new Error("expected opsSessionDelete to reject");
      },
      (error: unknown) => {
        expect(() => {
          throw error;
        }).toThrow();
      },
    );
    sessionEventBus.close("s-live");
  });

  test("opsSessionWatch replays journal then closes for a terminated session", async () => {
    await appendJournalEvent("s-old", {
      type: "session_started",
      ts: "2026-04-25T00:00:00.000Z",
      sessionId: "s-old",
      goal: "g",
      historyLen: 0,
      toolCount: 0,
    });
    await appendJournalEvent("s-old", {
      type: "done",
      ts: "2026-04-25T00:00:01.000Z",
      iterations: 0,
    });
    const events: { type: string }[] = [];
    const stream = await caller.opsSessionWatch({ sessionId: "s-old" });
    for await (const e of stream) {
      events.push(e);
    }
    expect(events.map((e) => e.type)).toEqual(["session_started", "done"]);
  });
});
