// Read-only agent status report (#211): config, liveness via the
// unauthenticated /healthz, loopback-bind detection, and cert expiry +
// SAN coverage of the host the operator advertises.
import type { AgentConfig } from "@llamactl/core/config/agent-config";

import { findTcpListenerPid } from "@llamactl/core/probe";
import {
  LOCAL_NODE_ID,
  modelHostExternalBindHost,
  type ModelHostManifest,
} from "@llamactl/remote/workload/modelhost-schema";
import { listModelHosts } from "@llamactl/remote/workload/modelhost-store";
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";

import { readFileSync } from "../safe-fs.js";
import { defaultUpdateDeps, type UpdateDeps } from "./update/deps.js";
import { urlHost } from "./update/probes.js";
import {
  DEFAULT_UNITS,
  LAUNCHD_AGENT_FALLBACK,
  makeServiceManager,
  pickServiceManagerKind,
  type ServiceManagerKind,
} from "./update/services.js";

export interface AgentCertStatus {
  sans: string[];
  notAfter: string;
  expired: boolean;
}

export interface AgentStatusReport {
  configPath: string;
  nodeName: string | undefined;
  bind: string;
  certPath: string;
  keyPath: string;
  fingerprint: string;
  running: boolean;
  /** pid holding the agent's TCP listener; null when not running or not resolvable. */
  listenerPid: number | null;
  /** #211: service manager entry for the agent; null when not looked up or unsupported. */
  service: AgentServiceStatus | null;
  probeUrl: string;
  loopbackOnly: boolean;
  cert: AgentCertStatus | { error: string };
  advertisedHost: string | null;
  advertisedHostCovered: boolean | null;
  exposedModelHosts: ExposedModelHost[];
  warnings: string[];
}

export type ProbeFn = (url: string) => Promise<boolean>;

export type ListenerPidFn = (host: string, port: number) => Promise<number | null>;

/** #211: the launchd label or systemd --user unit managing the agent. Exactly these named fields; linger only on systemd. */
export interface AgentServiceStatus {
  manager: ServiceManagerKind;
  /** launchd label or systemd unit. */
  name: string;
  loaded: boolean;
  active: boolean;
  pid: number | null;
  /**
   * systemd only: logind Linger for this uid (a --user agent survives logout
   * only when true); null when unknown. Absent on launchd.
   */
  linger?: boolean | null;
}

export type DescribeServiceFn = () => Promise<AgentServiceStatus | null>;

export type ServiceProbeDeps = Pick<UpdateDeps, "env" | "exec" | "platform" | "readFile" | "uid">;

/** #214: an enabled ModelHost on this node whose engine binds a non-loopback host. */
export interface ExposedModelHost {
  name: string;
  /** host:port, IPv6 bracketed (same shape as `get workloads` exposedBind). */
  bind: string;
  allowExternalBind: boolean;
}

export type ListModelHostsFn = () => ModelHostManifest[];

export function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}

// The agent serves a self-signed certificate and /healthz is
// unauthenticated, so skipping verification exposes nothing.
const defaultProbe: ProbeFn = async (url) => {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(2000),
      tls: { rejectUnauthorized: false },
    });
    return res.status === 200 && (await res.text()).trim() === "ok";
  } catch {
    return false;
  }
};

function sanEntries(x509: X509Certificate): string[] {
  // Bun exposes subjectAltName as "IP Address:127.0.0.1, DNS:localhost".
  const raw = x509.subjectAltName ?? "";
  return raw
    .split(", ")
    .map((entry) => entry.replace(/^(?:DNS|IP Address):/, "").trim())
    .filter(Boolean);
}

// Bun renders IPv6 SANs fully expanded (0:0:0:0:0:0:0:1); compress them.
function normalizeSan(entry: string): string {
  return isIP(entry) === 6 ? new URL(`https://[${entry}]/`).hostname.slice(1, -1) : entry;
}

/** #210: the cert's SAN entries, IPv6 compressed; [] when the cert cannot be read or parsed. */
export function readCertSans(certPath: string): string[] {
  try {
    return sanEntries(new X509Certificate(readFileSync(certPath, "utf8"))).map(normalizeSan);
  } catch {
    return [];
  }
}

function coversHost(x509: X509Certificate, host: string): boolean {
  return isIP(host) === 0 ? x509.checkHost(host) !== undefined : x509.checkIP(host) !== undefined;
}

// Only a live agent has a listener to name; skipping the lookup otherwise
// keeps lsof out of the common "agent is down" path. A separate function so
// collectAgentStatus stays under the cognitive-complexity gate.
async function lookupListenerPid(
  running: boolean,
  host: string,
  port: number,
  find: ListenerPidFn = findTcpListenerPid,
): Promise<number | null> {
  if (!running) return null;
  return await find(host, port).catch(() => null);
}

