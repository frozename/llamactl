import { tls } from "@llamactl/remote";
import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCertSans } from "../src/commands/agent-status.js";
import { serveBindWarning } from "../src/commands/agent.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

const dirs: string[] = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("serveBindWarning", () => {
  test("warns for a loopback bind with a LAN SAN", () => {
    const warning = serveBindWarning("127.0.0.1", ["127.0.0.1", "192.168.1.50"]);
    expect(warning).not.toBeNull();
    expect(warning).toContain("192.168.1.50");
    expect(warning).toContain("agent binds 127.0.0.1");
    expect(warning).toContain("--bind=0.0.0.0");
    expect(warning?.endsWith("\n")).toBe(true);
  });

  test("names only non-loopback entries", () => {
    const warning = serveBindWarning("localhost", ["localhost", "mac-mini.local", "::1"]);
    expect(warning).toContain("cert names mac-mini.local:");
  });

  test("silent when every SAN is loopback", () => {
    expect(serveBindWarning("127.0.0.1", ["127.0.0.1", "::1", "localhost"])).toBeNull();
  });

  test("ignores wildcard SANs", () => {
    expect(serveBindWarning("127.0.0.1", ["127.0.0.1", "0.0.0.0", "::"])).toBeNull();
  });

  test("silent for a non-loopback bind", () => {
    expect(serveBindWarning("0.0.0.0", ["192.168.1.50"])).toBeNull();
    expect(serveBindWarning("192.168.1.50", ["192.168.1.50"])).toBeNull();
  });

  test("silent with no SANs", () => {
    expect(serveBindWarning("127.0.0.1", [])).toBeNull();
  });
});

describe("readCertSans", () => {
  test("returns the SANs with IPv6 compressed", async () => {
    const dir = freshDir("serve-bind-san-");
    const cert = await tls.generateSelfSignedCert({
      dir,
      commonName: "127.0.0.1",
      hostnames: ["127.0.0.1", "::1", "localhost", "192.168.1.50"],
    });
    expect(readCertSans(cert.certPath)).toEqual(["127.0.0.1", "::1", "localhost", "192.168.1.50"]);
  });

  test("a loopback-only cert stays silent", async () => {
    const dir = freshDir("serve-bind-loopback-");
    const cert = await tls.generateSelfSignedCert({
      dir,
      commonName: "127.0.0.1",
      hostnames: ["127.0.0.1", "::1", "localhost"],
    });
    expect(serveBindWarning("127.0.0.1", readCertSans(cert.certPath))).toBeNull();
  });

  test("a LAN cert warns", async () => {
    const dir = freshDir("serve-bind-lan-");
    const cert = await tls.generateSelfSignedCert({
      dir,
      commonName: "127.0.0.1",
      hostnames: ["127.0.0.1", "192.168.1.50"],
    });
    const warning = serveBindWarning("127.0.0.1", readCertSans(cert.certPath));
    expect(warning).toContain("192.168.1.50");
  });

  test("returns [] for a missing cert", () => {
    const dir = freshDir("serve-bind-missing-");
    expect(readCertSans(join(dir, "missing.crt"))).toEqual([]);
  });
});
