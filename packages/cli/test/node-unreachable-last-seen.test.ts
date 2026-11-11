// RED pins for frozename/llamactl#221: when a node misses its query deadline,
// `get workloads` rows and `node ls` entries must surface the last time the
// node answered and the last error seen. None of that exists at c7d17480, so
// every new assertion fails there on missing fields/output — never on an
// import — and must pass once the node-contact record lands. Node clients are
// fakes behind the workload test seams; nothing here touches the network.

import { workloadSchema, workloadStore } from "@llamactl/remote";
import { ModelHostManifestSchema } from "@llamactl/remote/workload/modelhost-schema";
import { saveModelHost } from "@llamactl/remote/workload/modelhost-store";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

import { runNode } from "../src/commands/node.js";
import {
  __resetWorkloadTestSeams,
  __setWorkloadTestSeams,
  runGet,
} from "../src/commands/workload.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../src/safe-fs.js";

const T1 = "2026-11-05T12:00:00.000Z";
const T2 = "2026-11-05T12:05:00.000Z";
const T3 = "2026-11-05T12:10:00.000Z";
const ERR = "node 'gpu1' did not answer within 1 ms";

const TRANSPORT_ERR = "fetch failed: connect ECONNREFUSED 10.0.0.7:7843";

type QueryMode = "ok" | "hung" | "appError" | "transportError";

type WorkloadSeams = Parameters<typeof __setWorkloadTestSeams>[0];
type NodeClientFactory = NonNullable<WorkloadSeams["getNodeClientByName"]>;

interface GetRow {
  kind: string;
  name: string;
  node: string;
  phase: string;
  rel: string;
  endpoint: string | null;
  statePid: number | null;
  listenerPid: number | null;
  gateway: boolean;
  managedBy: string | null;
  lastSeen?: string | null;
  error?: string;
  nodeQuery?: unknown;
}

interface LsNode {
  name: string;
  endpoint: string;
  phase?: string;
  lastSeen?: string | null;
  observedAt?: string;
  error?: string;
}

let tmp = "";
const originalEnv = { ...process.env };
const seamReleases: (() => void)[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-node-contact-"));
  process.env["DEV_STORAGE"] = tmp;
  const workloadsDir = join(tmp, "workloads");
  const runtimeDir = join(tmp, "runtime");
  process.env["LLAMACTL_WORKLOADS_DIR"] = workloadsDir;
  process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
  process.env["LLAMACTL_CONFIG"] = join(tmp, "config");
  mkdirSync(workloadsDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
});

afterEach(() => {
  for (const release of seamReleases.splice(0)) release();
  __resetWorkloadTestSeams();
  process.env = { ...originalEnv };
  rmSync(tmp, { recursive: true, force: true });
});

function withIo<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
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

function seedConfig(): void {
  writeFileSync(
    join(tmp, "config"),
    stringify({
      apiVersion: "llamactl/v1",
      kind: "Config",
      currentContext: "default",
      contexts: [{ name: "default", cluster: "home", user: "me", defaultNode: "local" }],
      clusters: [
        {
          name: "home",
          nodes: [
            { name: "local", endpoint: "inproc://local" },
            { name: "gpu1", endpoint: "https://gpu1.lan:7843" },
          ],
        },
      ],
      users: [{ name: "me", token: "tok-a" }],
    }),
  );
}

function saveHost(name: string, node: string, port: number): void {
  saveModelHost(
    ModelHostManifestSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "ModelHost",
      metadata: { name },
      spec: {
        engine: "omlx",
        node,
        binary: join(tmp, "omlx"),
        endpoint: { host: "127.0.0.1", port },
        hostedModels: [{ rel: "mlx-community/Qwen3-8B-MLX-4bit" }],
      },
    }),
  );
}

function seedRemoteWorkloads(): void {
  saveHost("hung-host", "gpu1", 8120);
  workloadStore.saveWorkload(
    workloadSchema.ModelRunSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: { name: "hung-run" },
      spec: { node: "gpu1", target: { kind: "rel", value: "fake-org/fake-model.gguf" } },
    }),
  );
}

