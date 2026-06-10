import { readSupervisorStatus } from "@llamactl/fleet-supervisor";
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("supervisor status - CII regressions", () => {
  function withTempJournal(content: string, fn: (path: string) => Promise<void>) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llamactl-cli-test-"));
    const journalPath = path.join(tmp, "journal.jsonl");
    if (content) fs.writeFileSync(journalPath, content, "utf8");
    return fn(journalPath).finally(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });
  }

  test("--node filter is respected by readSupervisorStatus", async () => {
    const lines = [
      JSON.stringify({
        kind: "fleet-snapshot",
        ts: "2026-05-01T00:01:00Z",
        node: "local",
        node_mem: {},
        workloads: [],
      }),
      JSON.stringify({
        kind: "fleet-snapshot",
        ts: "2026-05-01T00:01:00Z",
        node: "mac-mini",
        node_mem: {},
        workloads: [],
      }),
      JSON.stringify({
        kind: "fleet-transition",
        ts: "2026-05-01T00:01:00Z",
        node: "mac-mini",
        subjectKind: "node",
        subject: "node",
        signal: "pressure",
        from: "NORMAL",
        to: "HIGH",
      }),
      JSON.stringify({
        kind: "fleet-transition",
        ts: "2026-05-01T00:01:00Z",
        node: "local",
        subjectKind: "node",
        subject: "node",
        signal: "pressure",
        from: "NORMAL",
        to: "HIGH",
      }),
    ].join("\n");
    await withTempJournal(lines, async (journalPath) => {
      const res = await readSupervisorStatus({ journalPath, node: "local" });
      expect(res.nodes.length).toBe(1);
      const firstNode = res.nodes[0];
      if (!firstNode) throw new Error("no nodes");
      expect(firstNode.name).toBe("local");
      expect(firstNode.state).toBe("HIGH");
    });
  });
});
