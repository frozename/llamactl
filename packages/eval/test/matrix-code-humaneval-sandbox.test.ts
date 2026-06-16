import { describe, expect, test } from "bun:test";

import { buildProgram, runCandidate } from "../src/matrix/workloads/code-humaneval.js";

const PROMPT_SOURCE = `def sandbox_probe() -> bool:
`;

function programFor(body: string, testSource: string): string {
  return buildProgram(`${PROMPT_SOURCE}${body}`, testSource, "sandbox_probe");
}

describe("HumanEval sandbox guard", () => {
  test("denies network sockets", async () => {
    const program = programFor(
      `    import socket
    socket.socket()
    return True`,
      `def check(candidate):
    assert candidate() is True
`,
    );

    const result = await runCandidate(program);

    expect(result.passed).toBe(false);
    expect(result.status).toBe("fail");
  });

  test("applies a CPU rlimit", async () => {
    const program = programFor(
      `    import resource
    s, _ = resource.getrlimit(resource.RLIMIT_CPU)
    return s != resource.RLIM_INFINITY and s <= 15`,
      `def check(candidate):
    assert candidate() is True
`,
    );

    const result = await runCandidate(program);

    expect(result).toEqual({ passed: true, status: "pass" });
  });
});
