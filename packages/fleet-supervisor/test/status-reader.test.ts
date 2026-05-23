import { expect, test, describe } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readSupervisorStatus } from "../src/status-reader.js";

describe("status-reader", () => {
  async function withTempJournal(content: string, fn: (path: string) => Promise<void>) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "status-reader-test-"));
    const journalPath = path.join(tmp, "journal.jsonl");
    if (content) fs.writeFileSync(journalPath, content, "utf8");
    return fn(journalPath).finally(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });
  }

  test("infers HIGH from fleet-pressure-status when transitions are absent", async () => {
    const lines = [
      JSON.stringify({ kind: "fleet-pressure-status", ts: "2026-05-01T00:01:00Z", node: "local", state: "HIGH", enteredAt: "2026-05-01T00:00:00Z", durationMs: 60000, consecutiveClearTicks: 0, clearTicksNeeded: 5, free_mb: 100, compressor_mb: 4000, headroomBreach: true, compressorBreach: true }),
      JSON.stringify({ kind: "fleet-pressure-status", ts: "2026-05-01T00:02:00Z", node: "local", state: "HIGH", enteredAt: "2026-05-01T00:00:00Z", durationMs: 120000, consecutiveClearTicks: 0, clearTicksNeeded: 5, free_mb: 100, compressor_mb: 4000, headroomBreach: true, compressorBreach: true })
    ].join("\n");
    await withTempJournal(lines, async (journalPath) => {
      const res = await readSupervisorStatus({ journalPath });
      expect(res.nodes.length).toBe(1);
      const firstNode = res.nodes[0];
      if (!firstNode) throw new Error("no nodes");
      expect(firstNode.state).toBe("HIGH");
      expect(firstNode.enteredAt).toBe("2026-05-01T00:00:00Z");
    });
  });

  test("transition overrides pressure-status when newer", async () => {
    const lines = [
      JSON.stringify({ kind: "fleet-pressure-status", ts: "2026-05-01T00:01:00Z", node: "local", state: "HIGH", enteredAt: "2026-05-01T00:00:00Z", durationMs: 60000, consecutiveClearTicks: 0, clearTicksNeeded: 5, free_mb: 100, compressor_mb: 4000, headroomBreach: true, compressorBreach: true }),
      JSON.stringify({ kind: "fleet-transition", ts: "2026-05-01T00:02:00Z", node: "local", subjectKind: "node", subject: "node", signal: "pressure-cleared", from: "HIGH", to: "NORMAL" }),
      JSON.stringify({ kind: "fleet-pressure-status", ts: "2026-05-01T00:03:00Z", node: "local", state: "HIGH", enteredAt: "2026-05-01T00:03:00Z", durationMs: 0, consecutiveClearTicks: 0, clearTicksNeeded: 5, free_mb: 100, compressor_mb: 4000, headroomBreach: true, compressorBreach: true }),
      JSON.stringify({ kind: "fleet-transition", ts: "2026-05-01T00:04:00Z", node: "local", subjectKind: "node", subject: "node", signal: "pressure", from: "NORMAL", to: "HIGH" })
    ].join("\n");
    await withTempJournal(lines, async (journalPath) => {
      const res = await readSupervisorStatus({ journalPath });
      const firstNode = res.nodes[0];
      if (!firstNode) throw new Error("no nodes");
      expect(firstNode.state).toBe("HIGH");
      expect(firstNode.enteredAt).toBe("2026-05-01T00:04:00Z"); // the newest transition
    });
  });
});
