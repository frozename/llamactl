// Read-only probes `llamactl update` runs over HTTP or short-lived processes:
// the agent's /healthz, the managed model endpoints, their idle state, and the
// target commit's CI result. They carry no credentials.
import { defaultAgentDir } from "@llamactl/core/config/agent-config";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { ExecFn, HttpGetFn, HttpResponse, ManagedHost } from "./deps.js";

export interface AgentEndpoint {
  /** `https://host:port`, no trailing slash. */
  url: string;
  source: string;
}

const WILDCARD_HOSTS = new Set(["", "0.0.0.0", "::", "[::]"]);

function argValue(argv: readonly string[], names: readonly string[]): string | null {
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    if (eq > 0 && names.includes(arg.slice(0, eq))) return arg.slice(eq + 1);
  }
  return null;
}

export function urlHost(host: string): string {
  const h = WILDCARD_HOSTS.has(host) ? "127.0.0.1" : host;
  return h.includes(":") && !h.startsWith("[") ? `[${h}]` : h;
}

function readAgentYaml(
  path: string,
  readFile: (p: string) => string | null,
): { bindHost?: unknown; port?: unknown } {
  const text = readFile(path);
  if (text === null) return {};
  try {
    const parsed = parseYaml(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The local agent's base URL: an explicit override, else the agent unit's
 * `--bind`/`--port` flags over its `agent.yaml` (in the unit's `--dir`, else
 * the default agent dir for the unit's environment). A wildcard bind is probed
 * on 127.0.0.1.
 */
export function resolveAgentEndpoint(o: {
  override: string | null;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  readFile: (path: string) => string | null;
}): AgentEndpoint {
  if (o.override !== null) {
    return { url: o.override.replace(/\/+$/, ""), source: "LLAMACTL_UPDATE_AGENT_URL" };
  }
  const dir = argValue(o.argv, ["--dir"]) ?? defaultAgentDir(o.env);
  const cfgPath = join(dir, "agent.yaml");
  const cfg = readAgentYaml(cfgPath, o.readFile);
  const bind =
    argValue(o.argv, ["--bind", "--host"]) ??
    (typeof cfg.bindHost === "string" ? cfg.bindHost : "127.0.0.1");
  const portArg = argValue(o.argv, ["--port"]);
  const port =
    portArg !== null
      ? Number.parseInt(portArg, 10)
      : typeof cfg.port === "number"
        ? cfg.port
        : 7843;
  return { url: `https://${urlHost(bind)}:${String(port)}`, source: cfgPath };
}

// The agent serves a self-signed certificate. Only unauthenticated routes are
// probed, so skipping verification exposes nothing.
const AGENT_PROBE = { timeoutMs: 3000, insecureTls: true } as const;

export async function agentHealthy(httpGet: HttpGetFn, ep: AgentEndpoint): Promise<boolean> {
  const r = await httpGet(`${ep.url}/healthz`, AGENT_PROBE);
  return r?.status === 200 && r.body.trim() === "ok";
}

const NEGOTIATE_INPUT = encodeURIComponent(JSON.stringify({ versions: [{ major: 1, minor: 0 }] }));

/** The worker-RPC negotiate outcome (`not-advertised` on a default agent), or null. */
export async function negotiateOutcome(
  httpGet: HttpGetFn,
  ep: AgentEndpoint,
): Promise<string | null> {
  const r = await httpGet(
    `${ep.url}/trpc/inferenceRpc.negotiate?input=${NEGOTIATE_INPUT}`,
    AGENT_PROBE,
  );
  return r === null ? null : (/"outcome":"([a-z-]+)"/.exec(r.body)?.[1] ?? null);
}

export function hostBaseUrl(host: ManagedHost): string {
  return `http://${urlHost(host.host)}:${String(host.port)}`;
}

/** Ready = `/v1/models` lists at least one model, the readiness test the engines use. */
export async function hostReady(httpGet: HttpGetFn, host: ManagedHost): Promise<boolean> {
  const r = await httpGet(`${hostBaseUrl(host)}/v1/models`, { timeoutMs: 3000 });
  if (r?.status !== 200) return false;
  try {
    const body = JSON.parse(r.body) as { data?: unknown };
    return Array.isArray(body.data) && body.data.length > 0;
  } catch {
    return false;
  }
}

export type IdleState = "busy" | "idle" | "unknown";

function idleFromSlots(slots: HttpResponse | null): IdleState {
  if (slots?.status !== 200) return "unknown";
  try {
    const parsed = JSON.parse(slots.body) as unknown;
    // An empty list says nothing (Strata answers [] when its engine is down).
    if (!Array.isArray(parsed) || parsed.length === 0) return "unknown";
    const busy = parsed.some(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        (s as { is_processing?: unknown }).is_processing === true,
    );
    return busy ? "busy" : "idle";
  } catch {
    return "unknown";
  }
}

function idleFromJsonMetrics(metrics: HttpResponse | null): IdleState {
  if (metrics?.status !== 200) return "unknown";
  try {
    const parsed = JSON.parse(metrics.body) as { live?: { state?: unknown; queued?: unknown } };
    const state = parsed.live?.state;
    if (typeof state !== "string") return "unknown";
    const queued = parsed.live?.queued;
    const queueEmpty = queued === undefined || queued === null || queued === 0 || queued === false;
    return state === "idle" && queueEmpty ? "idle" : "busy";
  } catch {
    return "unknown";
  }
}

function idleFromPrometheus(metrics: HttpResponse | null): IdleState {
  if (metrics?.status !== 200) return "unknown";
  const values = [
    ...metrics.body.matchAll(/^llamacpp:requests_(?:processing|deferred)\s+(\d+(?:\.\d+)?)/gm),
  ].map((m) => Number(m[1]));
  if (values.length === 0) return "unknown";
  return values.every((v) => v === 0) ? "idle" : "busy";
}

/**
 * Best-effort idle test across engines, most informative source first: a JSON
 * `/metrics` with `live.state` and `queued` (Strata, which also counts queued
 * requests), llama-server's `/slots`, then llama-server's Prometheus `/metrics`
 * request gauges. Anything else is `unknown`.
 */
export function classifyIdle(metrics: HttpResponse | null, slots: HttpResponse | null): IdleState {
  for (const state of [
    idleFromJsonMetrics(metrics),
    idleFromSlots(slots),
    idleFromPrometheus(metrics),
  ]) {
    if (state !== "unknown") return state;
  }
  return "unknown";
}

export async function hostIdle(httpGet: HttpGetFn, host: ManagedHost): Promise<IdleState> {
  const base = hostBaseUrl(host);
  const metrics = await httpGet(`${base}/metrics`, { timeoutMs: 3000 });
  const fromJson = idleFromJsonMetrics(metrics);
  if (fromJson !== "unknown") return fromJson;
  return classifyIdle(metrics, await httpGet(`${base}/slots`, { timeoutMs: 3000 }));
}

/** `gh run list --json status,conclusion` → success | failure | … | pending | none. */
export function parseCiState(stdout: string): string {
  try {
    const runs = JSON.parse(stdout) as unknown;
    if (!Array.isArray(runs)) return "unknown";
    const run = runs[0] as { status?: unknown; conclusion?: unknown } | undefined;
    if (run === undefined) return "none";
    if (run.status !== "completed") return "pending";
    return typeof run.conclusion === "string" && run.conclusion !== "" ? run.conclusion : "unknown";
  } catch {
    return "unknown";
  }
}

export const CI_WORKFLOW = "check";

/** CI state of the `check` workflow for `sha`; `unknown` without gh or a GitHub remote. */
export async function ciState(
  exec: ExecFn,
  which: (bin: string) => string | null,
  ghRepo: string | null,
  sha: string,
): Promise<string> {
  if (ghRepo === null || which("gh") === null) return "unknown";
  const r = await exec([
    "gh",
    "run",
    "list",
    "--repo",
    ghRepo,
    "--commit",
    sha,
    "--workflow",
    CI_WORKFLOW,
    "--limit",
    "1",
    "--json",
    "status,conclusion",
  ]);
  return r.code === 0 ? parseCiState(r.stdout) : "unknown";
}
