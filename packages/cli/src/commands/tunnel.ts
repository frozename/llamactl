import type { Config } from "@llamactl/core/config/schema";

import { defaultConfigPath, loadConfig, mutateConfig } from "@llamactl/core/config/kubeconfig";
import { tls } from "@llamactl/remote";
import * as tlsModule from "node:tls";
import { URL } from "node:url";

import { required } from "../required.js";

const { computeFingerprint } = tls;
function mutateConfigLocked(path: string, fn: (cfg: Config) => Config): Config {
  return mutateConfig(path, fn);
}

const USAGE = `llamactl tunnel — reverse-tunnel operator utilities

USAGE:
  llamactl tunnel pin-central [--context=<name>] [--url=<url>]
      Capture the local central agent's TLS cert + fingerprint and
      persist them on the given kubeconfig context so the
      /tunnel-relay POST can pin against it (Bun fetch({tls:{ca}})).

      --context   Context to update (defaults to the current context).
      --url       Central URL to dial (defaults to the context's
                  tunnelCentralUrl, which must already be set).

      Prints 'pinned <host>:<port> -> sha256:<hex>' to stderr on
      success; writes tunnelCentralCertificate +
      tunnelCentralFingerprint into the context. Re-run after the
      central agent rotates its cert.

NOTES:
  * This pin is for the *local central agent's* cert, not the
    remote node's (that stays on ClusterNode.certificateFingerprint
    for direct HTTPS). Distinct trust domains.
  * The stored PEM is the cert only — never the private key. A
    compromised kubeconfig exposes public data + bearer tokens, not
    private keys.
`;

export async function runTunnel(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- Preserve existing CLI/test semantics while clearing strict lint debt.
  switch (sub) {
    case "pin-central":
      return await runPinCentral(rest);
    default:
      process.stderr.write(`unknown subcommand: tunnel ${String(sub)}\n\n${USAGE}`);
      return 1;
  }
}

interface PinCentralFlags {
  context?: string;
  url?: string;
}

function parsePinCentralFlags(argv: string[]): PinCentralFlags | { error: string } {
  const flags: PinCentralFlags = {};
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { error: "help" };
    }
    if (!arg.startsWith("--")) {
      return { error: `tunnel pin-central: unexpected positional ${arg}` };
    }
    const eq = arg.indexOf("=");
    if (eq < 0) {
      return { error: `tunnel pin-central: flag must be --key=value: ${arg}` };
    }
    const key = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    switch (key) {
      case "--context":
        flags.context = value;
        break;
      case "--url":
        flags.url = value;
        break;
      default:
        return { error: `tunnel pin-central: unknown flag ${key}` };
    }
  }
  return flags;
}

