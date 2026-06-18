import { describe, expect, test } from "bun:test";

import { generateToken } from "../src/server/auth.js";
import { type RunningAgent, startAgentServer } from "../src/server/serve.js";

/**
 * Process-level handler hygiene. `startAgentServer` installs an
 * `uncaughtException` + `unhandledRejection` handler so transient
 * async leaks log-and-continue instead of killing the agent under
 * launchd. Those handlers must be REMOVED on `stop()` — otherwise
 * repeated start/stop (tests, restart loops) accumulates two extra
 * process listeners per call: the MaxListeners warning fires, and a
 * single fatal would be logged once per still-installed handler.
 */
describe("startAgentServer — process handler cleanup", () => {
  test("uncaughtException + unhandledRejection listener counts return to baseline after stop", async () => {
    const { hash } = generateToken();

    const baselineUncaught = process.listenerCount("uncaughtException");
    const baselineUnhandled = process.listenerCount("unhandledRejection");

    // Each start installs exactly one of each; each stop must remove
    // exactly the pair it installed. Run several cycles so an
    // accumulating leak is unambiguous.
    for (let i = 0; i < 5; i++) {
      const server: RunningAgent = startAgentServer({ tokenHash: hash });
      // While running, both listener counts are above baseline.
      expect(process.listenerCount("uncaughtException")).toBeGreaterThan(baselineUncaught);
      expect(process.listenerCount("unhandledRejection")).toBeGreaterThan(baselineUnhandled);
      await server.stop();
      // After stop, the pair installed by this call is gone again.
      expect(process.listenerCount("uncaughtException")).toBe(baselineUncaught);
      expect(process.listenerCount("unhandledRejection")).toBe(baselineUnhandled);
    }

    // Net zero across all cycles — no accumulation.
    expect(process.listenerCount("uncaughtException")).toBe(baselineUncaught);
    expect(process.listenerCount("unhandledRejection")).toBe(baselineUnhandled);
  });
});
