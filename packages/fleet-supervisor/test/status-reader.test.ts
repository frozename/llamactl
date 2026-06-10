import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readSupervisorStatus } from "../src/status-reader.js";

describe("status-reader", () => {
  async function withTempJournal(
    content: string,
    fn: (path: string) => Promise<void>,
  ): Promise<void> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "status-reader-test-"));
    const journalPath = path.join(tmp, "journal.jsonl");
    if (content) fs.writeFileSync(journalPath, content, "utf8");
    await fn(journalPath).finally(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });
  }

  test("infers HIGH from fleet-pressure-status when transitions are absent", async () => {
    const lines = [
      JSON.stringify({
        kind: "fleet-pressure-status",
        ts: "2026-05-01T00:01:00Z",
        node: "local",
        state: "HIGH",
        enteredAt: "2026-05-01T00:00:00Z",
        durationMs: 60000,
        consecutiveClearTicks: 0,
        clearTicksNeeded: 5,
        free_mb: 100,
        compressor_mb: 4000,
        headroomBreach: true,
        compressorBreach: true,
      }),
      JSON.stringify({
        kind: "fleet-pressure-status",
        ts: "2026-05-01T00:02:00Z",
        node: "local",
        state: "HIGH",
        enteredAt: "2026-05-01T00:00:00Z",
        durationMs: 120000,
        consecutiveClearTicks: 0,
        clearTicksNeeded: 5,
        free_mb: 100,
        compressor_mb: 4000,
        headroomBreach: true,
        compressorBreach: true,
      }),
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
      JSON.stringify({
        kind: "fleet-pressure-status",
        ts: "2026-05-01T00:01:00Z",
        node: "local",
        state: "HIGH",
        enteredAt: "2026-05-01T00:00:00Z",
        durationMs: 60000,
        consecutiveClearTicks: 0,
        clearTicksNeeded: 5,
        free_mb: 100,
        compressor_mb: 4000,
        headroomBreach: true,
        compressorBreach: true,
      }),
      JSON.stringify({
        kind: "fleet-transition",
        ts: "2026-05-01T00:02:00Z",
        node: "local",
        subjectKind: "node",
        subject: "node",
        signal: "pressure-cleared",
        from: "HIGH",
        to: "NORMAL",
      }),
      JSON.stringify({
        kind: "fleet-pressure-status",
        ts: "2026-05-01T00:03:00Z",
        node: "local",
        state: "HIGH",
        enteredAt: "2026-05-01T00:03:00Z",
        durationMs: 0,
        consecutiveClearTicks: 0,
        clearTicksNeeded: 5,
        free_mb: 100,
        compressor_mb: 4000,
        headroomBreach: true,
        compressorBreach: true,
      }),
      JSON.stringify({
        kind: "fleet-transition",
        ts: "2026-05-01T00:04:00Z",
        node: "local",
        subjectKind: "node",
        subject: "node",
        signal: "pressure",
        from: "NORMAL",
        to: "HIGH",
      }),
    ].join("\n");
    await withTempJournal(lines, async (journalPath) => {
      const res = await readSupervisorStatus({ journalPath });
      const firstNode = res.nodes[0];
      if (!firstNode) throw new Error("no nodes");
      expect(firstNode.state).toBe("HIGH");
      expect(firstNode.enteredAt).toBe("2026-05-01T00:04:00Z"); // the newest transition
    });
  });

  test("pressure-cleared transition yields NORMAL state", async () => {
    const lines = [
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
      JSON.stringify({
        kind: "fleet-transition",
        ts: "2026-05-01T00:02:00Z",
        node: "local",
        subjectKind: "node",
        subject: "node",
        signal: "pressure-cleared",
        from: "HIGH",
        to: "NORMAL",
      }),
    ].join("\n");
    await withTempJournal(lines, async (journalPath) => {
      const res = await readSupervisorStatus({ journalPath });
      expect(res.nodes.length).toBe(1);
      const firstNode = res.nodes[0];
      if (!firstNode) throw new Error("no nodes");
      expect(firstNode.state).toBe("NORMAL");
      expect(firstNode.enteredAt).toBeNull();
      expect(firstNode.durationMs).toBe(0);
    });
  });

  test("node filter returns only requested node", async () => {
    const lines = [
      JSON.stringify({
        kind: "fleet-pressure-status",
        ts: "2026-05-01T00:01:00Z",
        node: "node-a",
        state: "HIGH",
        enteredAt: "2026-05-01T00:00:00Z",
        durationMs: 60000,
        consecutiveClearTicks: 0,
        clearTicksNeeded: 5,
        free_mb: 100,
        compressor_mb: 4000,
        headroomBreach: true,
        compressorBreach: true,
      }),
      JSON.stringify({
        kind: "fleet-pressure-status",
        ts: "2026-05-01T00:01:00Z",
        node: "node-b",
        state: "HIGH",
        enteredAt: "2026-05-01T00:00:00Z",
        durationMs: 60000,
        consecutiveClearTicks: 0,
        clearTicksNeeded: 5,
        free_mb: 100,
        compressor_mb: 4000,
        headroomBreach: true,
        compressorBreach: true,
      }),
    ].join("\n");
    await withTempJournal(lines, async (journalPath) => {
      const res = await readSupervisorStatus({ journalPath, node: "node-a" });
      expect(res.nodes.length).toBe(1);
      expect(res.nodes[0]?.name).toBe("node-a");
    });
  });

  test("malformed lines are silently skipped", async () => {
    const lines = [
      "not a json",
      JSON.stringify({
        kind: "fleet-pressure-status",
        ts: "2026-05-01T00:01:00Z",
        node: "local",
        state: "HIGH",
        enteredAt: "2026-05-01T00:00:00Z",
        durationMs: 60000,
        consecutiveClearTicks: 0,
        clearTicksNeeded: 5,
        free_mb: 100,
        compressor_mb: 4000,
        headroomBreach: true,
        compressorBreach: true,
      }),
      "{ also not json",
      JSON.stringify({
        kind: "fleet-pressure-status",
        ts: "2026-05-01T00:02:00Z",
        node: "local",
        state: "HIGH",
        enteredAt: "2026-05-01T00:00:00Z",
        durationMs: 120000,
        consecutiveClearTicks: 0,
        clearTicksNeeded: 5,
        free_mb: 100,
        compressor_mb: 4000,
        headroomBreach: true,
        compressorBreach: true,
      }),
    ].join("\n");
    await withTempJournal(lines, async (journalPath) => {
      const res = await readSupervisorStatus({ journalPath });
      expect(res.nodes.length).toBe(1);
      expect(res.nodes[0]?.state).toBe("HIGH");
      expect(res.nodes[0]?.recent.length).toBe(2);
    });
  });

  test("limit caps recent[] entries per node", async () => {
    const lines = Array.from({ length: 30 })
      .map((_, i) =>
        JSON.stringify({
          kind: "fleet-pressure-status",
          ts: "2026-05-01T00:" + String(i).padStart(2, "0") + ":00Z",
          node: "local",
          state: "HIGH",
          enteredAt: "2026-05-01T00:00:00Z",
          durationMs: 60000,
          consecutiveClearTicks: 0,
          clearTicksNeeded: 5,
          free_mb: 100,
          compressor_mb: 4000,
          headroomBreach: true,
          compressorBreach: true,
        }),
      )
      .join("\n");

    await withTempJournal(lines, async (journalPath) => {
      const res = await readSupervisorStatus({ journalPath, limit: 5 });
      expect(res.nodes.length).toBe(1);
      const recent = res.nodes[0]?.recent;
      expect(recent?.length).toBe(5);
      // The 5 most recent should be 29, 28, 27, 26, 25
      expect(recent![0]?.ts).toBe("2026-05-01T00:29:00Z");
      expect(recent![4]?.ts).toBe("2026-05-01T00:25:00Z");
    });
  });

  test("recent[] order is most-recent-first", async () => {
    const lines = [
      JSON.stringify({
        kind: "fleet-pressure-status",
        ts: "2026-05-01T00:01:00Z",
        node: "local",
        state: "HIGH",
        enteredAt: "2026-05-01T00:00:00Z",
        durationMs: 60000,
        consecutiveClearTicks: 0,
        clearTicksNeeded: 5,
        free_mb: 100,
        compressor_mb: 4000,
        headroomBreach: true,
        compressorBreach: true,
      }),
      JSON.stringify({
        kind: "fleet-pressure-status",
        ts: "2026-05-01T00:02:00Z",
        node: "local",
        state: "HIGH",
        enteredAt: "2026-05-01T00:00:00Z",
        durationMs: 120000,
        consecutiveClearTicks: 0,
        clearTicksNeeded: 5,
        free_mb: 100,
        compressor_mb: 4000,
        headroomBreach: true,
        compressorBreach: true,
      }),
      JSON.stringify({
        kind: "fleet-pressure-status",
        ts: "2026-05-01T00:03:00Z",
        node: "local",
        state: "HIGH",
        enteredAt: "2026-05-01T00:00:00Z",
        durationMs: 180000,
        consecutiveClearTicks: 0,
        clearTicksNeeded: 5,
        free_mb: 100,
        compressor_mb: 4000,
        headroomBreach: true,
        compressorBreach: true,
      }),
    ].join("\n");
    await withTempJournal(lines, async (journalPath) => {
      const res = await readSupervisorStatus({ journalPath });
      const recent = res.nodes[0]?.recent;
      expect(recent?.length).toBe(3);
      expect(recent![0]?.ts).toBe("2026-05-01T00:03:00Z");
      expect(recent![1]?.ts).toBe("2026-05-01T00:02:00Z");
      expect(recent![2]?.ts).toBe("2026-05-01T00:01:00Z");
    });
  });

  test("recent[] is not a live reference (no in-place mutation)", async () => {
    const lines = [
      JSON.stringify({
        kind: "fleet-pressure-status",
        ts: "2026-05-01T00:01:00Z",
        node: "local",
        state: "HIGH",
        enteredAt: "2026-05-01T00:00:00Z",
        durationMs: 60000,
        consecutiveClearTicks: 0,
        clearTicksNeeded: 5,
        free_mb: 100,
        compressor_mb: 4000,
        headroomBreach: true,
        compressorBreach: true,
      }),
      JSON.stringify({
        kind: "fleet-pressure-status",
        ts: "2026-05-01T00:02:00Z",
        node: "local",
        state: "HIGH",
        enteredAt: "2026-05-01T00:00:00Z",
        durationMs: 120000,
        consecutiveClearTicks: 0,
        clearTicksNeeded: 5,
        free_mb: 100,
        compressor_mb: 4000,
        headroomBreach: true,
        compressorBreach: true,
      }),
    ].join("\n");
    await withTempJournal(lines, async (journalPath) => {
      const res1 = await readSupervisorStatus({ journalPath });
      const recent1 = res1.nodes[0]?.recent;
      expect(recent1?.length).toBe(2);

      // Mutate the returned array
      if (!recent1) throw new Error("expected recent statuses");
      recent1.push(recent1[0]!);
      recent1.reverse();

      const res2 = await readSupervisorStatus({ journalPath });
      const recent2 = res2.nodes[0]?.recent;
      expect(recent2?.length).toBe(2);
      expect(recent2![0]?.ts).toBe("2026-05-01T00:02:00Z");
    });
  });

  test("durationMs is clamped non-negative", async () => {
    const lines = [
      JSON.stringify({
        kind: "fleet-transition",
        ts: "2099-05-01T00:00:00Z",
        node: "local",
        subjectKind: "node",
        subject: "node",
        signal: "pressure",
        from: "NORMAL",
        to: "HIGH",
      }),
    ].join("\n");
    await withTempJournal(lines, async (journalPath) => {
      const res = await readSupervisorStatus({ journalPath });
      expect(res.nodes.length).toBe(1);
      const firstNode = res.nodes[0];
      if (!firstNode) throw new Error("no nodes");
      expect(firstNode.state).toBe("HIGH");
      expect(firstNode.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  test("missing journal file returns empty nodes", async () => {
    await withTempJournal("", async (journalPath) => {
      fs.rmSync(journalPath, { force: true });
      const res = await readSupervisorStatus({ journalPath });
      expect(res.nodes).toEqual([]);
    });
  });

  test("fleet-pressure-status with state:NORMAL written after HIGH transition correctly transitions node to NORMAL", async () => {
    const lines = [
      JSON.stringify({
        kind: "fleet-transition",
        ts: "2026-05-01T00:01:05Z",
        node: "local",
        subjectKind: "node",
        subject: "node",
        signal: "pressure",
        from: "NORMAL",
        to: "HIGH",
      }),
      JSON.stringify({
        kind: "fleet-pressure-status",
        ts: "2026-05-01T00:01:10Z",
        node: "local",
        state: "NORMAL",
        enteredAt: "2026-05-01T00:01:05Z",
        durationMs: 0,
        consecutiveClearTicks: 5,
        clearTicksNeeded: 5,
        free_mb: 2000,
        compressor_mb: 500,
        headroomBreach: false,
        compressorBreach: false,
      }),
    ].join("\n");
    await withTempJournal(lines, async (journalPath) => {
      const res = await readSupervisorStatus({ journalPath });
      expect(res.nodes.length).toBe(1);
      const firstNode = res.nodes[0];
      if (!firstNode) throw new Error("no nodes");
      expect(firstNode.state).toBe("NORMAL");
      expect(firstNode.enteredAt).toBeNull();
    });
  });
});
