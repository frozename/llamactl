import * as contracts from "@nova/contracts";

import { describe, expect, test } from "bun:test";

/**
 * P0.2 tripwire: the installed @nova/contracts must expose the 0.2.0
 * surface this repo now consumes — `projectUsageRecordV2ToV1` and a
 * `StreamCompletionSchema` that includes 'eof'. A namespace import
 * keeps an older install failing the ASSERTION (missing exports read
 * as undefined) rather than failing module resolution — so a stale
 * nova pin shows up as a red test here, not a SyntaxError.
 */
describe("@nova/contracts P0.2 surface", () => {
  test("projectUsageRecordV2ToV1 is exported and functional", () => {
    expect(typeof contracts.projectUsageRecordV2ToV1).toBe("function");
    // Fully-observed chat usage projects to a V1 row; a partial or
    // non-observed observation projects null — never a zero-fill.
    const v2 = {
      v: 2 as const,
      ts: new Date().toISOString(),
      provider: "openai",
      model: "m",
      kind: "chat" as const,
      latency_ms: 5,
      observation: {
        source: "observed" as const,
        input_tokens: 3,
        output_tokens: 2,
        total_tokens: 5,
      },
    };
    const projected = contracts.projectUsageRecordV2ToV1(v2);
    expect(projected).not.toBeNull();
    expect(projected?.prompt_tokens).toBe(3);
    expect(projected?.completion_tokens).toBe(2);
    const partial = contracts.projectUsageRecordV2ToV1({
      ...v2,
      observation: { source: "observed" as const, input_tokens: 3 },
    });
    expect(partial).toBeNull();
  });

  test("StreamCompletionSchema includes 'eof'", () => {
    expect(contracts.StreamCompletionSchema?.options ?? []).toContain("eof");
    expect(contracts.StreamCompletionSchema?.options ?? []).toContain("upstream");
  });
});
