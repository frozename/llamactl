import { describe, expect, test } from "bun:test";

import { serverStartOutcome } from "../../../src/modules/chat/server-start-outcome";

describe("serverStartOutcome", () => {
  test("a done event with ok:true is a successful start", () => {
    expect(serverStartOutcome({ type: "done", result: { ok: true, pid: 42 } })).toBe("started");
  });

  test("a done event with ok:false is a failed start, not one still in progress", () => {
    expect(
      serverStartOutcome({
        type: "done",
        result: {
          ok: false,
          pid: null,
          error:
            "refusing to bind llama-server to 0.0.0.0 without `allowExternalBind: true` in the workload spec",
        },
      }),
    ).toBe("failed");
  });

  test("progress events leave the start pending", () => {
    expect(serverStartOutcome({ type: "launch", pid: 42 })).toBe("pending");
    expect(serverStartOutcome({ type: "ready" })).toBe("pending");
    expect(serverStartOutcome(null)).toBe("pending");
  });
});