// #211: whether logind keeps this user's systemd manager, and so a --user
// agent, running after logout. Anything but a clean "yes" or "no" (no logind,
// a non-zero exit, a spawn failure) is unknown. Never throws.
async function readLinger(exec: ServiceProbeDeps["exec"], uid: number): Promise<boolean | null> {
  try {
    const r = await exec(["loginctl", "show-user", String(uid), "--property=Linger", "--value"]);
    if (r.code !== 0) return null;
    const value = r.stdout.trim();
    if (value === "yes") return true;
    if (value === "no") return false;
    return null;
  } catch {
    return null;
  }
}

// #211: which launchd label or systemd --user unit manages the agent, resolved
// the way `llamactl update` does (update/session.ts): the default agent unit,
// and on launchd the `llamactl infra` label when the default is not loaded.
// Copies five fields by name, plus linger on systemd: a ServiceInfo also carries the unit's env and argv.
export async function describeAgentService(
  d: ServiceProbeDeps,
): Promise<AgentServiceStatus | null> {
  const kind = pickServiceManagerKind(null, d.platform);
  if (kind === null) return null;
  const manager = makeServiceManager(kind, d.exec, d.readFile, d.uid, d.env);
  let info = await manager.describe("agent", DEFAULT_UNITS[kind].agent, false);
  if (kind === "launchd" && !info.loaded) {
    const fallback = await manager.describe("agent", LAUNCHD_AGENT_FALLBACK, false);
    if (fallback.loaded) info = fallback;
  }
  const status: AgentServiceStatus = {
    manager: kind,
    name: info.name,
    loaded: info.loaded,
    active: info.active,
    pid: info.pid,
  };
  // Linger is a per-user logind setting, so it is read even when the unit is not loaded.
  if (kind === "systemd") status.linger = await readLinger(d.exec, d.uid);
  return status;
}

const SERVICE_EXEC_TIMEOUT_MS = 2000;

/** The production describer `agent status` uses: read-only launchctl/systemctl calls, each bounded. */
export async function defaultDescribeService(): Promise<AgentServiceStatus | null> {
  const d = defaultUpdateDeps();
  const deps: ServiceProbeDeps = {
    platform: d.platform,
    exec: async (argv) => await d.exec(argv, { timeoutMs: SERVICE_EXEC_TIMEOUT_MS }),
    readFile: d.readFile,
    uid: d.uid,
    env: d.env,
  };
  return await describeAgentService(deps);
}

// No describer means no lookup, so tests and other callers never exec
// launchctl or systemctl. A failing describer degrades to null. The copy keeps
// only the named fields (five, plus linger when present) even if a describer
// hands back more: the unit's env (LLAMACTL_TUNNEL_BEARER on the controller
// host, #289) must never reach --json.
// A separate function so collectAgentStatus stays under the cognitive-complexity gate.
async function lookupService(
  describer: DescribeServiceFn | undefined,
): Promise<AgentServiceStatus | null> {
  if (describer === undefined) return null;
  const s = await describer().catch(() => null);
  if (s === null) return null;
  const out: AgentServiceStatus = {
    manager: s.manager,
    name: s.name,
    loaded: s.loaded,
    active: s.active,
    pid: s.pid,
  };
  if (s.linger !== undefined) out.linger = s.linger;
  return out;
}

