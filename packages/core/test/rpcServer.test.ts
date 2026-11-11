import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveEnv } from "../src/env.js";
import { processStartMs } from "../src/pidIdentity.js";
import { rpcServerStatus, startRpcServer, stopRpcServer } from "../src/rpcServer.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { reapFakeProcesses } from "./fake-process-reaper.js";

let tmp = "";
let resolved: ReturnType<typeof resolveEnv>;
let resolvedReady = false;
const origEnv = { ...process.env };
const FILE_LOADED_MS = Date.now();

// Fake rpc-server: a bash-wrapped Bun one-liner that binds a TCP
// port and accepts connections until SIGTERM. Matches what the real
// rpc-server does from a probing perspective.
const FAKE_RPC_SCRIPT = `#!/bin/bash
HOST=0.0.0.0
PORT=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
export FAKE_HOST="$HOST"
export FAKE_PORT="$PORT"
exec -a rpc-server bun -e "const s=Bun.listen({hostname:process.env.FAKE_HOST,port:Number(process.env.FAKE_PORT),socket:{data(){},open(){},close(){},error(){}}});process.on('SIGTERM',()=>{s.stop();process.exit(0);});process.on('SIGINT',()=>{s.stop();process.exit(0);});await new Promise(()=>{});"
`;

// Every pid startRpcServer hands back. The fake's argv carries no tmp
// path, so a test that deletes the pidfile would otherwise hide a live
// fake from the reaper; afterEach passes these as explicit pids.
const startedPids = new Set<number>();

async function startTracked(
  opts: Parameters<typeof startRpcServer>[0],
): ReturnType<typeof startRpcServer> {
  const result = await startRpcServer(opts);
  if (result.pid !== null) startedPids.add(result.pid);
  return result;
}

