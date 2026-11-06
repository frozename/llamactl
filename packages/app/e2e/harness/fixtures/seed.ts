// packages/app/e2e/harness/fixtures/seed.ts — #410 P5b part 1.
// Pure fixture data for the console e2e harness: the P2b-RED-9
// sentinels, the fixture fleet nodes, the ModelRun manifests and the
// serverStatus rows. Type-only imports keep this module safe under
// both Node and Bun, and every sentinel lives in the fixture data so
// the REAL console projections (allowlist.ts + redact.ts) are what
// keep it off the wire.

import type { nodeFacts, server } from "@llamactl/core";
import type { workloadSchema } from "@llamactl/remote";

export const E2E_SENTINELS = {
  arg: "sentinel-arg",
  bearer: "sentinel-bearer",
  cli: "sentinel-cli",
  hf: "sentinel-hf",
  kube: "sentinel-kube",
  lm: "sentinel-lm",
  log: "sentinel-log",
  pg: "sentinel-pg",
} as const;

export const E2E_SENTINEL_VALUES: readonly string[] = Object.values(E2E_SENTINELS);

export const E2E_PID = 4242;

// The argv rides under ServerStatus.extraArgs: the console allowlist
// masks argv only under the keys extraArgs / args / cmdline, so this
// must never be named "argv" — that key is not masked and would leak.
export const E2E_ARGV: readonly string[] = Object.freeze([
  "--api-key",
  E2E_SENTINELS.arg,
  `--hf-token=${E2E_SENTINELS.hf}`,
]);

// First line every serverLogs stream yields: proves the masked-line
// projection over the seed itself (--api-key via maskLineSecrets,
// Bearer via redactDeep).
export const E2E_BOOT_LINE = `--api-key ${E2E_SENTINELS.bearer} Authorization: Bearer ${E2E_SENTINELS.bearer} e2e boot`;

export const E2E_DEFAULT_NODE = "local";

export const E2E_UNREACHABLE_NODES: readonly string[] = Object.freeze(["agent-off"]);

export type E2EModelRun = workloadSchema.ModelRun;
export type E2EServerStatus = server.ServerStatus;
export type E2ENodeFacts = nodeFacts.NodeFacts;
export type E2ELogLineEvent = { type: "line"; line: string };

export const E2E_KUBECONFIG_YAML = `apiVersion: llamactl/v1
kind: Config
currentContext: default
contexts:
  - name: default
    cluster: home
    user: me
    defaultNode: ${E2E_DEFAULT_NODE}
clusters:
  - name: home
    nodes:
      - name: local
        endpoint: inproc://local
      - name: agent-1
        kind: agent
        endpoint: https://agent-1.fixture:8443
      - name: agent-off
        kind: agent
        endpoint: https://agent-off.fixture:8443
      - name: gw-1
        kind: gateway
        cloud:
          provider: openai-compatible
          baseUrl: http://gw-1.fixture:8080/v1
      - name: ragdb
        kind: rag
        rag:
          provider: pgvector
          endpoint: postgres://rag:${E2E_SENTINELS.pg}@db.local:5432/rag
users:
  - name: me
    token: ${E2E_SENTINELS.kube}
`;

function modelRun(name: string, node: string, extraArgs: readonly string[] = []): E2EModelRun {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { annotations: {}, labels: {}, name },
    spec: {
      allowExternalBind: false,
      enabled: true,
      extraArgs: [...extraArgs],
      gateway: false,
      node,
      restartPolicy: "Always",
      target: { kind: "rel", value: "model.gguf" },
      timeoutSeconds: 60,
      workers: [],
    },
  };
}

export const E2E_MODEL_RUNS: Readonly<Record<string, E2EModelRun>> = {
  wA: modelRun("wA", "local"),
  "wB-stopped": modelRun("wB-stopped", "agent-1"),
  wB: modelRun("wB", "agent-1", E2E_ARGV),
  wMulti: {
    ...modelRun("wMulti", "agent-1"),
    spec: {
      allowExternalBind: false,
      enabled: true,
      extraArgs: [],
      gateway: false,
      node: "agent-1",
      restartPolicy: "Always",
      target: { kind: "rel", value: "model.gguf" },
      timeoutSeconds: 60,
      workers: [
        {
          extraArgs: [],
          node: "local",
          rpcHost: "127.0.0.1",
          rpcPort: 50052,
          timeoutSeconds: 30,
        },
      ],
    },
  },
};

function statusRow(workload: string, port: number, up: boolean): E2EServerStatus {
  return {
    advertisedEndpoint: `http://127.0.0.1:${String(port)}`,
    binary: "/usr/local/bin/llama-server",
    endpoint: `http://127.0.0.1:${String(port)}`,
    extraArgs: workload === "wB" ? [...E2E_ARGV] : [],
    foreign: false,
    health: { httpCode: up ? 200 : null, reachable: up },
    host: "127.0.0.1",
    listenerPid: up ? E2E_PID : null,
    pid: E2E_PID,
    port,
    rel: "model.gguf",
    startedAt: up ? "2026-01-01T00:00:00.000Z" : null,
    state: up ? "up" : "down",
    tunedProfile: null,
  };
}

export const E2E_SERVER_STATUS: Readonly<Record<string, E2EServerStatus>> = {
  wA: statusRow("wA", 8080, true),
  "wB-stopped": statusRow("wB-stopped", 8081, false),
  wB: statusRow("wB", 8082, true),
  wMulti: statusRow("wMulti", 8083, true),
};

export const E2E_NODE_FACTS: E2ENodeFacts = {
  advertisedEndpoint: "http://127.0.0.1:8080",
  arch: "arm64",
  gpu: { kind: "metal", memoryMB: 49152, name: "M4 Pro" },
  llamaCppBuildId: null,
  memBytes: 51_539_607_552,
  nodeName: "local",
  os: "darwin",
  platform: "darwin-arm64",
  profile: "macbook-pro-48g",
  startedAt: "2026-01-01T00:00:00.000Z",
  versions: { bun: "1.4.3", llamaCppSrcRev: null, llamactl: "0.0.0" },
};

// env is a sentinel subset on purpose: the real procedure returns a
// full ResolvedEnv, and the console projection treats it as an opaque
// record (maskEnvSecrets + redactDeep), so the fixture must not
// fabricate host paths for fields no console view renders.
export const E2E_ENV: Readonly<Record<string, string>> = Object.freeze({
  DEV_STORAGE: "/tmp/llamactl-e2e-storage",
  LM_API_TOKEN: E2E_SENTINELS.lm,
  OPENAI_API_KEY: E2E_SENTINELS.lm,
});

export const E2E_WORKLOADS_DIR = "/tmp/llamactl-e2e-workloads";

export const E2E_CONSOLE_PORT = Number(process.env["CONSOLE_E2E_PORT"] ?? "4517");
export const E2E_CONTROL_PORT = Number(process.env["CONSOLE_E2E_CONTROL_PORT"] ?? "4518");
