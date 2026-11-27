import { getAuthenticatedAgentClientByName } from "@llamactl/cli/dispatcher";
import {
  auth,
  config,
  configSchema,
  noderunStore,
  startAgentServer,
  startManagedAgentServer,
  tls,
  type tunnel,
  workloadStore,
} from "@llamactl/remote";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, rmSync } from "../src/safe-fs.js";
import { buildMcpServer } from "../src/server.js";

const TOOL = "llamactl.residency.control";
const NODE = "managed-owner";
const WORKLOAD = "transport-model";
const OPERATOR = "fixture-owner-operator";
const TUNNEL = "fixture-node-tunnel";

function configure(dir: string): () => void {
  const values = {
    DEV_STORAGE: dir,
    LOCAL_AI_RUNTIME_DIR: join(dir, "runtime"),
    LLAMACTL_WORKLOADS_DIR: join(dir, "workloads"),
    LLAMACTL_RESIDENCY_STORE: join(dir, "operations.sqlite"),
    LLAMACTL_CONFIG: join(dir, "config.yaml"),
    LLAMACTL_MCP_AUDIT_DIR: join(dir, "audit"),
  };
  const previous = Object.keys(values).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, values);
  noderunStore.saveNodeRun(
    noderunStore.parseNodeRun(`
apiVersion: llamactl/v1
kind: NodeRun
metadata: { name: ${NODE} }
spec: { node: ${NODE}, budget: { memoryGiB: 24 } }
`),
    values.LLAMACTL_WORKLOADS_DIR,
  );
  workloadStore.saveWorkload(
    workloadStore.parseWorkload(`
apiVersion: llamactl/v1
kind: ModelRun
metadata: { name: ${WORKLOAD} }
spec:
  node: ${NODE}
  target: { kind: rel, value: transport-fixture.gguf }
  resources: { expectedMemoryGiB: 2 }
`),
    values.LLAMACTL_WORKLOADS_DIR,
  );
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  };
}

function resultOf(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const first: unknown = Array.isArray(result.content) ? result.content[0] : null;
  if (
    first === null ||
    typeof first !== "object" ||
    !("text" in first) ||
    typeof first.text !== "string"
  ) {
    throw new Error("MCP tool did not return a text result");
  }
  return JSON.parse(first.text) as unknown;
}

