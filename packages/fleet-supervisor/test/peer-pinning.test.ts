import type { PeerNode } from "@llamactl/core/config/peers";

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { assertPeerPinned } from "../src/peer-pinning.js";

/**
 * Pins assertPeerPinned (packages/fleet-supervisor/src/peer-pinning.ts), the
 * fail-closed gate createPeerFetch runs before it sends the bearer to a peer:
 * the sha256 fingerprint check when both certificate and fingerprint are set
 * (exact, case-sensitive, length-guarded), the invalid-PEM error, and which
 * endpoints count as local when no certificate is pinned. The PEM is synthetic
 * and hashed in the test, so there is no openssl, network, filesystem or clock.
 */

const REMOTE = "https://remote.example:7843";
const DER = Buffer.from("fake-der-bytes");
const B64 = DER.toString("base64");
// The body is wrapped across two lines, as PEM bodies are.
const PEM = [
  "-----BEGIN CERTIFICATE-----",
  B64.slice(0, 8),
  B64.slice(8),
  "-----END CERTIFICATE-----",
  "",
].join("\n");
const HEX = createHash("sha256").update(DER).digest("hex");
const PINNED = `sha256:${HEX}`;
const NO_CERT = "peer 'p1' has no pinned certificate; refusing to connect";

// Returns what assertPeerPinned threw for `peer`, or "no error" when it returned.
function outcome(peer: PeerNode): unknown {
  try {
    assertPeerPinned(peer);
  } catch (err) {
    return err;
  }
  return "no error";
}

function messageOf(peer: PeerNode): string {
  const err = outcome(peer);
  return err instanceof Error ? err.message : String(err);
}

function mismatch(expected: string): string {
  return `certificate fingerprint mismatch for peer 'p1': expected ${expected}, got ${PINNED}`;
}

describe("assertPeerPinned fingerprint check", () => {
  test("a matching sha256 fingerprint on a non-local endpoint passes", () => {
    expect(messageOf({ id: "p1", endpoint: REMOTE, certificate: PEM, fingerprint: PINNED })).toBe(
      "no error",
    );
  });

  test("a fingerprint with one hex digit changed throws a mismatch naming both values", () => {
    const flipped = `${PINNED.slice(0, -1)}${PINNED.endsWith("0") ? "1" : "0"}`;
    expect(flipped).not.toBe(PINNED);
    const err = outcome({ id: "p1", endpoint: REMOTE, certificate: PEM, fingerprint: flipped });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(mismatch(flipped));
  });

  test("a fingerprint of a different length throws the mismatch Error, not a RangeError", () => {
    for (const fingerprint of ["sha256:abc", `${PINNED}0`]) {
      const err = outcome({ id: "p1", endpoint: REMOTE, certificate: PEM, fingerprint });
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(RangeError);
      expect((err as Error).message).toBe(mismatch(fingerprint));
    }
  });

  test("the comparison is case-sensitive: an uppercase-hex fingerprint throws a mismatch", () => {
    const upper = `sha256:${HEX.toUpperCase()}`;
    expect(upper).not.toBe(PINNED);
    expect(messageOf({ id: "p1", endpoint: REMOTE, certificate: PEM, fingerprint: upper })).toBe(
      mismatch(upper),
    );
  });

  test("a certificate without PEM markers throws 'not a valid cert PEM' when a fingerprint is set", () => {
    expect(
      messageOf({ id: "p1", endpoint: REMOTE, certificate: "garbage", fingerprint: PINNED }),
    ).toBe("not a valid cert PEM");
  });

  test("a certificate with no fingerprint is not checked, even when it is not a PEM", () => {
    // Documents current behaviour: the fingerprint check needs both fields.
    expect(messageOf({ id: "p1", endpoint: REMOTE, certificate: "garbage" })).toBe("no error");
  });

  test("a fingerprint without a certificate is not checked, so only the endpoint decides", () => {
    expect(messageOf({ id: "p1", endpoint: REMOTE, fingerprint: "sha256:abc" })).toBe(NO_CERT);
    expect(messageOf({ id: "p1", endpoint: REMOTE, certificate: "", fingerprint: PINNED })).toBe(
      NO_CERT,
    );
    expect(messageOf({ id: "p1", endpoint: "http://localhost:1", fingerprint: "sha256:abc" })).toBe(
      "no error",
    );
  });
});

describe("assertPeerPinned endpoint check without a certificate", () => {
  test("localhost, 127.0.0.1 and [::1] endpoints pass, after URL normalisation", () => {
    const endpoints = [
      "http://localhost:1",
      "http://LOCALHOST:1",
      "https://127.0.0.1:7843",
      "http://127.1:1",
      "http://[::1]:7843",
      "http://[0:0:0:0:0:0:0:1]:1",
    ];
    const refused = endpoints.filter(
      (endpoint) => messageOf({ id: "p1", endpoint }) !== "no error",
    );
    expect(refused).toEqual([]);
  });

  test("other loopback forms, remote hosts and unparseable endpoints refuse to connect", () => {
    const endpoints = [
      "http://127.0.0.2:1",
      "http://localhost.:1",
      "http://foo.localhost:1",
      "https://10.0.0.5:7843",
      REMOTE,
      "not a url",
      "",
    ];
    expect(endpoints.map((endpoint) => messageOf({ id: "p1", endpoint }))).toEqual(
      endpoints.map(() => NO_CERT),
    );
  });
});
