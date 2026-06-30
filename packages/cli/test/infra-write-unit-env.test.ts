import { describe, expect, test } from "bun:test";

import { collectEnvEntries } from "../src/commands/infra.js";

// Regression for `infra service write-unit`: repeated --env flags must all be
// carried. The previous parseKv-based extraction keyed on the flag name "env"
// and so kept only the LAST --env.
describe("collectEnvEntries", () => {
  test("collects every repeated --env=K=V (does not collapse to the last)", () => {
    expect(collectEnvEntries(["--env=A=1", "--env=B=2"])).toEqual({ A: "1", B: "2" });
  });

  test("preserves '=' inside the value (splits on the first '=' only)", () => {
    expect(collectEnvEntries(["--env=URL=https://x/y?a=b&c=d"])).toEqual({
      URL: "https://x/y?a=b&c=d",
    });
  });

  test("ignores non --env args and entries with an empty key", () => {
    expect(collectEnvEntries(["--node", "m4-pro", "--env==novalue", "--env=K=V"])).toEqual({
      K: "V",
    });
  });

  test("a later duplicate key wins (shell env semantics)", () => {
    expect(collectEnvEntries(["--env=K=1", "--env=K=2"])).toEqual({ K: "2" });
  });
});