test("managed residency MCP uses the selected authenticated direct and tunnel endpoints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-managed-mcp-"));
  const restore = configure(dir);
  const ready = Promise.withResolvers<undefined>();
  const direct: string[] = [];
  const relay: string[] = [];
  const server = buildMcpServer();
  const client = new Client({ name: "transport-fixture", version: "1" });
  let central: ReturnType<typeof startAgentServer> | undefined;
  let owner: Awaited<ReturnType<typeof startManagedAgentServer>> | undefined;
  try {
    const cert = await tls.generateSelfSignedCert({ dir, commonName: "127.0.0.1" });
    const tlsPaths = { certPath: cert.certPath, keyPath: cert.keyPath };
    const shared = { tls: tlsPaths, tokenHash: auth.hashToken(OPERATOR), advertiseMdns: false };
    central = startAgentServer({
      ...shared,
      tunnelCentral: { expectedBearerHash: auth.hashToken(TUNNEL) },
      tunnelJournalPath: join(dir, "tunnel.jsonl"),
      onRequest: ({ pathname }) => {
        relay.push(pathname);
      },
    });
    const centralUrl = central.url;
    const PinnedWebSocket = class extends WebSocket {
      constructor(url: string) {
        super(url, { tls: { ca: cert.certPem } });
      }
    };
    owner = await startManagedAgentServer(
      {
        ...shared,
        onRequest: ({ pathname }) => {
          direct.push(pathname);
        },
        tunnelDial: {
          url: `${centralUrl.replace("https://", "wss://")}/tunnel`,
          bearer: TUNNEL,
          nodeName: NODE,
          WebSocketCtor: PinnedWebSocket as unknown as tunnel.ClientWebSocketConstructor,
          onStateChange: (state) => {
            if (state === "ready") ready.resolve(undefined);
          },
        },
      },
      NODE,
      {
        nowMs: () => 100,
        onCapacityAudit: () => undefined,
        readCapacity: () => ({
          source: "linux-procfs",
          observedAtMs: 100,
          physicalBytes: 64 * 1024 ** 3,
          availableBytes: 48 * 1024 ** 3,
          scope: { kind: "host-physical" },
          pressure: "normal",
          swapUsedBytes: 0,
        }),
      },
    );
    const cfg = configSchema.freshConfig();
    const cluster = cfg.clusters.at(0);
    const context = cfg.contexts.at(0);
    const user = cfg.users.at(0);
    if (cluster === undefined || context === undefined || user === undefined)
      throw new Error("fixture kubeconfig incomplete");
    user.token = OPERATOR;
    const node = {
      name: NODE,
      endpoint: owner.url,
      certificate: cert.certPem,
      certificateFingerprint: cert.fingerprint,
      tunnelPreferred: false,
    };
    cluster.nodes.push(node, { name: "local-alias", endpoint: configSchema.LOCAL_NODE_ENDPOINT });
    config.saveConfig(cfg);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const request = { node: NODE, workload: WORKLOAD, action: "load" };
    expect(
      (await client.listTools()).tools.find((tool) => tool.name === TOOL)?.annotations
        ?.destructiveHint,
    ).toBe(true);

    const dry = await client.callTool({ name: TOOL, arguments: request });
    expect(resultOf(dry)).toMatchObject({ ok: true, outcome: "preview", ...request });
    expect(direct).toEqual(["/trpc/residencyControl"]);

    const unconfirmed = await client.callTool({
      name: TOOL,
      arguments: { ...request, dryRun: false },
    });
    expect(unconfirmed.isError).toBe(true);
    expect(resultOf(unconfirmed)).toMatchObject({ ok: false, reason: "ConfirmationRequired" });
    expect(direct).toHaveLength(1);

    const injected = await client.callTool({
      name: TOOL,
      arguments: { ...request, authorization: "fixture-untrusted-field" },
    });
    expect(injected.isError).toBe(true);
    for (const badTarget of ["all", "local", "local-alias"]) {
      const rejected = await client.callTool({
        name: TOOL,
        arguments: { ...request, node: badTarget },
      });
      expect(rejected.isError).toBe(true);
      expect(resultOf(rejected)).toMatchObject({ ok: false, reason: "ControlTransportError" });
    }
    expect(direct).toHaveLength(1);

    const refused = await client.callTool({
      name: TOOL,
      arguments: { ...request, action: "unload", dryRun: false, confirm: true },
    });
    expect(refused.isError).toBe(true);
    expect(resultOf(refused)).toMatchObject({ ok: false, reason: "WorkloadProtected" });
    expect(direct).toHaveLength(2);

    await ready.promise;
    context.tunnelCentralUrl = centralUrl;
    context.tunnelCentralCertificate = cert.certPem;
    context.tunnelCentralFingerprint = cert.fingerprint;
    node.tunnelPreferred = true;
    node.endpoint = "https://127.0.0.1:1";
    config.saveConfig(cfg);
    const viaTunnel = await client.callTool({ name: TOOL, arguments: request });
    expect(resultOf(viaTunnel)).toMatchObject({ ok: true, outcome: "preview", ...request });
    expect(relay).toContain(`/tunnel-relay/${NODE}`);

    const caller = getAuthenticatedAgentClientByName(NODE);
    expect(await caller.operatorRunTool.mutate({ name: TOOL, arguments: request })).toMatchObject({
      ok: true,
      result: { outcome: "preview", ...request },
    });
    expect(relay.filter((path) => path === `/tunnel-relay/${NODE}`)).toHaveLength(2);
    expect(direct).toHaveLength(2);
  } finally {
    await client.close();
    await server.close();
    await owner?.stop();
    await central?.stop();
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
