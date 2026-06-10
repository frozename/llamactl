import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runSupervisor } from "../src/commands/supervisor.js";
import { EMPTY_GLOBALS, resetGlobals, setGlobals } from "../src/dispatcher.js";
import { captureProcessStreams } from "./helpers.js";

/**
 * `llamactl supervisor audit` renders entries read from an unvalidated
 * JSONL file. Legacy/foreign lines can carry a `detail` field that is
 * missing, null, or a primitive — the renderer must not crash on them.
 */

let tmp = "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llamactl-supervisor-audit-"));
  setGlobals(EMPTY_GLOBALS);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  resetGlobals();
});

function writeAudit(lines: unknown[]): string {
  const auditPath = path.join(tmp, "audit.jsonl");
  fs.writeFileSync(auditPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return auditPath;
}

describe("supervisor audit — malformed detail resilience", () => {
  test("entries with null/missing/primitive detail render instead of crashing", async () => {
    const auditPath = writeAudit([
      {
        kind: "mcp-audit",
        ts: "2026-06-01T00:00:01Z",
        tool: "workload.delete",
        input: { name: "w1" },
        outcome: "error",
        detail: { error: "boom" },
      },
      {
        kind: "mcp-audit",
        ts: "2026-06-01T00:00:02Z",
        tool: "legacy.tool",
        input: {},
        outcome: "success",
        detail: null,
      },
      {
        kind: "mcp-audit",
        ts: "2026-06-01T00:00:03Z",
        tool: "legacy.tool",
        input: {},
        outcome: "success",
        // detail intentionally missing
      },
      {
        kind: "mcp-audit",
        ts: "2026-06-01T00:00:04Z",
        tool: "legacy.tool",
        input: {},
        outcome: "denied",
        detail: "primitive-detail",
      },
    ]);

    const { result, stdout } = await captureProcessStreams(() =>
      runSupervisor(["audit", `--audit-path=${auditPath}`]),
    );
    expect(result).toBe(0);
    // All four entries render — the structured-error one keeps its message,
    // the degenerate ones fall back to the generic summary.
    expect(stdout).toContain("entries=4");
    expect(stdout).toContain("detail=boom");
    expect(stdout).toContain("legacy.tool");
  });
});
