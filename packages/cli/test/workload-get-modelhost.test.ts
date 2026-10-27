import { workloadSchema, workloadStore } from "@llamactl/remote";
import {
  MANAGED_BY_LABEL,
  ModelHostManifestSchema,
} from "@llamactl/remote/workload/modelhost-schema";
import { saveModelHost } from "@llamactl/remote/workload/modelhost-store";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGet } from "../src/commands/workload.js";
import { mkdirSync, mkdtempSync, rmSync } from "../src/safe-fs.js";

let tmp = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-get-modelhost-"));
  process.env["DEV_STORAGE"] = join(tmp, "dev");
  process.env["LLAMACTL_CONFIG"] = join(tmp, "no-such-kubeconfig.yaml");
  process.env["LLAMACTL_WORKLOADS_DIR"] = join(tmp, "workloads");
  process.env["LOCAL_AI_RUNTIME_DIR"] = join(tmp, "runtime");
  mkdirSync(process.env["LLAMACTL_WORKLOADS_DIR"], { recursive: true });
  mkdirSync(process.env["LOCAL_AI_RUNTIME_DIR"], { recursive: true });
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(tmp, { recursive: true, force: true });
});

function withCapturedIo<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const stdoutOrig = process.stdout.write.bind(process.stdout);
  const stderrOrig = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };

  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  return fn()
    .then((result) => ({ result, stdout, stderr }))
    .finally(() => {
      process.stdout.write = stdoutOrig;

      process.stderr.write = stderrOrig;
    });
}

function writeHost(options: {
  name: string;
  host: string;
  port: number;
  extraArgs?: string[];
  allowExternalBind?: boolean;
  labels?: Record<string, string>;
}): void {
  const allow = options.allowExternalBind === true;
  saveModelHost(
    ModelHostManifestSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "ModelHost",
      metadata: { name: options.name, ...(options.labels ? { labels: options.labels } : {}) },
      spec: {
        engine: "omlx",
        node: "local",
        binary: join(tmp, "omlx"),
        endpoint: { host: options.host, port: options.port },
        hostedModels: [{ rel: "mlx-community/Qwen3-8B-MLX-4bit" }],
        extraArgs: options.extraArgs ?? [],
        ...(allow ? { allowExternalBind: true } : {}),
      },
    }),
  );
}

interface GetRow {
  kind: string;
  name: string;
  exposedBind: string | null;
  allowExternalBind: boolean;
  managedBy: string | null;
}

function parseRows(stdout: string): GetRow[] {
  return JSON.parse(stdout) as GetRow[];
}

function writeGatewayRun(name: string, labels: Record<string, string>): void {
  workloadStore.saveWorkload(
    workloadSchema.ModelRunSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: { name, labels },
      spec: {
        node: "gw-node",
        target: { kind: "rel", value: "fake-org/fake-model.gguf" },
        gateway: true,
      },
    }),
  );
}

test("json: 0.0.0.0 endpoint with allowExternalBind reports exposedBind", async () => {
  writeHost({ name: "open-host", host: "0.0.0.0", port: 8094, allowExternalBind: true });

  const { result: code, stdout } = await withCapturedIo(() => runGet(["workloads", "--json"]));

  expect(code).toBe(0);
  const row = parseRows(stdout).find((r) => r.name === "open-host");
  expect(row?.exposedBind).toBe("0.0.0.0:8094");
  expect(row?.allowExternalBind).toBe(true);
});

test("json: --host in extraArgs is reported", async () => {
  writeHost({
    name: "arg-host",
    host: "127.0.0.1",
    port: 8095,
    extraArgs: ["--host", "192.168.1.5"],
    allowExternalBind: true,
  });

  const { result: code, stdout } = await withCapturedIo(() => runGet(["workloads", "--json"]));

  expect(code).toBe(0);
  const row = parseRows(stdout).find((r) => r.name === "arg-host");
  expect(row?.exposedBind).toBe("192.168.1.5:8095");
});

test("json: loopback host has null exposedBind", async () => {
  writeHost({ name: "quiet-host", host: "127.0.0.1", port: 8097 });

  const { result: code, stdout } = await withCapturedIo(() => runGet(["workloads", "--json"]));

  expect(code).toBe(0);
  const row = parseRows(stdout).find((r) => r.name === "quiet-host");
  expect(row?.exposedBind).toBeNull();
  expect(row?.allowExternalBind).toBe(false);
});

