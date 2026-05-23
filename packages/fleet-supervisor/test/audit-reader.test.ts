import { expect, test, describe } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readAuditEntries } from "../src/audit-reader.js";

describe("audit-reader", () => {
  function withTempAudit(content: string, fn: (path: string) => void) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-reader-test-"));
    const auditPath = path.join(tmp, "audit.jsonl");
    if (content) {
      fs.writeFileSync(auditPath, content, "utf8");
    }
    try {
      fn(auditPath);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  test("returns empty result on missing file", () => {
    withTempAudit("", (auditPath) => {
      fs.rmSync(auditPath, { force: true });
      const res = readAuditEntries({ auditPath });
      expect(res.entries).toEqual([]);
      expect(res.total).toBe(0);
    });
  });

  test("returns all entries when no filters, most-recent-first", () => {
    const lines = [
      JSON.stringify({ kind: "mcp-audit", ts: "2026-05-01T00:00:00.000Z", tool: "A", input: {}, outcome: "success", detail: {} }),
      JSON.stringify({ kind: "mcp-audit", ts: "2026-05-03T00:00:00.000Z", tool: "B", input: {}, outcome: "success", detail: {} }),
      JSON.stringify({ kind: "mcp-audit", ts: "2026-05-02T00:00:00.000Z", tool: "C", input: {}, outcome: "success", detail: {} })
    ].join("\n");
    withTempAudit(lines, (auditPath) => {
      const res = readAuditEntries({ auditPath });
      expect(res.total).toBe(3);
      expect(res.entries[0]!.tool).toBe("B");
      expect(res.entries[1]!.tool).toBe("C");
      expect(res.entries[2]!.tool).toBe("A");
    });
  });

  test("tool filter exact-match", () => {
    const lines = [
      JSON.stringify({ kind: "mcp-audit", ts: "2026-05-01T00:00:00.000Z", tool: "A", input: {}, outcome: "success", detail: {} }),
      JSON.stringify({ kind: "mcp-audit", ts: "2026-05-02T00:00:00.000Z", tool: "B", input: {}, outcome: "success", detail: {} })
    ].join("\n");
    withTempAudit(lines, (auditPath) => {
      const res = readAuditEntries({ auditPath, tool: "B" });
      expect(res.total).toBe(1);
      expect(res.entries[0]!.tool).toBe("B");
    });
  });

  test("outcome filter", () => {
    const lines = [
      JSON.stringify({ kind: "mcp-audit", ts: "2026-05-01T00:00:00.000Z", tool: "A", input: {}, outcome: "success", detail: {} }),
      JSON.stringify({ kind: "mcp-audit", ts: "2026-05-02T00:00:00.000Z", tool: "A", input: {}, outcome: "error", detail: {} })
    ].join("\n");
    withTempAudit(lines, (auditPath) => {
      const res = readAuditEntries({ auditPath, outcome: "error" });
      expect(res.total).toBe(1);
      expect(res.entries[0]!.outcome).toBe("error");
    });
  });

  test("sinceIsoTs filter", () => {
    const lines = [
      JSON.stringify({ kind: "mcp-audit", ts: "2026-05-01T00:00:00.000Z", tool: "A", input: {}, outcome: "success", detail: {} }),
      JSON.stringify({ kind: "mcp-audit", ts: "2026-05-03T00:00:00.000Z", tool: "B", input: {}, outcome: "success", detail: {} })
    ].join("\n");
    withTempAudit(lines, (auditPath) => {
      const res = readAuditEntries({ auditPath, sinceIsoTs: "2026-05-02T00:00:00.000Z" });
      expect(res.total).toBe(1);
      expect(res.entries[0]!.tool).toBe("B");
    });
  });

  test("limit cap (input>500 => 500)", () => {
    const line = JSON.stringify({ kind: "mcp-audit", ts: "2026-05-01T00:00:00.000Z", tool: "A", input: {}, outcome: "success", detail: {} });
    const lines = Array(600).fill(line).join("\n");
    withTempAudit(lines, (auditPath) => {
      const res = readAuditEntries({ auditPath, limit: 1000 });
      expect(res.total).toBe(600);
      expect(res.entries.length).toBe(500);
    });
  });

  test("malformed-line skip", () => {
    const lines = [
      JSON.stringify({ kind: "mcp-audit", ts: "2026-05-01T00:00:00.000Z", tool: "A", input: {}, outcome: "success", detail: {} }),
      "not a json",
      JSON.stringify({ kind: "mcp-audit", ts: "2026-05-02T00:00:00.000Z", tool: "B", input: {}, outcome: "success", detail: {} })
    ].join("\n");
    withTempAudit(lines, (auditPath) => {
      const res = readAuditEntries({ auditPath });
      expect(res.total).toBe(2);
    });
  });
});