// "ok" resolves the healthy reply, "hung" stays pending until afterEach
// releases the gate (the 1 ms query deadline still fires first), and
// "appError" rejects with the shape of a tRPC error the node itself sent
// back — an answer, not a silence. "transportError" rejects with a plain
// Error carrying no tRPC data.code, the shape of a connection failure.
// `message` overrides the error text of either rejecting mode.
function seamFor(opts: { host: QueryMode; run: QueryMode; now: string; message?: string }): void {
  let openGate = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  seamReleases.push(() => {
    openGate();
  });

  const answer = <T>(mode: QueryMode, ok: T): Promise<T> => {
    if (mode === "hung") return gate.then((): T => ok);
    if (mode === "appError") {
      return Promise.reject(
        Object.assign(new Error(opts.message ?? "no such workload"), {
          data: { code: "NOT_FOUND" },
        }),
      );
    }
    if (mode === "transportError") return Promise.reject(new Error(opts.message ?? TRANSPORT_ERR));
    return Promise.resolve(ok);
  };

  const client = {
    modelHostStatus: {
      query: (): Promise<unknown> => answer(opts.host, { state: "Running", pid: 4242 }),
    },
    serverStatus: {
      query: (): Promise<unknown> =>
        answer(opts.run, {
          state: "up",
          rel: "fake-org/fake-model.gguf",
          endpoint: "http://127.0.0.1:8200",
          pid: 4100,
          listenerPid: 4100,
          foreign: false,
        }),
    },
  };

  __setWorkloadTestSeams({
    getNodeClientByName: (() => client) as unknown as NodeClientFactory,
    nodeQueryTimeoutMs: 1,
    now: () => new Date(opts.now),
  });
}

async function getWorkloadsJson(): Promise<GetRow[]> {
  const { result: code, stdout } = await withIo(() => runGet(["workloads", "--json"]));
  expect(code).toBe(0);
  return JSON.parse(stdout) as GetRow[];
}

async function getWorkloadsText(): Promise<string> {
  const { result: code, stdout } = await withIo(() => runGet(["workloads"]));
  expect(code).toBe(0);
  return stdout;
}

async function nodeLsJson(): Promise<{ context: string; nodes: LsNode[] }> {
  const { result: code, stdout } = await withIo(() => runNode(["ls", "--json"]));
  expect(code).toBe(0);
  return JSON.parse(stdout) as { context: string; nodes: LsNode[] };
}

async function nodeLsText(): Promise<string> {
  const { result: code, stdout } = await withIo(() => runNode(["ls"]));
  expect(code).toBe(0);
  return stdout;
}

function rowByName(rows: GetRow[], name: string): GetRow {
  const row = rows.find((r) => r.name === name);
  if (!row) throw new Error(`${name} missing from get workloads`);
  return row;
}

function gpu1Node(nodes: LsNode[]): LsNode {
  const node = nodes.find((n) => n.name === "gpu1");
  if (!node) throw new Error("gpu1 missing from node ls");
  return node;
}

// The shared prefix of cases (1) and (3)-(7): a healthy pass at T1 records
// the node's last answer, then a hung pass at T2 records the miss. Returns
// the run-2 rows.
async function runOkThenHung(): Promise<GetRow[]> {
  seamFor({ host: "ok", run: "ok", now: T1 });
  await getWorkloadsJson();
  seamFor({ host: "hung", run: "hung", now: T2 });
  return await getWorkloadsJson();
}

test("get workloads --json: unreachable rows carry lastSeen and the deadline error (#221)", async () => {
  seedConfig();
  seedRemoteWorkloads();

  const rows = await runOkThenHung();

  expect(rows.map((r) => `${r.kind}/${r.name}`)).toEqual([
    "modelrun/hung-run",
    "modelhost/hung-host",
  ]);
  for (const name of ["hung-run", "hung-host"]) {
    const row = rowByName(rows, name);
    expect(row.phase).toBe("Unreachable");
    expect(row.lastSeen).toBe(T1);
    expect(row.error).toBe(ERR);
  }
});

test("get workloads --json: a node that never answered reports lastSeen null (#221)", async () => {
  seedConfig();
  seedRemoteWorkloads();
  seamFor({ host: "hung", run: "hung", now: T2 });

  const rows = await getWorkloadsJson();

  for (const name of ["hung-run", "hung-host"]) {
    const row = rowByName(rows, name);
    expect(row.phase).toBe("Unreachable");
    expect(row.error).toBe(ERR);
    expect(row.lastSeen).toBeNull();
  }
});

