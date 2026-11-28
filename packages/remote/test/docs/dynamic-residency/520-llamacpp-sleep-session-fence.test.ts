import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  enclosingBody,
  expectPins,
  flat,
  readOrEmpty,
  REPO,
  sectionBody,
  SECTIONS,
} from "./helpers.js";

// Part of #520
// Kills: shipping the llama.cpp sleep session fence undocumented, placing the
// fence after requestSleep, or wiring it through a lazy process-wide lookup.
describe("#520 llama.cpp sleep session fence documentation", () => {
  test("D1 the sleep and wake section pins the session fence contract", () => {
    const body = flat(sectionBody(SECTIONS.sleepWake) ?? "");
    expectPins(body, "sleep and wake section", [
      "`createAgentLlamacppSleepDriver`",
      "`checkUnload`",
      "`SessionsActive`",
      "`SessionsUnknown`",
      "no `POST /sleep`",
      "never releases sessions",
      "`llamactl residency release-session <sessionId> --yes --node <name>`",
    ]);
  });

  test("D2 the source carries the fence before requestSleep and captures the registry", () => {
    const src = readOrEmpty(join(REPO, "packages/remote/src/residency/llamacpp-sleep-client.ts"));
    const sleepBody = enclosingBody(src, "async function sleepWithDrain(");
    expectPins(sleepBody, "llama.cpp sleep body", [
      "sessionUnloadRefusal(",
      "controller.requestSleep(",
    ]);
    expect(sleepBody.indexOf("sessionUnloadRefusal(")).toBeLessThan(
      sleepBody.indexOf("controller.requestSleep("),
    );

    const factoryBody = enclosingBody(src, "export function createAgentLlamacppSleepDriver(");
    expect(factoryBody, "agent factory body").toContain("currentSessionRefcounts()");

    const engineSrc = readOrEmpty(join(REPO, "packages/remote/src/residency/engine-client.ts"));
    expect(engineSrc, "engine-client sessionUnloadRefusal export").toContain(
      "export function sessionUnloadRefusal(",
    );
  });
});