async function runPinCentral(argv: string[]): Promise<number> {
  const parsed = parsePinCentralFlags(argv);
  if ("error" in parsed) {
    if (parsed.error === "help") {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }

  const cfgPath = defaultConfigPath();
  const cfg = loadConfig(cfgPath);
  const ctxName = parsed.context ?? cfg.currentContext;
  const ctxIndex = cfg.contexts.findIndex((c) => c.name === ctxName);
  if (ctxIndex < 0) {
    process.stderr.write(`tunnel pin-central: context '${ctxName}' not found in ${cfgPath}\n`);
    return 1;
  }
  const ctx = required(cfg.contexts[ctxIndex]);
  const urlStr = parsed.url ?? ctx.tunnelCentralUrl;
  if (!urlStr) {
    process.stderr.write(
      `tunnel pin-central: context '${ctxName}' has no tunnelCentralUrl; pass --url=<url> or set it with \`llamactl ctx\`-style kubeconfig edits\n`,
    );
    return 1;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlStr);
  } catch {
    process.stderr.write(`tunnel pin-central: invalid URL '${urlStr}'\n`);
    return 1;
  }
  if (parsedUrl.protocol !== "https:") {
    process.stderr.write(
      `tunnel pin-central: tunnelCentralUrl must be https:// (got '${parsedUrl.protocol}')\n`,
    );
    return 1;
  }
  const host = parsedUrl.hostname;
  const port = parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : 443;
  if (!Number.isFinite(port) || port <= 0) {
    process.stderr.write(`tunnel pin-central: invalid port '${parsedUrl.port}'\n`);
    return 1;
  }

  // Cert capture uses node:tls — verified against Bun 1.3.x.
  // getPeerCertificate(true) returns the detailed form including
  // `.raw` (DER). We PEM-wrap it ourselves and hash with the shared
  // `computeFingerprint` helper so the stored value matches what
  // the server's `loadCert(...).fingerprint` would emit.
  let captured: { pem: string; fingerprint: string };
  try {
    captured = await capturePeerCert(host, port);
  } catch (err) {
    process.stderr.write(
      `tunnel pin-central: failed to capture cert from ${host}:${String(port)}: ${(err as Error).message}\n`,
    );
    return 1;
  }

  mutateConfigLocked(cfgPath, (next: Config) => {
    const contexts = next.contexts;
    const targetIndex = contexts.findIndex((c) => c.name === ctxName);
    if (targetIndex < 0) {
      throw new Error(`tunnel pin-central: context '${ctxName}' not found in ${cfgPath}`);
    }
    const context = required(contexts[targetIndex]);
    return {
      ...next,
      contexts: contexts.map((current, index) =>
        index === targetIndex
          ? {
              ...current,
              ...context,
              ...(context.tunnelCentralUrl ? {} : { tunnelCentralUrl: urlStr }),
              tunnelCentralCertificate: captured.pem,
              tunnelCentralFingerprint: captured.fingerprint,
            }
          : current,
      ),
    };
  });
  // Fingerprint only — never log the full PEM or any key material.
  process.stderr.write(`pinned ${host}:${String(port)} -> ${captured.fingerprint}\n`);
  return 0;
}

/**
 * Open a raw TLS connection to `host:port`, read the peer cert, and
 * return both the PEM-wrapped DER and the sha256 fingerprint. Uses
 * `rejectUnauthorized: false` — we're *capturing* the cert so the
 * operator can inspect the fingerprint. Subsequent relay POSTs pin
 * against the stored value.
 */
function capturePeerCert(
  host: string,
  port: number,
): Promise<{ pem: string; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const socket = tlsModule.connect({
      host,
      port,
      servername: host,
      // We want to see whatever cert central presents so the operator
      // can trust-on-first-use. Pinning happens on subsequent calls.
      rejectUnauthorized: false,
      timeout: 10_000,
    });
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // best-effort cleanup
      }
      fn();
    };
    socket.on("secureConnect", () => {
      // Node hands back an empty object (no `raw`) when the peer presented
      // no certificate, despite the non-nullable static type.
      const cert: { raw?: Buffer } = socket.getPeerCertificate(true);
      if (!cert.raw || cert.raw.length === 0) {
        done(() => {
          reject(new Error("no peer cert received"));
        });
        return;
      }
      const pem = derToPem(cert.raw);
      let fingerprint: string;
      try {
        fingerprint = computeFingerprint(pem);
      } catch (err) {
        done(() => {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve existing CLI/test semantics while clearing strict lint debt.
          reject(err);
        });
        return;
      }
      done(() => {
        resolve({ pem, fingerprint });
      });
    });
    socket.on("error", (err) => {
      done(() => {
        reject(err);
      });
    });
    socket.on("timeout", () => {
      done(() => {
        reject(new Error(`timeout connecting to ${host}:${String(port)}`));
      });
    });
  });
}

/**
 * Wrap raw DER cert bytes in PEM format. Matches OpenSSL's output
 * so `computeFingerprint` (which base64-decodes the body) sees the
 * same bytes back.
 */
function derToPem(der: Buffer): string {
  const b64 = der.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}
