import type { NodeClient } from "@llamactl/remote";

import { workloadSchema, workloadStore } from "@llamactl/remote";
import {
  MANAGED_BY_LABEL,
  ModelHostManifestSchema,
} from "@llamactl/remote/workload/modelhost-schema";
import { saveModelHost } from "@llamactl/remote/workload/modelhost-store";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __resetWorkloadTestSeams,
  __setWorkloadTestSeams,
  runGet,
} from "../src/commands/workload.js";
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
  __resetWorkloadTestSeams();
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
  node?: string;
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
        node: options.node ?? "local",
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
  node: string;
  phase: string;
  endpoint: string | null;
  statePid: number | null;
  listenerPid: number | null;
  exposedBind: string | null;
  allowExternalBind: boolean;
  managedBy: string | null;
}

function parseRows(stdout: string): GetRow[] {
  return JSON.parse(stdout) as GetRow[];
}

type StatusReply = {
  state: "Running" | "Stopped";
  pid?: number | null;
  identityUnknown?: boolean;
};

function stubStatus(reply: StatusReply | Error): { node: string; input: unknown }[] {
  const calls: { node: string; input: unknown }[] = [];
  __setWorkloadTestSeams({
    getNodeClientByName: (node: string) =>
      ({
        modelHostStatus: {
          query: (input: unknown) => {
            calls.push({ node, input });
            return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
          },
        },
      }) as unknown as NodeClient,
  });
  return calls;
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

type ServerStatusReply = {
  state: "up" | "down";
  rel: string | null;
  endpoint: string | null;
  pid: number | null;
  listenerPid: number | null;
  foreign: boolean;
};

function writeRun(name: string, node: string): void {
  workloadStore.saveWorkload(
    workloadSchema.ModelRunSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: { name },
      spec: { node, target: { kind: "rel", value: "fake-org/fake-model.gguf" } },
    }),
  );
}

// #221: every query to `hungNode` stays pending until release(); every other node answers at once.
// release() only lets the test finish cleanly. With the deadline the row is already Unreachable by then.
function stubHungNode(hungNode: string): { release: () => void } {
  let open = (): void => undefined;
  const hung = new Promise<void>((resolve): void => {
    open = (): void => {
      resolve();
    };
  });
  function answer<T>(node: string, reply: T): Promise<T> {
    return node === hungNode ? hung.then((): T => reply) : Promise.resolve(reply);
  }
  __setWorkloadTestSeams({
    getNodeClientByName: (node: string): NodeClient =>
      ({
        modelHostStatus: {
          query: (): Promise<StatusReply> => answer(node, { state: "Running", pid: 4242 }),
        },
        serverStatus: {
          query: (): Promise<ServerStatusReply> =>
            answer(node, {
              state: "up",
              rel: "fake-org/fake-model.gguf",
              endpoint: "http://127.0.0.1:8200",
              pid: 4100,
              listenerPid: 4100,
              foreign: false,
            }),
        },
      }) as unknown as NodeClient,
    nodeQueryTimeoutMs: 1,
  });
  return {
    release: (): void => {
      open();
    },
  };
}

// Resolves "settled" when `work` settles first, or "stalled" after `limitMs`. The bound only
// turns a hang into an assertion failure; with the 1 ms deadline the work settles far sooner.
async function settledWithin(
  work: Promise<unknown>,
  limitMs: number,
): Promise<"settled" | "stalled"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<"stalled">((resolve): void => {
    timer = setTimeout((): void => {
      resolve("stalled");
    }, limitMs);
  });
  try {
    return await Promise.race([work.then((): "settled" => "settled"), stall]);
  } finally {
    clearTimeout(timer);
  }
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
  expect(stdout).toContain("modelHostStatus");
  expect(stdout).toContain("10 s deadline");
});

test("json: remote ModelHost reads Running and pid from the node client", async () => {
  writeHost({ name: "gufo-remote", host: "127.0.0.1", port: 8110, node: "z13" });
  const calls = stubStatus({ state: "Running", pid: 3085 });

  const { result: code, stdout } = await withCapturedIo(() => runGet(["workloads", "--json"]));

  expect(code).toBe(0);
  const row = parseRows(stdout).find((r) => r.name === "gufo-remote");
  expect(row?.node).toBe("z13");
  expect(row?.phase).toBe("Running");
  expect(row?.statePid).toBe(3085);
  expect(row?.listenerPid).toBeNull();
  expect(row?.endpoint).toBe("http://127.0.0.1:8110");
  expect(calls).toEqual([{ node: "z13", input: { workload: "gufo-remote" } }]);
});