test("get workloads text: unreachable rows print last-answered lines (#221)", async () => {
  seedConfig();
  seedRemoteWorkloads();
  await runOkThenHung();

  const lines = (await getWorkloadsText()).split("\n");

  expect(lines[0]).toMatch(/^NAME +NODE +KIND +PHASE +REL$/);
  expect(lines.find((l) => l.startsWith("hung-host"))).toMatch(
    /^hung-host +gpu1 +modelhost +Unreachable +mlx-community\/Qwen3-8B-MLX-4bit$/,
  );
  expect(lines.find((l) => l.startsWith("hung-run"))).toMatch(
    /^hung-run +gpu1 +modelrun +Unreachable +fake-org\/fake-model.gguf$/,
  );
  expect(lines.filter((l) => l.startsWith("unreachable: "))).toEqual([
    `unreachable: modelrun/hung-run on node gpu1, last answered ${T1}: ${ERR}`,
    `unreachable: modelhost/hung-host on node gpu1, last answered ${T1}: ${ERR}`,
  ]);
});

test("get workloads text: a never-answered node prints 'last answered never' (#221)", async () => {
  seedConfig();
  seedRemoteWorkloads();
  seamFor({ host: "hung", run: "hung", now: T2 });

  const lines = (await getWorkloadsText()).split("\n");

  expect(lines.filter((l) => l.startsWith("unreachable: "))).toEqual([
    `unreachable: modelrun/hung-run on node gpu1, last answered never: ${ERR}`,
    `unreachable: modelhost/hung-host on node gpu1, last answered never: ${ERR}`,
  ]);
});

test("node ls --json: an unreachable node carries phase, lastSeen, observedAt and error (#221)", async () => {
  seedConfig();
  seedRemoteWorkloads();
  await runOkThenHung();

  const { nodes } = await nodeLsJson();

  expect(nodes).toEqual([
    { name: "local", endpoint: "inproc://local" },
    {
      name: "gpu1",
      endpoint: "https://gpu1.lan:7843",
      phase: "Unreachable",
      lastSeen: T1,
      observedAt: T2,
      error: ERR,
    },
  ]);
});

test("node ls text: prints the unreachable line with observed and last-answered times (#221)", async () => {
  seedConfig();
  seedRemoteWorkloads();
  await runOkThenHung();

  expect(await nodeLsText()).toBe(
    "local  inproc://local (default)\n" +
      "gpu1   https://gpu1.lan:7843\n" +
      `unreachable: gpu1 as of ${T2}, last answered ${T1}: ${ERR}\n`,
  );
});

test("a node that answers again clears its unreachable record (#221)", async () => {
  seedConfig();
  seedRemoteWorkloads();
  await runOkThenHung();

  const before = await nodeLsJson();
  expect(gpu1Node(before.nodes).phase).toBe("Unreachable");

  seamFor({ host: "ok", run: "ok", now: T3 });
  await getWorkloadsJson();

  const after = await nodeLsJson();
  expect(gpu1Node(after.nodes)).toEqual({ name: "gpu1", endpoint: "https://gpu1.lan:7843" });
  expect(await nodeLsText()).not.toContain("unreachable:");
});

test("node rm clears the node contact record (#221)", async () => {
  seedConfig();
  seedRemoteWorkloads();
  await runOkThenHung();

  const before = await nodeLsJson();
  expect(gpu1Node(before.nodes).phase).toBe("Unreachable");

  const rm = await withIo(() => runNode(["rm", "gpu1"]));
  expect(rm.result).toBe(0);

  seedConfig();
  const after = await nodeLsJson();
  expect(gpu1Node(after.nodes)).toEqual({ name: "gpu1", endpoint: "https://gpu1.lan:7843" });
  expect(existsSync(join(tmp, "workloads", ".node-contact", "home", "gpu1.json"))).toBe(false);
});

test("get workloads --json: a node-sent error counts as the node answering (#221)", async () => {
  seedConfig();
  seedRemoteWorkloads();
  seamFor({ host: "ok", run: "ok", now: T1 });
  await getWorkloadsJson();
  seamFor({ host: "ok", run: "appError", now: T2 });

  const rows = await getWorkloadsJson();
  const runRow = rowByName(rows, "hung-run");
  expect(runRow.phase).toBe("Unreachable");
  expect(runRow.error).toBe("no such workload");
  expect(runRow.lastSeen).toBe(T2);

  const { nodes } = await nodeLsJson();
  expect(gpu1Node(nodes)).toEqual({ name: "gpu1", endpoint: "https://gpu1.lan:7843" });
});

