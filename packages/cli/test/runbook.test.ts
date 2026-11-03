import { listRunbooks } from "@llamactl/agents";
import { describe, expect, test } from "bun:test";

import { runRunbookCmd } from "../src/commands/runbook.js";
import { captureProcessStreams } from "./helpers.js";

async function runRunbookCase(argv: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const { result, stdout, stderr } = await captureProcessStreams(() => runRunbookCmd(argv));
  return { code: result, stdout, stderr };
}

describe("runbook help and dispatch", () => {
  test('[""] returns 0 with USAGE on stdout and empty stderr', async () => {
    const { code, stdout, stderr } = await runRunbookCase([]);
    expect(code).toBe(0);
    expect(stdout.startsWith("llamactl runbook — operator runbooks that chain MCP tools")).toBe(
      true,
    );
    expect(stderr).toBe("");
  });

  test('["--help"] returns 0 with USAGE on stdout and empty stderr', async () => {
    const { code, stdout, stderr } = await runRunbookCase(["--help"]);
    expect(code).toBe(0);
    expect(stdout.startsWith("llamactl runbook — operator runbooks that chain MCP tools")).toBe(
      true,
    );
    expect(stderr).toBe("");
  });

  test('["-h"] returns 0 with USAGE on stdout and empty stderr', async () => {
    const { code, stdout, stderr } = await runRunbookCase(["-h"]);
    expect(code).toBe(0);
    expect(stdout.startsWith("llamactl runbook — operator runbooks that chain MCP tools")).toBe(
      true,
    );
    expect(stderr).toBe("");
  });

  test('["help"] returns 0 with USAGE on stdout and empty stderr', async () => {
    const { code, stdout, stderr } = await runRunbookCase(["help"]);
    expect(code).toBe(0);
    expect(stdout.startsWith("llamactl runbook — operator runbooks that chain MCP tools")).toBe(
      true,
    );
    expect(stderr).toBe("");
  });
});

describe("runbook list", () => {
  test('["list"] returns 0 with listing on stdout and empty stderr', async () => {
    const { code, stdout, stderr } = await runRunbookCase(["list"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const expected = listRunbooks()
      .map((r) => `${r.name}\t${r.description}\n`)
      .join("");
    expect(stdout).toBe(expected);
    expect(stdout).toContain("drain-node\t");
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(listRunbooks().length);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const tabIdx = line.indexOf("\t");
      expect(tabIdx).toBeGreaterThan(0);
      expect(line.indexOf("\t", tabIdx + 1)).toBe(-1);
      expect(line.includes("\n")).toBe(false);
    }
  });
});

describe("runbook run argument parsing", () => {
  test('["run"] returns 1 with "name is required"', async () => {
    const { code, stderr } = await runRunbookCase(["run"]);
    expect(code).toBe(1);
    expect(stderr.startsWith("runbook run: name is required")).toBe(true);
  });

  test('["run", "--dry-run"] returns 1 with "name is required"', async () => {
    const { code, stderr } = await runRunbookCase(["run", "--dry-run"]);
    expect(code).toBe(1);
    expect(stderr.startsWith("runbook run: name is required")).toBe(true);
  });

  test('["run", "drain-node", "--params"] returns 1 with "--params requires a JSON value"', async () => {
    const { code, stderr } = await runRunbookCase(["run", "drain-node", "--params"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--params requires a JSON value");
  });

  test('["run", "drain-node", "--params", "{not json"] returns 1 with "invalid JSON"', async () => {
    const { code, stderr } = await runRunbookCase(["run", "drain-node", "--params", "{not json"]);
    expect(code).toBe(1);
    expect(stderr.startsWith("--params: invalid JSON (")).toBe(true);
  });

  test.each(["[1]", `"str"`, "null", "42"])(
    '["run", "drain-node", "--params", %s] returns 1 with "must be a JSON object"',
    async (paramsVal: string) => {
      const { code, stderr } = await runRunbookCase(["run", "drain-node", "--params", paramsVal]);
      expect(code).toBe(1);
      expect(stderr).toContain("--params must be a JSON object");
      expect(stderr).not.toContain("invalid params");
    },
  );

  test('["run", "drain-node", "--force"] returns 1 with "unknown flag"', async () => {
    const { code, stderr } = await runRunbookCase(["run", "drain-node", "--force"]);
    expect(code).toBe(1);
    expect(stderr.startsWith("unknown flag: --force\n\n")).toBe(true);
  });

  test('["run", "drain-node", "--dry-run", "--nope"] returns 1 with "unknown flag"', async () => {
    const { code, stderr } = await runRunbookCase(["run", "drain-node", "--dry-run", "--nope"]);
    expect(code).toBe(1);
    expect(stderr).toContain("unknown flag: --nope");
  });
});

describe("runbook run errors", () => {
  test('["run", "no-such-runbook"] returns 1 with "unknown runbook"', async () => {
    const { code, stdout, stderr } = await runRunbookCase(["run", "no-such-runbook"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("runbook: unknown runbook: no-such-runbook\n");
  });

  test('["run", "no-such-runbook", "--dry-run"] returns 1 with "unknown runbook"', async () => {
    const { code, stdout, stderr } = await runRunbookCase(["run", "no-such-runbook", "--dry-run"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("runbook: unknown runbook: no-such-runbook\n");
  });

  test('["run", "no-such-runbook", "--params", \'{"a":1}\'] returns 1 with "unknown runbook"', async () => {
    const { code, stdout, stderr } = await runRunbookCase([
      "run",
      "no-such-runbook",
      "--params",
      '{"a":1}',
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("runbook: unknown runbook: no-such-runbook\n");
  });

  test('["run", "drain-node"] returns 1 with "invalid params" (default {})', async () => {
    const { code, stdout, stderr } = await runRunbookCase(["run", "drain-node"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.startsWith("runbook: runbook drain-node: invalid params")).toBe(true);
  });

  test('["run", "drain-node", "--params", \'{"node":""}\'] returns 1 with "invalid params"', async () => {
    const { code, stderr } = await runRunbookCase(["run", "drain-node", "--params", '{"node":""}']);
    expect(code).toBe(1);
    expect(stderr.startsWith("runbook: runbook drain-node: invalid params")).toBe(true);
  });

  test('["run", "drain-node", "--params", \'{"node":5}\'] returns 1 with "invalid params"', async () => {
    const { code, stderr } = await runRunbookCase(["run", "drain-node", "--params", '{"node":5}']);
    expect(code).toBe(1);
    expect(stderr.startsWith("runbook: runbook drain-node: invalid params")).toBe(true);
  });
});