test("json: remote ModelHost reads Stopped from the node client", async () => {
  writeHost({ name: "mac-stopped", host: "127.0.0.1", port: 8111, node: "mac-mini" });
  const calls = stubStatus({ state: "Stopped", pid: null });

  const { result: code, stdout } = await withCapturedIo(() => runGet(["workloads", "--json"]));

  expect(code).toBe(0);
  const row = parseRows(stdout).find((r) => r.name === "mac-stopped");
  expect(row?.phase).toBe("Stopped");
  expect(row?.statePid).toBeNull();
  expect(calls).toEqual([{ node: "mac-mini", input: { workload: "mac-stopped" } }]);
});

test("json: remote ModelHost with an unproven pid reads unknown", async () => {
  writeHost({ name: "mac-unsure", host: "127.0.0.1", port: 8112, node: "mac-mini" });
  const calls = stubStatus({ state: "Stopped", identityUnknown: true });

  const { result: code, stdout } = await withCapturedIo(() => runGet(["workloads", "--json"]));

  expect(code).toBe(0);
  const row = parseRows(stdout).find((r) => r.name === "mac-unsure");
  expect(row?.phase).toBe("unknown");
  expect(row?.statePid).toBeNull();
  expect(calls).toHaveLength(1);
});

test("json: remote ModelHost whose node fails reads Unreachable", async () => {
  writeHost({ name: "z13-down", host: "127.0.0.1", port: 8113, node: "z13" });
  const calls = stubStatus(new Error("connect ECONNREFUSED"));

  const { result: code, stdout } = await withCapturedIo(() => runGet(["workloads", "--json"]));

  expect(code).toBe(0);
  const row = parseRows(stdout).find((r) => r.name === "z13-down");
  expect(row?.phase).toBe("Unreachable");
  expect(row?.statePid).toBeNull();
  expect(row?.listenerPid).toBeNull();
  expect(row?.endpoint).toBe("http://127.0.0.1:8113");
  expect(calls).toHaveLength(1);
});

test("json: a local ModelHost never asks the node client", async () => {
  writeHost({ name: "seat-l", host: "127.0.0.1", port: 8114 });
  const calls = stubStatus({ state: "Running", pid: 1 });

  const { result: code, stdout } = await withCapturedIo(() => runGet(["workloads", "--json"]));

  expect(code).toBe(0);
  const row = parseRows(stdout).find((r) => r.name === "seat-l");
  expect(row?.phase).toBe("unknown");
  expect(row?.endpoint).toBeNull();
  expect(row?.statePid).toBeNull();
  expect(calls).toEqual([]);
});

test("text: a remote Running ModelHost shows Running in the table", async () => {
  writeHost({ name: "gufo-remote", host: "127.0.0.1", port: 8110, node: "z13" });
  stubStatus({ state: "Running", pid: 3085 });

  const { result: code, stdout } = await withCapturedIo(() => runGet(["workloads"]));

  expect(code).toBe(0);
  expect(stdout.split("\n").find((l) => l.startsWith("gufo-remote"))).toMatch(
    /^gufo-remote +z13 +modelhost +Running +mlx-community\/Qwen3-8B-MLX-4bit$/,
  );
});

test("json: a remote ModelHost whose node never answers reads Unreachable without stalling the table (#221)", async () => {
  writeHost({ name: "hung-host", host: "127.0.0.1", port: 8120, node: "gpu1" });
  writeHost({ name: "live-host", host: "127.0.0.1", port: 8121, node: "z13" });
  const stub = stubHungNode("gpu1");

  const pending = withCapturedIo(() => runGet(["workloads", "--json"]));
  const outcome = await settledWithin(pending, 2_000);
  stub.release();
  const { result: code, stdout } = await pending;

  expect(outcome).toBe("settled");
  expect(code).toBe(0);
  const rows = parseRows(stdout);
  const hung = rows.find((r) => r.name === "hung-host");
  expect(hung?.phase).toBe("Unreachable");
  expect(hung?.statePid).toBeNull();
  expect(hung?.endpoint).toBe("http://127.0.0.1:8120");
  const live = rows.find((r) => r.name === "live-host");
  expect(live?.phase).toBe("Running");
  expect(live?.statePid).toBe(4242);
});

test("json: a ModelRun whose node never answers reads Unreachable without stalling the table (#221)", async () => {
  writeRun("hung-run", "gpu1");
  writeRun("live-run", "z13");
  const stub = stubHungNode("gpu1");

  const pending = withCapturedIo(() => runGet(["workloads", "--json"]));
  const outcome = await settledWithin(pending, 2_000);
  stub.release();
  const { result: code, stdout } = await pending;

  expect(outcome).toBe("settled");
  expect(code).toBe(0);
  const rows = parseRows(stdout);
  const hung = rows.find((r) => r.name === "hung-run");
  expect(hung?.kind).toBe("modelrun");
  expect(hung?.phase).toBe("Unreachable");
  expect(hung?.endpoint).toBeNull();
  const live = rows.find((r) => r.name === "live-run");
  expect(live?.phase).toBe("Running");
  expect(live?.statePid).toBe(4100);
  expect(live?.endpoint).toBe("http://127.0.0.1:8200");
});