test("get workloads --json: mixed outcomes in one run keep the node reachable (#221)", async () => {
  seedConfig();
  seedRemoteWorkloads();
  seamFor({ host: "ok", run: "hung", now: T2 });

  const rows = await getWorkloadsJson();
  const runRow = rowByName(rows, "hung-run");
  expect(runRow.phase).toBe("Unreachable");
  expect(runRow.error).toBe(ERR);
  expect(runRow.lastSeen).toBe(T2);
  const hostRow = rowByName(rows, "hung-host");
  expect(hostRow.phase).toBe("Running");
  expect("error" in hostRow).toBe(false);

  const { nodes } = await nodeLsJson();
  expect(gpu1Node(nodes)).toEqual({ name: "gpu1", endpoint: "https://gpu1.lan:7843" });
});

test("get workloads: healthy rows carry no contact keys (#221)", async () => {
  seedConfig();
  seedRemoteWorkloads();
  seamFor({ host: "ok", run: "ok", now: T1 });

  const rows = await getWorkloadsJson();
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect("lastSeen" in row).toBe(false);
    expect("error" in row).toBe(false);
    expect("nodeQuery" in row).toBe(false);
  }
  expect(await getWorkloadsText()).not.toContain("unreachable:");
});

test("a local ModelHost with no state file reads Stopped without contact keys (#221)", async () => {
  seedConfig();
  saveHost("local-host", "local", 8115);
  seamFor({ host: "ok", run: "ok", now: T1 });

  const rows = await getWorkloadsJson();
  const row = rowByName(rows, "local-host");
  expect(row.phase).toBe("Stopped");
  expect("lastSeen" in row).toBe(false);
  expect("error" in row).toBe(false);
});

test("get workloads --json: node-sent errors on every row still count as the node answering (#221)", async () => {
  seedConfig();
  seedRemoteWorkloads();
  seamFor({ host: "ok", run: "ok", now: T1 });
  await getWorkloadsJson();
  seamFor({ host: "appError", run: "appError", now: T2 });

  const rows = await getWorkloadsJson();
  for (const name of ["hung-run", "hung-host"]) {
    const row = rowByName(rows, name);
    expect(row.phase).toBe("Unreachable");
    expect(row.error).toBe("no such workload");
    expect(row.lastSeen).toBe(T2);
  }

  const { nodes } = await nodeLsJson();
  expect(gpu1Node(nodes)).toEqual({ name: "gpu1", endpoint: "https://gpu1.lan:7843" });
  expect(await nodeLsText()).not.toContain("unreachable:");
});

test("get workloads --json: a plain Error without data.code counts as the node not answering (#221)", async () => {
  seedConfig();
  seedRemoteWorkloads();
  seamFor({ host: "ok", run: "ok", now: T1 });
  await getWorkloadsJson();
  seamFor({ host: "transportError", run: "transportError", now: T2 });

  const rows = await getWorkloadsJson();
  for (const name of ["hung-run", "hung-host"]) {
    const row = rowByName(rows, name);
    expect(row.phase).toBe("Unreachable");
    expect(row.error).toBe(TRANSPORT_ERR);
    expect(row.lastSeen).toBe(T1);
  }

  const { nodes } = await nodeLsJson();
  expect(gpu1Node(nodes)).toEqual({
    name: "gpu1",
    endpoint: "https://gpu1.lan:7843",
    phase: "Unreachable",
    lastSeen: T1,
    observedAt: T2,
    error: TRANSPORT_ERR,
  });
});

test("node ls reports the first failing row's error when rows on one node fail differently (#221)", async () => {
  seedConfig();
  seedRemoteWorkloads();
  seamFor({ host: "ok", run: "ok", now: T1 });
  await getWorkloadsJson();
  // Rows are inspected ModelRuns first: the run misses its deadline, then the
  // host fails on transport.
  seamFor({ host: "transportError", run: "hung", now: T2 });

  const rows = await getWorkloadsJson();
  expect(rowByName(rows, "hung-run").error).toBe(ERR);
  expect(rowByName(rows, "hung-host").error).toBe(TRANSPORT_ERR);

  const { nodes } = await nodeLsJson();
  expect(gpu1Node(nodes).error).toBe(ERR);
  expect(await nodeLsText()).toContain(
    `unreachable: gpu1 as of ${T2}, last answered ${T1}: ${ERR}\n`,
  );
});