function isLiveFakeRpcServer(pid: number): boolean {
  const res = spawnSync("ps", ["-ww", "-o", "stat=,command=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const line = res.stdout.trim();
  if (res.status !== 0 || line === "" || line.startsWith("Z")) return false;
  const argv0 = line.split(/\s+/)[1] ?? "";
  if (argv0.slice(argv0.lastIndexOf("/") + 1) !== "rpc-server") return false;
  // Identity guard before the SIGKILL fallback: only this file's fake (its
  // inline script reads FAKE_PORT) started after the file loaded, so a
  // reused pid now held by a real rpc-server is never signalled.
  const startedMs = processStartMs(pid);
  return line.includes("FAKE_PORT") && startedMs !== null && startedMs >= FILE_LOADED_MS - 1000;
}

function pickPort(): number {
  return 19050 + Math.floor(Math.random() * 99);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-rpc-"));
  const devStorage = join(tmp, "ds");
  const binDir = join(devStorage, "bin");
  const runtimeDir = join(devStorage, "ai-models", "local-ai");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(join(devStorage, "logs", "llama.cpp"), { recursive: true });
  writeFileSync(join(binDir, "rpc-server"), FAKE_RPC_SCRIPT, { mode: 0o755 });
  process.env["DEV_STORAGE"] = devStorage;
  process.env["LLAMA_CPP_BIN"] = binDir;
  process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
  process.env["LLAMA_CPP_LOGS"] = join(devStorage, "logs", "llama.cpp");
  resolved = resolveEnv();
  resolvedReady = true;
});

afterEach(async () => {
  // The fake's argv carries no tmp path, so the reaper finds it by the
  // pidfile and by the pids startRpcServer returned. The flag keeps the
  // pidfile read out of reach of an unassigned `resolved` when beforeEach
  // threw early. tmp stays empty when beforeEach threw before mkdtempSync.
  const pidFiles = resolvedReady ? [join(resolved.LOCAL_AI_RUNTIME_DIR, "rpc-server.pid")] : [];
  process.env = { ...origEnv };
  if (tmp === "") return;
  const pids = [...startedPids];
  startedPids.clear();
  const survivors = await reapFakeProcesses({ scratch: tmp, pidFiles, pids });
  // A fake the reaper never found still holds its rpc-server argv0: kill
  // it here so the failure below cannot leak it past the run.
  const leaked = pids.filter(isLiveFakeRpcServer);
  for (const pid of leaked) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  tmp = "";
  expect(survivors).toEqual([]);
  expect(leaked).toEqual([]);
});

describe("rpcServer", () => {
  test("starts, reports status=up with host+port, stops cleanly", async () => {
    const port = pickPort();
    const result = await startTracked({ host: "127.0.0.1", port, timeoutSeconds: 5 });
    expect(result.ok).toBe(true);
    expect(result.endpoint).toBe(`127.0.0.1:${String(port)}`);
    expect(result.pid).not.toBeNull();

    const status = await rpcServerStatus(resolved);
    expect(status.state).toBe("up");
    expect(status.host).toBe("127.0.0.1");
    expect(status.port).toBe(port);
    expect(status.endpoint).toBe(`127.0.0.1:${String(port)}`);
    expect(status.pid).toBe(result.pid);

    const stopped = await stopRpcServer({ resolved });
    expect(stopped.stopped).toBe(true);
    expect(stopped.pid).toBe(result.pid);

    const after = await rpcServerStatus(resolved);
    expect(after.state).toBe("down");
    expect(after.pid).toBeNull();
  });

  test("missing binary returns an ok=false StartResult", async () => {
    rmSync(join(resolved.LLAMA_CPP_BIN, "rpc-server"));
    const result = await startTracked({ host: "127.0.0.1", port: pickPort() });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("rpc-server binary not found");
  });

  test("stopRpcServer on down state is a no-op that returns stopped=true", async () => {
    const r = await stopRpcServer({ resolved });
    expect(r.stopped).toBe(true);
    expect(r.pid).toBeNull();
  });

  test("emits launch → waiting*? → ready events", async () => {
    const events: { type: string }[] = [];
    const port = pickPort();
    const result = await startTracked({
      host: "127.0.0.1",
      port,
      timeoutSeconds: 5,
      onEvent: (e) => events.push(e),
    });
    expect(result.ok).toBe(true);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("launch");
    expect(types[types.length - 1]).toBe("ready");
    await stopRpcServer({ resolved });
  });

  test("stopRpcServer never signals a fresh-record pid that is not rpc-server", async () => {
    // A record younger than the process defeats the start-time check — only
    // command-line corroboration can catch the impostor holding a pid that
    // was recycled in place before we recorded it.
    const impostor = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const pidPath = join(resolved.LOCAL_AI_RUNTIME_DIR, "rpc-server.pid");
      writeFileSync(pidPath, `${String(impostor.pid)}\n`);
      const res = await stopRpcServer({ resolved, graceSeconds: 1 });
      expect(res.stopped).toBe(false);
      expect(res.killed).toBe(false);
      try {
        process.kill(impostor.pid, 0);
      } catch {
        throw new Error("impostor was signalled");
      }
      expect(existsSync(pidPath)).toBe(true);
    } finally {
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  test("reaps stale tracking when the process dies before becoming ready (timeout path)", async () => {
    // A binary that exits immediately without ever binding the port: the TCP
    // probe never succeeds, so startRpcServer times out — and because the pid
    // is already dead, the stale pid+state files must be reaped rather than
    // left pointing at a defunct process.
    const binDir = resolved.LLAMA_CPP_BIN;
    writeFileSync(join(binDir, "rpc-server"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    const pidFile = join(resolved.LOCAL_AI_RUNTIME_DIR, "rpc-server.pid");
    const stateFile = join(resolved.LOCAL_AI_RUNTIME_DIR, "rpc-server.state");

    const port = pickPort();
    const result = await startTracked({ host: "127.0.0.1", port, timeoutSeconds: 1 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("timeout");
    // The dead pid's tracking files are gone, not orphaned.
    expect(existsSync(pidFile)).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
  });
});
