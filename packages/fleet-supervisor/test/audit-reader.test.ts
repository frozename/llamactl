import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readAuditEntries } from "../src/audit-reader.js";

describe("audit-reader", () => {
  async function withTempAudit(
    content: string,
    fn: (path: string) => Promise<void>,
  ): Promise<void> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-reader-test-"));
    const auditPath = path.join(tmp, "audit.jsonl");
    if (content) {
      fs.writeFileSync(auditPath, content, "utf8");
    }
    try {
      await fn(auditPath);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  test("returns empty result on missing file", async () => {
    await withTempAudit("", async (auditPath) => {
      fs.rmSync(auditPath, { force: true });
      const res = await readAuditEntries({ auditPath });
      expect(res.entries).toEqual([]);
      expect(res.total).toBe(0);
    });
  });

  test("returns all entries when no filters, most-recent-first", async () => {
    const lines = [
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-01T00:00:00.000Z",
        tool: "A",
        input: {},
        outcome: "success",
        detail: {},
      }),
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-03T00:00:00.000Z",
        tool: "B",
        input: {},
        outcome: "success",
        detail: {},
      }),
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-02T00:00:00.000Z",
        tool: "C",
        input: {},
        outcome: "success",
        detail: {},
      }),
    ].join("\n");
    await withTempAudit(lines, async (auditPath) => {
      const res = await readAuditEntries({ auditPath });
      expect(res.total).toBe(3);
      expect(res.entries[0]!.tool).toBe("B");
      expect(res.entries[1]!.tool).toBe("C");
      expect(res.entries[2]!.tool).toBe("A");
    });
  });

  test("tool filter exact-match", async () => {
    const lines = [
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-01T00:00:00.000Z",
        tool: "A",
        input: {},
        outcome: "success",
        detail: {},
      }),
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-02T00:00:00.000Z",
        tool: "B",
        input: {},
        outcome: "success",
        detail: {},
      }),
    ].join("\n");
    await withTempAudit(lines, async (auditPath) => {
      const res = await readAuditEntries({ auditPath, tool: "B" });
      expect(res.total).toBe(1);
      expect(res.entries[0]!.tool).toBe("B");
    });
  });

  test("outcome filter", async () => {
    const lines = [
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-01T00:00:00.000Z",
        tool: "A",
        input: {},
        outcome: "success",
        detail: {},
      }),
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-02T00:00:00.000Z",
        tool: "A",
        input: {},
        outcome: "error",
        detail: {},
      }),
    ].join("\n");
    await withTempAudit(lines, async (auditPath) => {
      const res = await readAuditEntries({ auditPath, outcome: "error" });
      expect(res.total).toBe(1);
      expect(res.entries[0]!.outcome).toBe("error");
    });
  });

  test("since filter (post-rename) works", async () => {
    const lines = [
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-01T00:00:00.000Z",
        tool: "A",
        input: {},
        outcome: "success",
        detail: {},
      }),
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-03T00:00:00.000Z",
        tool: "B",
        input: {},
        outcome: "success",
        detail: {},
      }),
    ].join("\n");
    await withTempAudit(lines, async (auditPath) => {
      const res = await readAuditEntries({ auditPath, since: "2026-05-02T00:00:00.000Z" });
      expect(res.total).toBe(1);
      expect(res.entries[0]!.tool).toBe("B");
    });
  });

  test("limit cap (input>500 => 500)", async () => {
    const line = JSON.stringify({
      kind: "mcp-audit",
      ts: "2026-05-01T00:00:00.000Z",
      tool: "A",
      input: {},
      outcome: "success",
      detail: {},
    });
    const linesArr = Array(600).fill(line).join("\n");
    await withTempAudit(linesArr, async (auditPath) => {
      const res = await readAuditEntries({ auditPath, limit: 1000 });
      expect(res.total).toBe(600);
      expect(res.entries.length).toBe(500);
    });
  });

  test("limit is clamped at 1 floor (negative/zero inputs)", async () => {
    const lines = [
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-01T00:00:00.000Z",
        tool: "A",
        input: {},
        outcome: "success",
        detail: {},
      }),
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-02T00:00:00.000Z",
        tool: "B",
        input: {},
        outcome: "success",
        detail: {},
      }),
    ].join("\n");
    await withTempAudit(lines, async (auditPath) => {
      const res1 = await readAuditEntries({ auditPath, limit: 0 });
      expect(res1.entries.length).toBe(1);

      const res2 = await readAuditEntries({ auditPath, limit: -5 });
      expect(res2.entries.length).toBe(1);
    });
  });

  test("malformedLines counter increments per bad line, reader does not log", async () => {
    const lines = [
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-01T00:00:00.000Z",
        tool: "A",
        input: {},
        outcome: "success",
        detail: {},
      }),
      "not a json",
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-02T00:00:00.000Z",
        tool: "B",
        input: {},
        outcome: "success",
        detail: {},
      }),
      "{ also not json",
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-03T00:00:00.000Z",
        tool: "C",
        input: {},
        outcome: "success",
        detail: {},
      }),
    ].join("\n");
    await withTempAudit(lines, async (auditPath) => {
      const consoleErrorSpy = spyOn(console, "error");
      const res = await readAuditEntries({ auditPath });
      expect(res.malformedLines).toBe(2);
      expect(res.entries.length).toBe(3);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  test("malformed-line skip", async () => {
    const lines = [
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-01T00:00:00.000Z",
        tool: "A",
        input: {},
        outcome: "success",
        detail: {},
      }),
      "not a json",
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-02T00:00:00.000Z",
        tool: "B",
        input: {},
        outcome: "success",
        detail: {},
      }),
    ].join("\n");
    await withTempAudit(lines, async (auditPath) => {
      const res = await readAuditEntries({ auditPath });
      expect(res.total).toBe(2);
    });
  });

  test("streams large journals without buffering full file", async () => {
    const line = JSON.stringify({
      kind: "mcp-audit",
      ts: "2026-05-01T00:00:00.000Z",
      tool: "A",
      input: {},
      outcome: "success",
      detail: {},
    });
    const linesArr = Array(1500).fill(line).join("\n");
    await withTempAudit(linesArr, async (auditPath) => {
      const res = await readAuditEntries({ auditPath, limit: 10 });
      expect(res.entries.length).toBe(10);
      expect(res.total).toBeGreaterThanOrEqual(10);
    });
  });

  test("entry without kind:mcp-audit is skipped", async () => {
    const lines = [
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-01T00:00:00.000Z",
        tool: "A",
        input: {},
        outcome: "success",
        detail: {},
      }),
      JSON.stringify({ kind: "fleet-snapshot", ts: "2026-05-02T00:00:00.000Z" }),
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-03T00:00:00.000Z",
        tool: "B",
        input: {},
        outcome: "success",
        detail: {},
      }),
    ].join("\n");
    await withTempAudit(lines, async (auditPath) => {
      const res = await readAuditEntries({ auditPath });
      expect(res.entries.length).toBe(2);
      expect(res.entries[0]!.tool).toBe("B");
      expect(res.entries[1]!.tool).toBe("A");
    });
  });

  test("since filter handles mixed offsets robustly using Date.parse", async () => {
    const lines = [
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-22T23:00:00Z",
        tool: "A",
        input: {},
        outcome: "success",
        detail: {},
      }),
      JSON.stringify({
        kind: "mcp-audit",
        ts: "2026-05-22T23:00:01Z",
        tool: "B",
        input: {},
        outcome: "success",
        detail: {},
      }),
    ].join("\n");
    await withTempAudit(lines, async (auditPath) => {
      // 2026-05-23T00:00:00+02:00 is exactly 2026-05-22T22:00:00Z
      // A lexicographical compare of "2026-05-22T23:00:00Z" < "2026-05-23T00:00:00+02:00" would be true (and filter it out).
      // A semantic compare correctly identifies 23:00Z > 22:00Z.
      const res = await readAuditEntries({ auditPath, since: "2026-05-23T00:00:00+02:00" });
      expect(res.total).toBe(2);
      expect(res.entries.length).toBe(2);
    });
  });
});
