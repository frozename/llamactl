import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  enclosingBody,
  expectPins,
  flat,
  readOrEmpty,
  REPO,
  sectionBody,
  sectionRe,
} from "./helpers.js";

// Part of #520
// Kills: refreshing the binding on cache hits undocumented, or the touchSessionOnCacheHit helper removed or not wired.
describe("#520 response-cache hit session refresh", () => {
  test("session affinity documents the cache-hit touch and proxyOpenAI wires it", () => {
    const affinity = flat(sectionBody(sectionRe("session affinity")) ?? "");
    expectPins(affinity, "session affinity", [
      "A response-cache hit served for a session's bound local workload refreshes the binding through `touch`",
      "`touchSessionOnCacheHit`",
      "it takes no ref and no lease",
      "a registry that throws on `touch` still serves the cached response",
    ]);
    const proxySrc = readOrEmpty(join(REPO, "packages/core/src/openaiProxy.ts"));
    const touchBody = enclosingBody(proxySrc, "function touchSessionOnCacheHit(");
    expect(touchBody, "touchSessionOnCacheHit signature").not.toBe("");
    expectPins(touchBody, "touchSessionOnCacheHit", [".touch(", "isPeer"]);
    const proxyBody = enclosingBody(proxySrc, "export async function proxyOpenAI(");
    expect(proxyBody, "proxyOpenAI signature").not.toBe("");
    expect(proxyBody, "proxyOpenAI wiring").toContain("touchSessionOnCacheHit(");
  });
});
