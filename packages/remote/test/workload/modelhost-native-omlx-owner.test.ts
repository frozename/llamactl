import { inferenceContracts, inferenceRpc } from "@llamactl/core";
import { readModelHostStarting, readModelHostState } from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

import type { RunningAgent } from "../../src/server/serve.js";

import { envForTemp, makeTempRuntime } from "../../../core/test/helpers.js";
import { currentWorkerRpcHost } from "../../src/inference/procedures.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "../../src/safe-fs.js";
import { hashToken } from "../../src/server/auth.js";
import { startModelHost } from "../../src/server/modelhost.js";
import { startManagedAgentServer } from "../../src/server/start-managed-agent.js";
import { ModelHostManifestSchema } from "../../src/workload/modelhost-schema.js";
import { deleteModelHost, saveModelHost } from "../../src/workload/modelhost-store.js";

const workload = "native-omlx-fixture";
const model = "fixture-model";

function makeEngine(root: string, changeArtifact: boolean): string {
  const interpreter = join(root, "venv", "bin", "python3");
  execFileSync("python3", ["-m", "venv", "--without-pip", join(root, "venv")], { timeout: 15000 });
  const lib = execFileSync(
    interpreter,
    ["-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
    {
      encoding: "utf8",
      timeout: 5000,
    },
  ).trim();
  const module = join(lib, "omlx", "cli.py");
  mkdirSync(dirname(module), { recursive: true });
  writeFileSync(join(dirname(module), "__init__.py"), "");
  writeFileSync(
    module,
    String.raw`
import argparse
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import TCPServer

class LoopbackServer(ThreadingHTTPServer):
    def server_bind(self):
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    def service_actions(self):
        if Path(self.base, "release-listener").exists():
            self.server_close()
            Path(self.base, "listener-released").touch()
            threading.Event().wait()

class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, value):
        payload = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def owner_request(self):
        return self.headers.get("Authorization") == "Bearer " + self.server.key

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200 if self.server.loaded else 503, {})
        elif not self.owner_request():
            self.send_json(401, {})
        elif self.path == "/api/status":
            self.send_json(200, {"version": "0.8.4", "active_requests": 0, "waiting_requests": 0})
        elif self.path == "/v1/models":
            self.send_json(200, {"data": [{"id": "fixture-model"}]})
        elif self.path == "/v1/models/status":
            if self.server.change_artifact:
                Path(self.server.model, "weights.safetensors").write_text("modified after launch")
            self.send_json(200, {"models": [{"id": "fixture-model", "model_path": self.server.model,
                "engine_type": "batched", "loaded": self.server.loaded, "is_loading": False}]})
        else:
            self.send_json(404, {})

    def do_POST(self):
        if not self.owner_request():
            self.send_json(401, {})
        elif self.path == "/v1/models/fixture-model/load":
            self.server.loaded = True
            Path(self.server.base, "load-witness").write_text(str(os.getpid()))
            self.send_json(200, {"status": "ok", "model_id": "fixture-model"})
        elif self.path == "/v1/chat/completions" and self.server.loaded:
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            chunk = {"id":"fixture", "model":"fixture-model", "choices":[{"index":0,"delta":{"content":"private-worker-ok"},"finish_reason":"stop"}]}
            payload = ("data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type","text/event-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        elif self.path == "/v1/completions" and self.server.loaded:
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self.send_json(200, {"id": "fixture-private-inference"})
        else:
            self.send_json(503, {})

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command")
    parser.add_argument("--model-dir")
    parser.add_argument("--base-path")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--memory-guard-gb")
    parser.add_argument("--hf-cache", action=argparse.BooleanOptionalAction)
    parser.add_argument("--no-cache", action="store_true")
    parser.add_argument("--paged-ssd-cache-dir")
    args = parser.parse_args()
    with LoopbackServer((args.host, args.port), Handler) as server:
        server.key = os.environ["OMLX_API_KEY"]
        server.loaded = False
        server.base = args.base_path
        server.model = str(Path(args.model_dir, "fixture-model"))
        server.change_artifact = ${changeArtifact ? "True" : "False"}
        Path(server.base, "boot-witness").write_text(str(os.getpid()))
        server.serve_forever(poll_interval=0.05)
`,
  );
  const binary = join(root, "venv", "bin", "omlx");
  writeFileSync(
    binary,
    `#!${interpreter}
import sys
from omlx.cli import main
if __name__ == "__main__":
    sys.exit(main())
`,
    { mode: 0o755 },
  );
  return binary;
}

const version = { major: 1, minor: 0 };

async function verifyNativeWorker(): Promise<void> {
  const claim = {
    serviceId: "fixture-worker",
    operations: [...inferenceRpc.InferenceRpcOperationSchema.options],
    deployments: [`deploy/local/${workload}`],
    models: [],
    tenants: ["fixture"],
    credentialScopeId: "fixture",
  };
  const host = currentWorkerRpcHost();
  const yes = host.catalog(claim);
  if (yes.outcome !== "catalog") throw new Error("fixture worker catalog unavailable");
  const deployment = yes.deployments.find(
    ({ deploymentId }) => deploymentId === claim.deployments[0],
  );
  if (!deployment?.deploymentEpoch) throw new Error("protected fixture not advertised");
  const id = "fixture-native-worker";
  const envelope = inferenceContracts.parseInferenceEnvelope({
    requestId: id,
    attemptId: id,
    projectId: "fixture",
    operation: "generate",
    ingressProtocol: "openai-chat",
    publicModelId: model,
    features: {
      operation: "generate",
      protocol: "openai-chat",
      stream: true,
      modalities: ["text"],
      tools: false,
      structuredOutput: false,
      session: false,
      cancellation: true,
    },
    stream: true,
    headerFingerprint: { allowlist: ["content-type"], fingerprint: "fixture" },
    deadline: Date.now() + 5000,
    credentialScopeId: "fixture",
    tenantId: "fixture",
    nativeBody: { model, stream: true, messages: [], max_tokens: 1 },
  });
  expect(
    host.submit(claim, {
      version,
      envelope,
      cancelId: id,
      target: {
        deploymentId: deployment.deploymentId,
        expectedDeploymentEpoch: deployment.deploymentEpoch,
        workerIncarnation: yes.workerIncarnation,
        catalogGeneration: yes.catalogGeneration,
      },
    }),
  ).toMatchObject({ outcome: "accepted" });
  const events = [];
  for await (const event of host.stream(claim, { attemptId: id }, AbortSignal.timeout(5000)))
    events.push(event);
  expect(JSON.stringify(events)).toContain("private-worker-ok");
  expect(events.findLast((event) => event.frame === "event")).toMatchObject({
    frame: "event",
    event: { terminal: { outcome: "completed" } },
  });
}

function availableFixtureGiB(afterLoad: boolean, loadWitness: string): number {
  return afterLoad && existsSync(loadWitness) ? 16 : 48;
}

function stopFixtureEngine(bootWitness: string | undefined): void {
  const state = readModelHostState({ name: workload }, resolveEnv());
  const pid =
    state?.pid ??
    (bootWitness !== undefined && existsSync(bootWitness)
      ? Number(readFileSync(bootWitness, "utf8"))
      : 0);
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The launch refusal normally already reaped the fixture.
  }
}