test("json: IPv6 wildcard is bracketed", async () => {
  writeHost({ name: "v6-host", host: "::", port: 8096, allowExternalBind: true });

  const { result: code, stdout } = await withCapturedIo(() => runGet(["workloads", "--json"]));

  expect(code).toBe(0);
  const row = parseRows(stdout).find((r) => r.name === "v6-host");
  expect(row?.exposedBind).toBe("[::]:8096");
});

test("text: warns for the exposed host only", async () => {
  writeHost({ name: "exposed-host", host: "0.0.0.0", port: 8094, allowExternalBind: true });
  writeHost({ name: "local-host", host: "127.0.0.1", port: 8098 });

  const { result: code, stdout } = await withCapturedIo(() => runGet(["workloads"]));

  expect(code).toBe(0);
  expect(stdout).toContain(
    "warning: modelhost/exposed-host binds an unauthenticated engine to 0.0.0.0:8094 (spec.allowExternalBind: true)",
  );
  expect(stdout).not.toContain("warning: modelhost/local-host");
});

test("text: exposed host without the opt-in says its next start is refused", async () => {
  writeHost({ name: "naive-host", host: "0.0.0.0", port: 8094 });

  const { result: code, stdout } = await withCapturedIo(() => runGet(["workloads"]));

  expect(code).toBe(0);
  expect(stdout).toContain("spec.allowExternalBind is not true, so its next start is refused");
});

test("json: managedBy carries the llamactl.io/managed-by label, null without it", async () => {
  writeHost({
    name: "seat-a",
    host: "127.0.0.1",
    port: 8101,
    labels: { [MANAGED_BY_LABEL]: "central-m4" },
  });
  writeHost({ name: "seat-b", host: "127.0.0.1", port: 8102 });

  const { result: code, stdout } = await withCapturedIo(() => runGet(["workloads", "--json"]));

  expect(code).toBe(0);
  expect(stdout).not.toContain("note: ");
  const rows = parseRows(stdout);
  expect(rows.find((r) => r.name === "seat-a")?.managedBy).toBe("central-m4");
  expect(rows.find((r) => r.name === "seat-b")?.managedBy).toBeNull();
});

test("json: a whitespace-only managed-by label reads as null", async () => {
  writeHost({
    name: "seat-w",
    host: "127.0.0.1",
    port: 8103,
    labels: { [MANAGED_BY_LABEL]: "   " },
  });

  const { result: code, stdout } = await withCapturedIo(() => runGet(["workloads", "--json"]));

  expect(code).toBe(0);
  const row = parseRows(stdout).find((r) => r.name === "seat-w");
  expect(row?.managedBy).toBeNull();
});

test("json: ModelRun rows carry managedBy null even when labeled", async () => {
  writeGatewayRun("gw-run", { [MANAGED_BY_LABEL]: "central-m4" });

  const { result: code, stdout } = await withCapturedIo(() => runGet(["workloads", "--json"]));

  expect(code).toBe(0);
  const row = parseRows(stdout).find((r) => r.name === "gw-run");
  if (!row) throw new Error("gw-run row missing");
  expect(row.kind).toBe("modelrun");
  expect("managedBy" in row).toBe(true);
  expect(row.managedBy).toBeNull();
});

test("text: one note line per externally managed host, table columns unchanged", async () => {
  writeHost({
    name: "seat-a",
    host: "127.0.0.1",
    port: 8101,
    labels: { [MANAGED_BY_LABEL]: "central-m4" },
  });
  writeHost({ name: "seat-b", host: "127.0.0.1", port: 8102 });

  const { result: code, stdout } = await withCapturedIo(() => runGet(["workloads"]));
  const lines = stdout.split("\n");

  expect(code).toBe(0);
  expect(lines[0]).toMatch(/^NAME +NODE +KIND +PHASE +REL$/);
  expect(lines.find((l) => l.startsWith("seat-a"))).toMatch(
    /^seat-a +local +modelhost +unknown +mlx-community\/Qwen3-8B-MLX-4bit$/,
  );
  const notes = lines.filter((l) => l.startsWith("note: "));
  expect(notes).toEqual([
    "note: modelhost/seat-a is managed by central-m4 (llamactl.io/managed-by); this controller does not reconcile it",
  ]);
  const noteIndex = lines.indexOf(notes[0]!);
  const seatBIndex = lines.findIndex((l) => l.startsWith("seat-b"));
  expect(noteIndex).toBeGreaterThan(seatBIndex);
});

test("help: GET_USAGE describes managedBy", async () => {
  const { result: code, stdout } = await withCapturedIo(() => runGet(["workloads", "--help"]));

  expect(code).toBe(0);
  expect(stdout).toContain("managedBy");
  expect(stdout).toContain("'note:'");
});
