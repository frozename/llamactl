import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { router } from "../src/router.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { loadWorkloadByName, parseWorkload, saveWorkload } from "../src/workload/store.js";

/**
 * Regression for #1: a workload the store still records as Running, whose
 * llama-server died out-of-band, must be restarted by the next reconcile
 * pass. The workload listens on its own endpoint while another server
 * answers the env-default port — the multi-workload layout where a dead
 * workload's status probe falls back to the default endpoint and finds
 * something else alive there.
 */

const FAKE_LLAMA_SERVER = [
  "#!/bin/bash",
  "HOST=127.0.0.1",
  "PORT=8080",
  'while [ "$#" -gt 0 ]; do',
  '  case "$1" in',
  '    --host) HOST="$2"; shift 2 ;;',
  '    --port) PORT="$2"; shift 2 ;;',
  '    -m) MODEL="$2"; shift 2 ;;',
  "    *) shift ;;",
  "  esac",
  "done",
  "export FAKE_HOST=$HOST FAKE_PORT=$PORT",
  'exec -a llama-server bun -e "',
  "  const s = Bun.serve({",
  "    port: Number(process.env.FAKE_PORT),",
  "    hostname: process.env.FAKE_HOST,",
  "    fetch() { return new Response('ok', { status: 200 }); },",
  "  });",
  "  const stop = () => { s.stop(true); process.exit(0); };",
  "  process.on('SIGTERM', stop);",
  "  process.on('SIGINT', stop);",
  "  await new Promise(() => undefined);",
  '" "$MODEL"',
  "",
].join("\n");

const NAME = "granite-long-lived-local";
const REL = "fake-repo/fake-model.gguf";

let tmp = "";
let decoy: ReturnType<typeof Bun.serve> | null = null;
const spawnedPids = new Set<number>();
const originalEnv = { ...process.env };

function pickPort(base: number): number {
  return base + Math.floor(Math.random() * 500);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(25);
  }
}

async function health(port: number): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.status;
  } catch {
    return null;
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-dead-pid-"));
  const devStorage = join(tmp, "devstorage");
  const modelsDir = join(devStorage, "ai-models", "llama.cpp", "models");
  const binDir = join(tmp, "bin");
  mkdirSync(join(devStorage, "ai-models", "local-ai"), { recursive: true });
  mkdirSync(join(modelsDir, "fake-repo"), { recursive: true });
  mkdirSync(join(devStorage, "logs", "llama.cpp"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(modelsDir, REL), "GGUF-fake", "utf8");
  writeFileSync(join(binDir, "llama-server"), FAKE_LLAMA_SERVER, { mode: 0o755 });

  const defaultPort = pickPort(18100);
  decoy = Bun.serve({
    port: defaultPort,
    hostname: "127.0.0.1",
    fetch: () => new Response("ok", { status: 200 }),
  });

  Object.assign(process.env, {
    DEV_STORAGE: devStorage,
    LOCAL_AI_RUNTIME_DIR: join(devStorage, "ai-models", "local-ai"),
    LLAMA_CPP_MODELS: modelsDir,
    LLAMA_CPP_BIN: binDir,
    LLAMA_CPP_LOGS: join(devStorage, "logs", "llama.cpp"),
    LLAMA_CPP_HOST: "127.0.0.1",
    LLAMA_CPP_PORT: String(defaultPort),
    LLAMA_CPP_USE_TUNED_ARGS: "false",
    LLAMACTL_WORKLOADS_DIR: join(tmp, "workloads"),
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
  });
});

afterEach(async () => {
  try {
    await router.createCaller({}).serverStop({ workload: NAME, graceSeconds: 1 });
  } catch {
    // best effort; the pid sweep below is the safety net
  }
  for (const pid of spawnedPids) {
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
  }
  spawnedPids.clear();
  await decoy?.stop(true);
  decoy = null;
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  rmSync(tmp, { recursive: true, force: true });
});

test("reconcile restarts a Running workload whose recorded pid died out-of-band", async () => {
  const port = pickPort(18700);
  saveWorkload(
    parseWorkload(`
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: ${NAME}
spec:
  node: local
  restartPolicy: Always
  target:
    kind: rel
    value: ${REL}
  endpoint:
    host: 127.0.0.1
    port: ${String(port)}
`),
  );
  const caller = router.createCaller({});

  // With the decoy answering the default port, serverStatus reports the
  // never-started workload as "up" (foreign), so a fresh start can read as
  // "restarted"; either action is a successful launch.
  const launched = ["started", "restarted"];
  const first = await caller.reconcilerKick();
  expect(first.lastResult?.reports).toHaveLength(1);
  expect(first.lastResult?.reports[0]?.error).toBeUndefined();
  expect(launched).toContain(first.lastResult?.reports[0]?.action ?? "");
  const before = await caller.serverStatus({ workload: NAME });
  expect(before.state).toBe("up");
  const deadPid = before.pid;
  if (deadPid === null) throw new Error("expected a recorded pid after the first pass");
  spawnedPids.add(deadPid);
  expect(loadWorkloadByName(NAME).status?.serverPid).toBe(deadPid);

  process.kill(deadPid, "SIGKILL");
  await waitUntil(() => !isAlive(deadPid), 5000);
  expect(await health(port)).toBeNull();
  // The store still claims Running with the dead pid — the state in #1.
  expect(loadWorkloadByName(NAME).status?.phase).toBe("Running");
  expect(loadWorkloadByName(NAME).status?.serverPid).toBe(deadPid);

  const second = await caller.reconcilerKick();
  const report = second.lastResult?.reports[0];
  expect(report?.error).toBeUndefined();
  expect(launched).toContain(report?.action ?? "");

  const after = await caller.serverStatus({ workload: NAME });
  const newPid = after.pid;
  if (newPid === null) throw new Error("expected a fresh recorded pid after the restart");
  spawnedPids.add(newPid);
  expect(newPid).not.toBe(deadPid);
  expect(isAlive(newPid)).toBe(true);
  expect(await health(port)).toBe(200);
  expect(loadWorkloadByName(NAME).status?.serverPid).toBe(newPid);
  // The server on the default port belongs to someone else and survives.
  expect(await health(decoy!.port!)).toBe(200);
}, 30_000);
