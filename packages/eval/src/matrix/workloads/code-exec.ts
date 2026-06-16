import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RELIABILITY_GUARD = `import os
os.environ["OMP_NUM_THREADS"] = "1"
import builtins
import shutil
import subprocess
import platform as _platform
import resource as _resource
os.kill = None
os.system = None
os.remove = None
os.removedirs = None
os.rmdir = None
os.unlink = None
os.fork = None
os.forkpty = None
os.posix_spawn = None
os.execv = None
os.execve = None
os.execvp = None
shutil.rmtree = None
subprocess.Popen = None
builtins.help = None
builtins.quit = None
builtins.exit = None
def _set_rlimit(_lim, _val):
    try:
        _soft, _hard = _resource.getrlimit(_lim)
        _cap = _val if _hard == _resource.RLIM_INFINITY else min(_val, _hard)
        _resource.setrlimit(_lim, (_cap, _hard))
    except (ValueError, OSError, AttributeError):
        pass
_set_rlimit(_resource.RLIMIT_CPU, 15)
_set_rlimit(_resource.RLIMIT_FSIZE, 16 * 1024 * 1024)
if hasattr(_resource, "RLIMIT_NPROC"):
    _set_rlimit(_resource.RLIMIT_NPROC, 64)
if _platform.uname().system != "Darwin":
    _set_rlimit(_resource.RLIMIT_AS, 2 * 1024 * 1024 * 1024)
    _set_rlimit(_resource.RLIMIT_STACK, 64 * 1024 * 1024)
import socket as _socket
_socket.socket = None
`;

function stderrTail(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(-2000);
}

export async function runCandidate(
  program: string,
  opts?: { timeoutMs?: number },
): Promise<{ passed: boolean; status: "pass" | "fail" | "timeout" | "error"; detail?: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), "llamactl-humaneval-"));
  try {
    const file = join(tmpDir, "candidate.py");
    writeFileSync(file, program, "utf8");
    // setsid process-group kill is deferred; Bun.spawn cannot set process groups cross-platform, so os.fork=None plus RLIMIT_NPROC is the mitigation.
    const proc = Bun.spawn(["python3", "-I", file], {
      cwd: tmpDir,
      stdout: "pipe",
      stderr: "pipe",
      timeout: opts?.timeoutMs ?? 10000,
      killSignal: "SIGKILL",
    });
    const [exitCode, , stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    if (exitCode === 0) {
      return { passed: true, status: "pass" };
    }
    if (proc.signalCode === "SIGKILL") {
      return { passed: false, status: "timeout", detail: stderrTail(stderr) };
    }
    if (proc.signalCode !== null) {
      return { passed: false, status: "fail", detail: stderrTail(stderr) };
    }
    return { passed: false, status: "fail", detail: stderrTail(stderr) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { passed: false, status: "error", detail };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
