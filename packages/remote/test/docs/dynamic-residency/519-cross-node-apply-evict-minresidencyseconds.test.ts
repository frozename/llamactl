import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, SECTIONS } from "./helpers.js";

// Part of #519
// Kills: shipping the cross-node evict readiness read undocumented, or
// leaving the stale "gets no protection yet" sentence, or dropping the
// prefetchEvictReadiness residencyStatus call from apply.ts.
describe("#519 cross-node apply --evict minResidencySeconds", () => {
  test("knobs section documents the victim-node residencyStatus read", () => {
    const knobs = flat(sectionBody(SECTIONS.knobs) ?? "");
    for (const pin of ["`residencyStatus`", "`lifecycle`", "victim node"]) {
      expect(knobs, `knobs pin ${pin}`).toContain(pin);
    }
    expect(knobs).not.toContain("gets no protection yet");
  });

  test("apply.ts prefetches evict readiness through residencyStatus", () => {
    const body = enclosingBody(
      readOrEmpty(join(REPO, "packages/remote/src/workload/apply.ts")),
      "async function prefetchEvictReadiness(",
    );
    for (const pin of ["residencyStatus", "EVICT_READINESS_TIMEOUT_MS"]) {
      expect(body, `prefetchEvictReadiness pin ${pin}`).toContain(pin);
    }
    // Mutation pinned: M10 (changing the EVICT_READINESS_TIMEOUT_MS default)
    // drifts from the doc's 'bounded at 10 seconds' remote readiness read.
    expect(
      readOrEmpty(join(REPO, "packages/remote/src/workload/apply.ts")),
      "apply.ts pins the 10 s evict readiness default",
    ).toContain("const EVICT_READINESS_TIMEOUT_MS = 10_000;");
    expect(
      readOrEmpty(join(REPO, "docs/dynamic-residency.md")),
      "the doc states the 10 s evict readiness bound",
    ).toContain("bounded at 10 seconds");
  });
});
