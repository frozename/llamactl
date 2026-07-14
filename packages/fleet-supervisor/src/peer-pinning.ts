import { createHash, timingSafeEqual } from "node:crypto";

import type { AggregatorPeer } from "./aggregator.js";

/**
 * Fail-closed pinning contract for direct peer requests. Mirrors
 * `makePinnedFetch` in @llamactl/remote (packages/remote/src/client/links.ts)
 * so both paths refuse to ship a control-plane bearer over an
 * unpinned TLS connection.
 *
 * Rules:
 *   1. If the peer entry carries BOTH `certificate` and `fingerprint`,
 *      they must match — catches a tampered stored cert the same way
 *      `assertFingerprintMatch` does in the tRPC client factory.
 *   2. If no `certificate` is pinned AND the endpoint is non-local,
 *      refuse to connect — otherwise the bearer would ship under
 *      whatever system roots happen to be trusted (public CA MITM).
 *   3. Local endpoints (`localhost`, `127.0.0.1`, `[::1]`) stay
 *      allowed without a pinned CA for the dev / loopback path.
 */
export function assertPeerPinned(peer: AggregatorPeer): void {
  if (peer.certificate && peer.fingerprint) {
    const actual = computeFingerprint(peer.certificate);
    if (!fingerprintsEqual(actual, peer.fingerprint)) {
      throw new Error(
        `certificate fingerprint mismatch for peer '${peer.id}': ` +
          `expected ${peer.fingerprint}, got ${actual}`,
      );
    }
  }
  if (!peer.certificate && !isLocalEndpoint(peer.endpoint)) {
    throw new Error(`peer '${peer.id}' has no pinned certificate; refusing to connect`);
  }
}

function isLocalEndpoint(endpoint: string): boolean {
  try {
    const { hostname } = new URL(endpoint);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function computeFingerprint(certPem: string): string {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(certPem);
  if (!match?.[1]) throw new Error("not a valid cert PEM");
  const der = Buffer.from(match[1].replaceAll(/\s+/g, ""), "base64");
  const hex = createHash("sha256").update(der).digest("hex");
  return `sha256:${hex}`;
}

function fingerprintsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
