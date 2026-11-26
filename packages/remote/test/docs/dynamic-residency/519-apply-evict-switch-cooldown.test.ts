import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, SECTIONS } from "./helpers.js";

// Part of #519: pins the operator-facing contract and the apply.ts wiring
// for the `apply --evict` / `llamactl.io/evict` switchCooldownSeconds gate.
describe("#519 apply --evict switchCooldownSeconds docs and wiring", () => {
  test("D1: knobs section documents EvictCooldown and EvictCooldownUnknown", () => {
    // kills: shipping undocumented.
    const body = sectionBody(SECTIONS.knobs) ?? "";
    const knobs = flat(body);
    for (const pin of [
      "`EvictCooldown`",
      "`EvictCooldownUnknown`",
      "is unset and the victim is on `local`",
      "an agent not serving that node records no profile switch for it",
      "does not restart the cooldown",
    ]) {
      expect(knobs, `knobs section pin ${pin}`).toContain(pin);
    }
    const row = body.split("\n").find((line) => line.startsWith("| `switchCooldownSeconds`")) ?? "";
    expect(row, "switchCooldownSeconds row pin EvictCooldown").toContain("`EvictCooldown`");
    expect(row, "switchCooldownSeconds row keeps enforced status").toContain("enforced");
  });

  test("D2: apply.ts wires the cooldown through the evict target check and shared prefetch", () => {
    // kills: gate not wired, or logic in the wrong helper.
    const applySrc = readOrEmpty(join(REPO, "packages/remote/src/workload/apply.ts"));

    const checkEvictTarget = enclosingBody(applySrc, "function checkEvictTarget(");
    expect(checkEvictTarget, "checkEvictTarget calls the cooldown gate").toContain(
      "checkEvictSwitchCooldown(",
    );

    const checkGate = enclosingBody(applySrc, "function checkEvictSwitchCooldown(");
    for (const pin of [
      "EvictCooldown",
      "EvictCooldownUnknown",
      "switchCooldownSeconds of",
      "resolveEvictLastSwitchAtMs(",
    ]) {
      expect(checkGate, `checkEvictSwitchCooldown pin ${pin}`).toContain(pin);
    }

    const resolveLastSwitch = enclosingBody(applySrc, "function resolveEvictLastSwitchAtMs(");
    for (const pin of ["evictSwitchOwnStoreKey(", "lastSucceededAtMs", "remoteEvictLastSwitch"]) {
      expect(resolveLastSwitch, `resolveEvictLastSwitchAtMs pin ${pin}`).toContain(pin);
    }

    const ownStoreKey = enclosingBody(applySrc, "function evictSwitchOwnStoreKey(");
    for (const pin of ["LOCAL_NODE_ID", "profileSwitchOperationKey(", "LLAMACTL_NODE_NAME"]) {
      expect(ownStoreKey, `evictSwitchOwnStoreKey pin ${pin}`).toContain(pin);
    }

    const outcomeMapping = enclosingBody(applySrc, "function lastSwitchFromReadOutcome(");
    for (const pin of ["switchGates", "NotServingNode"]) {
      expect(outcomeMapping, `lastSwitchFromReadOutcome pin ${pin}`).toContain(pin);
    }

    const prefetch = enclosingBody(applySrc, "function prefetchEvictReadiness(");
    expect(prefetch, "prefetchEvictReadiness pin lastSwitchFromReadOutcome").toContain(
      "lastSwitchFromReadOutcome(",
    );

    const skipped = enclosingBody(applySrc, "function evictReadinessPrefetchSkipped(");
    for (const pin of ["evictSwitchCooldownSeconds(", "evictSwitchOwnStoreKey("]) {
      expect(skipped, `evictReadinessPrefetchSkipped pin ${pin}`).toContain(pin);
    }
  });
});