const LEAKY = "upstream said:\n\u001b[31mdenied\u001b[0m for Bearer abc123\r\tretry\u0007";
const LEAKY_CLEAN = "upstream said: denied for Bearer [redacted] retry";

function expectClean(text: string): void {
  expect(text).not.toContain("abc123");
  // eslint-disable-next-line no-control-regex
  expect(/[\u0000-\u001f\u007f-\u009f]/.test(text)).toBe(false);
}

test("contact errors are redacted and single-line in --json, text and node ls (#221)", async () => {
  seedConfig();
  seedRemoteWorkloads();
  seamFor({ host: "appError", run: "appError", now: T1, message: LEAKY });

  const answeredRows = await getWorkloadsJson();
  for (const row of answeredRows) expect(row.error).toBe(LEAKY_CLEAN);
  const answeredText = await getWorkloadsText();
  expect(answeredText).toContain(
    `unreachable: modelrun/hung-run on node gpu1, last answered ${T1}: ${LEAKY_CLEAN}\n`,
  );
  expect(answeredText).not.toContain("abc123");
  expect(answeredText).not.toContain("\u001b");

  seamFor({ host: "transportError", run: "transportError", now: T2, message: LEAKY });
  const failedRows = await getWorkloadsJson();
  for (const row of failedRows) expect(row.error).toBe(LEAKY_CLEAN);

  const stored = readFileSync(join(tmp, "workloads", ".node-contact", "home", "gpu1.json"), "utf8");
  expect(stored).not.toContain("abc123");
  expect((JSON.parse(stored) as { lastError: string }).lastError).toBe(LEAKY_CLEAN);

  const { nodes } = await nodeLsJson();
  expect(gpu1Node(nodes).error).toBe(LEAKY_CLEAN);
  const lsText = await nodeLsText();
  expect(lsText).toBe(
    "local  inproc://local (default)\n" +
      "gpu1   https://gpu1.lan:7843\n" +
      `unreachable: gpu1 as of ${T2}, last answered ${T1}: ${LEAKY_CLEAN}\n`,
  );
  expectClean(lsText.replaceAll("\n", " "));
});

function seedTwoContextConfig(current: "default" | "lab"): void {
  writeFileSync(
    join(tmp, "config"),
    stringify({
      apiVersion: "llamactl/v1",
      kind: "Config",
      currentContext: current,
      contexts: [
        { name: "default", cluster: "home", user: "me", defaultNode: "local" },
        { name: "lab", cluster: "lab", user: "me", defaultNode: "local" },
      ],
      clusters: [
        {
          name: "home",
          nodes: [
            { name: "local", endpoint: "inproc://local" },
            { name: "gpu1", endpoint: "https://gpu1.lan:7843" },
          ],
        },
        {
          name: "lab",
          nodes: [
            { name: "local", endpoint: "inproc://local" },
            { name: "gpu1", endpoint: "https://gpu1.lab:7843" },
          ],
        },
      ],
      users: [{ name: "me", token: "tok-a" }],
    }),
  );
}

test("contact records are scoped to the context's cluster (#221)", async () => {
  seedTwoContextConfig("default");
  seedRemoteWorkloads();
  await runOkThenHung();
  expect(gpu1Node((await nodeLsJson()).nodes).phase).toBe("Unreachable");

  // The lab cluster's gpu1 is a different node: home's miss does not show.
  seedTwoContextConfig("lab");
  expect(gpu1Node((await nodeLsJson()).nodes)).toEqual({
    name: "gpu1",
    endpoint: "https://gpu1.lab:7843",
  });

  // lab's gpu1 answering does not clear home's record.
  seamFor({ host: "ok", run: "ok", now: T3 });
  await getWorkloadsJson();
  seedTwoContextConfig("default");
  const home = gpu1Node((await nodeLsJson()).nodes);
  expect(home.phase).toBe("Unreachable");
  expect(home.lastSeen).toBe(T1);
  expect(home.observedAt).toBe(T2);
});
