import { spawn } from "node:child_process";

import { existsSync } from "./safe-fs.js";

export interface ProbeHealthOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface ProbeHealthResult {
  reachable: boolean;
}

/**
 * Lightweight liveness probe for a locally-known endpoint. Hits /health,
 * which both llamactl-agent (since the /healthz alias landed) and raw
 * llama-server expose.
 *
 * Accepts loopback aliases (0.0.0.0, ::1, localhost, 127.0.0.1) and normalizes
 * them so the probe always hits a routable URL: 0.0.0.0 -> 127.0.0.1, IPv6
 * literals get bracket-wrapped.
 */
export async function probeHealthEndpoint(
  host: string,
  port: number,
  opts: ProbeHealthOptions = {},
): Promise<ProbeHealthResult> {
  const { fetch: fetchFn = globalThis.fetch, timeoutMs = 1000 } = opts;
  const endpoint = formatEndpoint(host, port);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetchFn(`${endpoint}/health`, { signal: controller.signal });
    return { reachable: res.ok };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

export function formatEndpoint(host: string, port: number): string {
  const normalized = host === "0.0.0.0" ? "127.0.0.1" : host;
  const isIPv6 = normalized.includes(":") && !normalized.startsWith("[");
  const hostPart = isIPv6 ? `[${normalized}]` : normalized;
  return `http://${hostPart}:${String(port)}`;
}

// Hard cap on the listener-pid lookup: lsof can wedge (stuck mount, fd
// contention) and callers run it on status/list hot paths, so a bounded
// null beats an unbounded hang.
const FIND_LISTENER_TIMEOUT_MS = 2000;

// Resolve lsof by absolute path: macOS ships it in /usr/sbin, which is NOT
// on the launchd PATH — a bare `lsof` would ENOENT there and silently
// disable listener detection in production.
function resolveLsofPath(): string {
  for (const candidate of ["/usr/sbin/lsof", "/usr/bin/lsof"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "lsof";
}

function lsofListenerPid(filter: string): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | null = null;
    const finish = (value: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill("SIGKILL");
      } catch {
        // Process may have already exited between lsof and timeout cleanup.
      }
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(null);
    }, FIND_LISTENER_TIMEOUT_MS);
    try {
      child = spawn(resolveLsofPath(), ["-nP", filter, "-sTCP:LISTEN", "-t"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      child.stdout?.on("data", (chunk) => {
        out += String(chunk);
      });
      child.on("error", () => {
        finish(null);
      });
      child.on("close", () => {
        const pid = out
          .split(/\s+/)
          .map((token) => Number.parseInt(token, 10))
          .find((value) => Number.isInteger(value) && value > 0);
        finish(pid ?? null);
      });
    } catch {
      finish(null);
    }
  });
}

/**
 * Resolve the pid of the process holding `host:port` in LISTEN state, or
 * null when nothing listens there / lsof is unavailable / the lookup timed
 * out. Prefers the exact bind address so an unrelated process on a
 * different address of the same port isn't mis-matched; falls back to any
 * address on the port because a `--host 0.0.0.0` listener is invisible to
 * the loopback-scoped filter even though clients reach it via 127.0.0.1.
 */
export async function findTcpListenerPid(host: string, port: number): Promise<number | null> {
  const exact = await lsofListenerPid(`-iTCP@${host}:${String(port)}`);
  if (exact !== null) return exact;
  return await lsofListenerPid(`-iTCP:${String(port)}`);
}

export interface EndpointOwnership {
  /** True when something answered `GET /health` on the endpoint. */
  reachable: boolean;
  /** pid of the LISTEN socket holder when `reachable`, else null. */
  listenerPid: number | null;
}

/**
 * Probe an endpoint and, when something answers, resolve which pid holds
 * the port. Callers compare `listenerPid` against the pid they recorded to
 * tell "we own this listener" apart from "a foreign process is squatting
 * the port" without shelling out to lsof by hand.
 */
export async function probeEndpointOwnership(
  host: string,
  port: number,
  opts: ProbeHealthOptions = {},
): Promise<EndpointOwnership> {
  const probe = await probeHealthEndpoint(host, port, opts);
  if (!probe.reachable) return { reachable: false, listenerPid: null };
  const listenerPid = await findTcpListenerPid(host, port).catch(() => null);
  return { reachable: true, listenerPid };
}