test.each([
  {
    name: "publishes only after authenticated load and rejects a replacement listener",
    changeArtifact: false,
    restart: false,
    lowHeadroomAfterLoad: false,
  },
  {
    name: "refuses a private default target after restart without the desired manifest",
    changeArtifact: false,
    restart: true,
    lowHeadroomAfterLoad: false,
  },
  {
    name: "refuses to load an artifact changed after the first owner probes",
    changeArtifact: true,
    restart: false,
    lowHeadroomAfterLoad: false,
  },
  {
    name: "commits a verified load when available capacity falls after dispatch",
    changeArtifact: false,
    restart: false,
    lowHeadroomAfterLoad: true,
  },
])(
  "managed native ModelHost $name",
  async ({ changeArtifact, restart, lowHeadroomAfterLoad }) => {
    const temp = makeTempRuntime();
    const desiredDir = join(temp.devStorage, "desired");
    const managedBase = join(temp.runtimeDir, "workloads", workload, ".omlx", "managed-cache");
    const loadWitness = join(managedBase, "load-witness");
    const fixtureEnv = {
      ...envForTemp(temp),
      LLAMACTL_MODELS_DIR: temp.modelsDir,
      LLAMACTL_RUNTIME_DIR: temp.runtimeDir,
      LLAMACTL_WORKLOADS_DIR: desiredDir,
      LLAMACTL_RESIDENCY_STORE: join(temp.devStorage, "operations.sqlite"),
      LLAMACTL_UNIFIED_PROXY: "0",
      LLAMA_CPP_HOST: "127.0.0.1",
      LLAMA_CPP_PORT: "0",
    };
    const previous = Object.keys(fixtureEnv).map((key) => [key, process.env[key]] as const);
    Object.assign(process.env, fixtureEnv);
    const token = "fixture-agent-bearer";
    let running: RunningAgent | undefined;
    let bootWitness: string | undefined;
    try {
      const binary = makeEngine(temp.devStorage, changeArtifact);
      const directory = join(temp.modelsDir, model);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "weights.safetensors"), "fake weights");
      const reservation = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(),
      });
      const port = Number(reservation.url.port);
      process.env["LLAMA_CPP_PORT"] = String(port);
      await reservation.stop();
      const manifest = ModelHostManifestSchema.parse({
        apiVersion: "llamactl/v1",
        kind: "ModelHost",
        metadata: { name: workload },
        spec: {
          engine: "omlx",
          node: "local",
          binary,
          endpoint: { host: "127.0.0.1", port },
          hostedModels: [{ rel: model, omlx: { max_context_window: 8192, mtp_enabled: true } }],
          resources: { expectedMemoryGiB: 8 },
          omlxCacheEpoch: 0,
          omlxNativeResidency: "v0.8.4",
          readiness: { path: "/api/status", expectJson: { version: "0.8.4" } },
          timeoutSeconds: 8,
        },
      });
      saveModelHost(manifest, desiredDir);
      const startAgent = (): Promise<RunningAgent> =>
        startManagedAgentServer(
          {
            bindHost: "127.0.0.1",
            port: 0,
            tokenHash: hashToken(token),
            advertiseMdns: false,
            workerRpc: {
              workerId: "local",
              settings: (): { versions: (typeof version)[]; serviceCredentials: [] } => ({
                versions: [version],
                serviceCredentials: [],
              }),
            },
            executionAdmission: [
              {
                name: "fixture-group",
                foregroundPorts: [port],
                backgroundPorts: [port - 1],
                maxCompletionTokens: 8,
                maxQueued: 4,
                maxQueuedBytes: 4096,
                maxQueueWaitMs: 1000,
                starvationBoundMs: 1000,
                maxPerPrincipal: 2,
                foregroundConcurrency: 1,
              },
            ],
          },
          "local",
          {
            readCapacity: () => ({
              source: "linux-procfs",
              observedAtMs: Date.now(),
              physicalBytes: 64 * 1024 ** 3,
              availableBytes: availableFixtureGiB(lowHeadroomAfterLoad, loadWitness) * 1024 ** 3,
              scope: { kind: "host-physical" },
              pressure: "normal",
              swapUsedBytes: 0,
            }),
            onCapacityAudit: () => undefined,
          },
        );
      running = await startAgent();
      const call = new URL(`${running.url}/trpc/modelHostStart`);
      call.searchParams.set("input", JSON.stringify({ workload, manifest }));
      const headers = { authorization: `Bearer ${token}` };
      const response = await fetch(call, { headers, signal: AbortSignal.timeout(12000) });
      const results = (await response.text()).split("\n").flatMap((line) => {
        if (!line.startsWith("data: {")) return [];
        const event = JSON.parse(line.slice(6)) as { type?: string; result?: unknown };
        return event.type === "done" ? [event.result] : [];
      });
      const state = readModelHostState({ name: workload }, resolveEnv());
      bootWitness = join(managedBase, "boot-witness");
      if (changeArtifact) {
        expect(readFileSync(join(directory, "weights.safetensors"), "utf8")).toBe(
          "modified after launch",
        );
        expect(existsSync(loadWitness)).toBe(false);
        expect(state).toBeNull();
        expect(results).toEqual([expect.objectContaining({ ok: false })]);
        const bootPid = Number(readFileSync(bootWitness, "utf8"));
        expect(Number.isSafeInteger(bootPid) && bootPid > 1).toBe(true);
        expect(() => process.kill(bootPid, 0)).toThrow();
        expect(readModelHostStarting({ name: workload }, resolveEnv())).toBeNull();

        return;
      }
      expect(results).toEqual([expect.objectContaining({ ok: true })]);
      if (!state) throw new Error("private fixture route was not recorded");
      expect(existsSync(loadWitness)).toBe(true);
      expect(readFileSync(loadWitness, "utf8")).toBe(String(state.pid));
      expect((await fetch(`http://127.0.0.1:${String(port)}/v1/models`)).status).toBe(401);
      const admitted = await fetch(`${running.url}/v1/completions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: "fixture", max_tokens: 1 }),
      });
      expect({
        status: admitted.status,
        detail: admitted.ok ? undefined : await admitted.text(),
      }).toEqual({ status: 200, detail: undefined });
      expect(await admitted.json()).toEqual({ id: "fixture-private-inference" });
      const beforeRestart = await fetch(`${running.url}/v1/models`, { headers });
      expect(await beforeRestart.json()).toMatchObject({
        data: [expect.objectContaining({ id: model })],
      });

      await verifyNativeWorker();
      expect(readFileSync(join(managedBase, "model_settings.json"), "utf8")).toContain(
        '"mtp_enabled": true',
      );
      const settingsPath = join(managedBase, "settings.json");
      const settings = readFileSync(settingsPath, "utf8");
      writeFileSync(
        settingsPath,
        settings.replace(
          '"allow_unauthenticated_inference":false',
          '"allow_unauthenticated_inference":true',
        ),
      );
      const refused = await fetch(`${running.url}/v1/completions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: "fixture", max_tokens: 1 }),
      });
      expect(refused.status).toBe(503);
      expect(await refused.text()).toContain("serving-readiness-pending");

      writeFileSync(settingsPath, settings);
      writeFileSync(join(managedBase, "release-listener"), "");
      const listenerReleased = join(managedBase, "listener-released");
      for (let i = 0; i < 100 && !existsSync(listenerReleased); i++) await Bun.sleep(10);
      expect(existsSync(listenerReleased)).toBe(true);
      process.kill(state.pid, 0);
      const replacementRequests: boolean[] = [];
      const replacement = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch(request) {
          replacementRequests.push(request.headers.has("authorization"));
          return Response.json({ id: "unexpected-model", version: "0.8.4" });
        },
      });
      try {
        if (!restart) {
          const exchanged = await fetch(`${running.url}/v1/completions`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ model, prompt: "fixture", max_tokens: 1 }),
            signal: AbortSignal.timeout(4000),
          });
          await exchanged.text();
          expect(replacementRequests).toEqual([]);
          expect(exchanged.ok).toBe(false);

          return;
        }
        await running.stop();
        running = undefined;
        expect(deleteModelHost(workload, desiredDir)).toBe(true);
        running = await startAgent();
        const list = await fetch(`${running.url}/v1/models`, { headers });
        expect(list.ok).toBe(true);
        expect(await list.json()).toMatchObject({ data: [] });
        const afterRestart = await fetch(`${running.url}/v1/completions`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ model, prompt: "fixture", max_tokens: 1 }),
          signal: AbortSignal.timeout(4000),
        });
        await afterRestart.text();
        expect(replacementRequests).toEqual([]);
        expect(afterRestart.ok).toBe(false);

        const implicitAfterRestart = await fetch(`${running.url}/v1/completions`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ prompt: "fixture", max_tokens: 1 }),
          signal: AbortSignal.timeout(4000),
        });
        expect(await implicitAfterRestart.json()).toMatchObject({
          error: { code: "managed_engine_transport_unverified" },
        });
        expect(replacementRequests).toEqual([]);
        expect(implicitAfterRestart.ok).toBe(false);
      } finally {
        await replacement.stop(true);
      }
    } finally {
      stopFixtureEngine(bootWitness);
      await running?.stop();
      for (const [key, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
      temp.cleanup();
    }
  },
  20000,
);

test("native oMLX cannot change desired state outside an admitted owner launch", async () => {
  const temp = makeTempRuntime();
  try {
    const desiredDir = join(temp.devStorage, "desired");
    const result = await startModelHost({
      key: { name: workload },
      env: envForTemp(temp),
      runtimeDir: temp.runtimeDir,
      workloadsDir: desiredDir,
      manifest: ModelHostManifestSchema.parse({
        apiVersion: "llamactl/v1",
        kind: "ModelHost",
        metadata: { name: workload },
        spec: {
          engine: "omlx",
          node: "local",
          binary: "/usr/bin/false",
          endpoint: { host: "127.0.0.1", port: 65234 },
          hostedModels: [{ rel: model }],
          omlxCacheEpoch: 0,
          omlxNativeResidency: "v0.8.4",
        },
      }),
    });
    expect({ result, persisted: existsSync(desiredDir) }).toEqual({
      result: { ok: false, pid: null, error: "ManagedNativeOmlxOwnerUnavailable" },
      persisted: false,
    });
  } finally {
    temp.cleanup();
  }
});
