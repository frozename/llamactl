import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { setSessionRefcountRegistry } from "@llamactl/core/residency/sessions";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { mkdtempSync, readFileSync, rmSync } from "../src/safe-fs.js";
import * as mutations from "../src/tools/mutations.js";

let runtimeDir = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-mcp-apply-fence-"));
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: runtimeDir,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMACTL_CONFIG: join(runtimeDir, "config"),
    LLAMACTL_MCP_AUDIT_DIR: join(runtimeDir, "audit"),
    LLAMACTL_WORKLOADS_DIR: join(runtimeDir, "workloads"),
  });
});

afterEach(() => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  rmSync(runtimeDir, { recursive: true, force: true });
});

interface TextResponse {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

type WorkloadApplyToolResultFn = (payload: unknown) => {
  response: TextResponse;
  audit: Record<string, unknown>;
};

const fn = (mutations as Record<string, unknown>)["workloadApplyToolResult"];
const transition = "2026-01-02T03:04:05.000Z";

function applyPayload(args: {
  action: string;
  phase: string;
  serverPid: number | null;
  endpoint: string | null;
  conditions: Record<string, unknown>[];
}): Record<string, unknown> {
  return {
    action: args.action,
    path: "/tmp/w1.yaml",
    status: {
      phase: args.phase,
      serverPid: args.serverPid,
      endpoint: args.endpoint,
      lastTransitionTime: transition,
      conditions: args.conditions,
    },
    name: "w1",
    node: "n1",
  };
}

function responseText(response: TextResponse): string {
  return response.content[0]?.text ?? "";
}

function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start === -1) return "";
  const rest = src.slice(start);
  const end = rest.indexOf("\n}\n");
  return end === -1 ? rest : rest.slice(0, end + 3);
}

describe("#520 MCP workload.apply fence refusal", () => {
  // Kills: returning a fenced restart as ordinary text content instead of an
  // MCP tool error, or auditing the raw payload as though it applied cleanly.
  test("R1 StopRefused returns isError apply_refused and audits the refusal", () => {
    expect(typeof fn).toBe("function");
    const workloadApplyToolResult = fn as WorkloadApplyToolResultFn;
    const payload = applyPayload({
      action: "unchanged",
      phase: "Running",
      serverPid: 123,
      endpoint: "http://127.0.0.1:8081",
      conditions: [
        {
          type: "Applied",
          status: "False",
          reason: "StopRefused",
          message: "serverStop refused: SessionsActive: s1, s2",
          lastTransitionTime: transition,
        },
      ],
    });

    const { response, audit } = workloadApplyToolResult(payload);

    expect(response.isError).toBe(true);
    expect(JSON.parse(responseText(response))).toEqual({
      ...payload,
      ok: false,
      code: "apply_refused",
      error:
        "workloadApply refused by the node stop fence (StopRefused): serverStop refused: SessionsActive: s1, s2",
    });
    expect(audit).toEqual({ ok: false, code: "apply_refused", name: "w1", reason: "StopRefused" });
  });

  // Kills: narrowing the MCP mapping to the restart-only StopRefused reason
  // and missing eviction's session-registry failure.
  test("R2 EvictSessionUnknown returns isError with apply_refused", () => {
    expect(typeof fn).toBe("function");
    const workloadApplyToolResult = fn as WorkloadApplyToolResultFn;
    const payload = applyPayload({
      action: "pending",
      phase: "Failed",
      serverPid: null,
      endpoint: null,
      conditions: [
        {
          type: "Applied",
          status: "False",
          reason: "EvictSessionUnknown",
          lastTransitionTime: transition,
        },
      ],
    });

    const { response } = workloadApplyToolResult(payload);

    expect(response.isError).toBe(true);
    expect(JSON.parse(responseText(response))).toMatchObject({ ok: false, code: "apply_refused" });
  });

  // RED rather than a base guard because the pure result adapter does not exist
  // yet: once present, a clean apply must keep today's payload and audit shape.
  test("R3 a clean started apply stays a non-error with the existing audit shape", () => {
    expect(typeof fn).toBe("function");
    const workloadApplyToolResult = fn as WorkloadApplyToolResultFn;
    const payload = applyPayload({
      action: "started",
      phase: "Running",
      serverPid: 123,
      endpoint: "http://127.0.0.1:8081",
      conditions: [
        { type: "Applied", status: "True", reason: "started", lastTransitionTime: transition },
      ],
    });

    const { response, audit } = workloadApplyToolResult(payload);

    expect(response.isError).toBeUndefined();
    expect(JSON.parse(responseText(response))).toEqual(payload);
    expect(audit).toEqual({ name: "w1" });
  });

  // Kills: adding the pure adapter but leaving the registered tool on the raw
  // payload path, or omitting the refusal contract from the tool description.
  test("R4 registerWorkloadApply is wired through the result adapter and documents apply_refused", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/tools/mutations.ts"), "utf8");
    const body = functionBody(src, "function registerWorkloadApply(server: McpServer): void {");

    expect(body).not.toBe("");
    expect(body).toContain("workloadApplyToolResult(");
    const description = /description:\s*"([^"\n]+)"/.exec(body)?.[1] ?? "";
    expect(description).toContain("apply_refused");
  });
});