function bracketedBind(host: string, port: number): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${h}:${String(port)}`;
}

// #214: enabled ModelHosts on this node (spec.node "local" or the agent's own
// node name) whose engine binds a non-loopback host. A failing read yields []
// so status still reports. A separate function so collectAgentStatus stays
// under the cognitive-complexity gate.
export function collectExposedModelHosts(
  nodeName: string | undefined,
  list: ListModelHostsFn = () => listModelHosts(),
): ExposedModelHost[] {
  let manifests: ModelHostManifest[];
  try {
    manifests = list();
  } catch {
    return [];
  }
  const out: ExposedModelHost[] = [];
  for (const manifest of manifests) {
    const { spec } = manifest;
    if (!spec.enabled) continue;
    if (spec.node !== LOCAL_NODE_ID && spec.node !== nodeName) continue;
    const host = modelHostExternalBindHost(spec);
    if (host === null) continue;
    out.push({
      name: manifest.metadata.name,
      bind: bracketedBind(host, spec.endpoint.port),
      allowExternalBind: spec.allowExternalBind === true,
    });
  }
  return out;
}

function exposedModelHostWarning(h: ExposedModelHost): string {
  const suffix = h.allowExternalBind
    ? " (spec.allowExternalBind: true)"
    : "; spec.allowExternalBind is not true, so its next start is refused";
  return `modelhost/${h.name} binds an unauthenticated engine to ${h.bind}${suffix}`;
}

export async function collectAgentStatus(o: {
  configPath: string;
  cfg: AgentConfig;
  advertisedHost?: string;
  probe?: ProbeFn;
  findListenerPid?: ListenerPidFn;
  describeService?: DescribeServiceFn;
  listModelHosts?: ListModelHostsFn;
}): Promise<AgentStatusReport> {
  const warnings: string[] = [];
  const bind = `${o.cfg.bindHost}:${String(o.cfg.port)}`;
  const loopbackOnly = isLoopbackHost(o.cfg.bindHost);
  const probeHost = urlHost(o.cfg.bindHost);
  const probeUrl = `https://${probeHost}:${String(o.cfg.port)}/healthz`;
  const running = await (o.probe ?? defaultProbe)(probeUrl);
  const listenerPid = await lookupListenerPid(running, probeHost, o.cfg.port, o.findListenerPid);
  const service = await lookupService(o.describeService);

  let cert: AgentStatusReport["cert"];
  let x509: X509Certificate | null = null;
  try {
    x509 = new X509Certificate(readFileSync(o.cfg.certPath, "utf8"));
    const notAfter = new Date(x509.validTo);
    cert = {
      sans: sanEntries(x509),
      notAfter: notAfter.toISOString(),
      expired: notAfter.getTime() < Date.now(),
    };
    if (cert.expired) warnings.push(`cert expired at ${cert.notAfter}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    cert = { error: message };
    warnings.push(`cert at ${o.cfg.certPath} could not be read: ${message}`);
  }

  let advertisedHostCovered: boolean | null = null;
  if (o.advertisedHost !== undefined) {
    if (x509) {
      advertisedHostCovered = coversHost(x509, o.advertisedHost);
      if (!advertisedHostCovered && "sans" in cert) {
        warnings.push(
          `cert SANs (${cert.sans.join(", ")}) do not cover advertised host ${o.advertisedHost}; remote clients will fail TLS verification`,
        );
      }
    }
  }
  if (loopbackOnly) {
    warnings.push(`agent binds ${bind} (loopback only); remote control planes cannot reach it`);
  }
  const exposedModelHosts = collectExposedModelHosts(o.cfg.nodeName, o.listModelHosts);
  warnings.push(...exposedModelHosts.map(exposedModelHostWarning));

  return {
    configPath: o.configPath,
    nodeName: o.cfg.nodeName,
    bind,
    certPath: o.cfg.certPath,
    keyPath: o.cfg.keyPath,
    fingerprint: o.cfg.fingerprint,
    running,
    listenerPid,
    service,
    probeUrl,
    loopbackOnly,
    cert,
    advertisedHost: o.advertisedHost ?? null,
    advertisedHostCovered,
    exposedModelHosts,
    warnings,
  };
}

function certLines(cert: AgentStatusReport["cert"]): string[] {
  if ("error" in cert) return [`cert    unreadable: ${cert.error}`];
  return [
    `sans    ${cert.sans.join(", ")}`,
    `expires ${cert.notAfter}${cert.expired ? " (expired)" : ""}`,
  ];
}

function pidSuffix(r: AgentStatusReport): string {
  if (!r.running) return "";
  return ` pid=${r.listenerPid === null ? "unknown" : String(r.listenerPid)}`;
}

function lingerSuffix(linger: boolean | null | undefined): string {
  if (linger === undefined) return "";
  if (linger === null) return " linger=unknown";
  return linger ? " linger=yes" : " linger=no";
}

function serviceLines(s: AgentServiceStatus | null): string[] {
  if (s === null) return [];
  const linger = lingerSuffix(s.linger);
  if (!s.loaded) return [`service ${s.manager} ${s.name} (not loaded)${linger}`];
  const pid = s.pid === null ? "" : ` pid=${String(s.pid)}`;
  return [
    `service ${s.manager} ${s.name} (loaded, ${s.active ? "active" : "inactive"})${pid}${linger}`,
  ];
}

export function formatAgentStatus(r: AgentStatusReport): string {
  const lines = [
    `config  ${r.configPath}`,
    `node    ${r.nodeName ?? "(unset)"}`,
    `bind    ${r.bind}${r.loopbackOnly ? " (loopback only)" : ""}`,
    `running ${r.running ? "yes" : "no"} (${r.probeUrl})${pidSuffix(r)}`,
    ...serviceLines(r.service),
    `cert    ${r.certPath}`,
    ...certLines(r.cert),
  ];
  if (r.advertisedHost !== null) {
    const covered =
      r.advertisedHostCovered === null ? "unknown" : r.advertisedHostCovered ? "yes" : "no";
    lines.push(`advertised ${r.advertisedHost} (cert covers: ${covered})`);
  }
  lines.push(`fp      ${r.fingerprint}`);
  for (const warning of r.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join("\n")}\n`;
}
