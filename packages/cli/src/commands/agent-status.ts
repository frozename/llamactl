// Read-only agent status report (#211): config, liveness via the
// unauthenticated /healthz, loopback-bind detection, and cert expiry +
// SAN coverage of the host the operator advertises.
import type { AgentConfig } from "@llamactl/core/config/agent-config";

import { findTcpListenerPid } from "@llamactl/core/probe";
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";

import { readFileSync } from "../safe-fs.js";
import { urlHost } from "./update/probes.js";

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
  probeUrl: string;
  loopbackOnly: boolean;
  cert: AgentCertStatus | { error: string };
  advertisedHost: string | null;
  advertisedHostCovered: boolean | null;
  warnings: string[];
}

export type ProbeFn = (url: string) => Promise<boolean>;

export type ListenerPidFn = (host: string, port: number) => Promise<number | null>;

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

export async function collectAgentStatus(o: {
  configPath: string;
  cfg: AgentConfig;
  advertisedHost?: string;
  probe?: ProbeFn;
  findListenerPid?: ListenerPidFn;
}): Promise<AgentStatusReport> {
  const warnings: string[] = [];
  const bind = `${o.cfg.bindHost}:${String(o.cfg.port)}`;
  const loopbackOnly = isLoopbackHost(o.cfg.bindHost);
  const probeHost = urlHost(o.cfg.bindHost);
  const probeUrl = `https://${probeHost}:${String(o.cfg.port)}/healthz`;
  const running = await (o.probe ?? defaultProbe)(probeUrl);
  const listenerPid = await lookupListenerPid(running, probeHost, o.cfg.port, o.findListenerPid);

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

  return {
    configPath: o.configPath,
    nodeName: o.cfg.nodeName,
    bind,
    certPath: o.cfg.certPath,
    keyPath: o.cfg.keyPath,
    fingerprint: o.cfg.fingerprint,
    running,
    listenerPid,
    probeUrl,
    loopbackOnly,
    cert,
    advertisedHost: o.advertisedHost ?? null,
    advertisedHostCovered,
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

export function formatAgentStatus(r: AgentStatusReport): string {
  const lines = [
    `config  ${r.configPath}`,
    `node    ${r.nodeName ?? "(unset)"}`,
    `bind    ${r.bind}${r.loopbackOnly ? " (loopback only)" : ""}`,
    `running ${r.running ? "yes" : "no"} (${r.probeUrl})${pidSuffix(r)}`,
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
