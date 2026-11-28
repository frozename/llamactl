import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

describe("#520 oMLX native unload session fence", () => {
  // Part of #520 / Kills: the native unload session check removed,
  // inlined unfenced, or undocumented.
  test("doc: the session affinity section pins the native unload fence", () => {
    const affinity = flat(sectionBody(sectionRe("session affinity")) ?? "");
    for (const needle of [
      "The library-only oMLX native unload (`runUnloadWithLeases` in `packages/remote/src/residency/engine-client.ts`) consults the session registry the same way (#520)",
      "a live session refuses the unload as `SessionsActive`",
      "a registry whose `checkUnload` throws refuses it as `SessionsUnknown`",
      "`createAgentOmlxNativeClient` captures the installed session registry at construction",
      "The native unload never releases sessions",
    ]) {
      expect(affinity, needle).toContain(needle);
    }
  });

  test("source: runUnloadWithLeases carries the session fence and the factory captures the seam", () => {
    const src = readOrEmpty(join(REPO, "packages/remote/src/residency/engine-client.ts"));
    const run = enclosingBody(src, "async function runUnloadWithLeases(");
    const drain = enclosingBody(src, "function drainRefusal(");
    expect(run, "shared drain check before either dispatch").toContain(
      "drainRefusal(leases, drain.token, drain.active)",
    );
    expect(run.indexOf("if (refusal !== null) return refusal;")).toBeLessThan(
      run.indexOf("await unloadWithLocalDrain"),
    );
    expect(run).toContain("await unloadWithDurableProof");
    expect(drain).toContain("sessionUnloadRefusal(leases.sessions, leases.workload)");
    expect(drain).toContain("leases.registry.cancelDrain(token)");

    const helper = enclosingBody(src, "function sessionUnloadRefusal(");
    expect(helper, "sessionUnloadRefusal body").not.toBe("");
    for (const pin of [
      ".checkUnload(workload)",
      "currentSessionRefcounts()",
      'reason: "SessionsActive"',
      'reason: "SessionsUnknown"',
    ]) {
      expect(helper, pin).toContain(pin);
    }
    for (const body of [run, drain, helper]) {
      expect(body).not.toContain("forceRelease");
      expect(body).not.toContain("force: true");
      expect(body).not.toContain("releaseSession");
    }

    const factory = enclosingBody(src, "export function createAgentOmlxNativeClient(");
    expect(factory, "createAgentOmlxNativeClient body").toContain("currentSessionRefcounts()");
  });
});
