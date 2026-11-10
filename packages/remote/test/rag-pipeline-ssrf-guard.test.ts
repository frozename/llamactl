import { describe, expect, it } from "bun:test";

import {
  __test,
  assertPublicUrl,
  SsrfBlockedError,
} from "../src/rag/pipeline/fetchers/ssrf-guard.js";

const { isBlockedIp, isBlockedIpv6, ipv6Groups } = __test;

/* ── helpers ────────────────────────────────────────────────────── */

async function blocked(
  url: string,
  opts?: { allowPrivate?: boolean; resolve?: (host: string) => Promise<string[]> },
): Promise<string> {
  try {
    await assertPublicUrl(url, opts);
    throw new Error(`expected ${url} to be blocked`);
  } catch (err) {
    expect(err).toBeInstanceOf(SsrfBlockedError);
    return (err as Error).message;
  }
}

async function allowed(
  url: string,
  opts?: { allowPrivate?: boolean; resolve?: (host: string) => Promise<string[]> },
): Promise<void> {
  await assertPublicUrl(url, opts);
}

/* ── 1. IPv4 range edges (literal path) ─────────────────────────── */

describe("IPv4 range edges (literal)", () => {
  const privateResolver = (): Promise<string[]> => Promise.resolve(["10.0.0.1"]);

  it("blocks 172.16.0.1", async () => {
    const msg = await blocked("http://172.16.0.1/", { resolve: privateResolver });
    expect(msg).toContain("non-public address rejected");
  });
  it("blocks 172.31.255.255", async () => {
    const msg = await blocked("http://172.31.255.255/", { resolve: privateResolver });
    expect(msg).toContain("non-public address rejected");
  });
  it("blocks 169.254.0.1", async () => {
    const msg = await blocked("http://169.254.0.1/", { resolve: privateResolver });
    expect(msg).toContain("non-public address rejected");
  });
  it("blocks 10.255.255.255", async () => {
    const msg = await blocked("http://10.255.255.255/", { resolve: privateResolver });
    expect(msg).toContain("non-public address rejected");
  });
  it("blocks 0.1.2.3", async () => {
    const msg = await blocked("http://0.1.2.3/", { resolve: privateResolver });
    expect(msg).toContain("non-public address rejected");
  });

  it("allows 172.15.255.255", async () => {
    await allowed("http://172.15.255.255/", { resolve: privateResolver });
  });
  it("allows 172.32.0.1", async () => {
    await allowed("http://172.32.0.1/", { resolve: privateResolver });
  });
  it("allows 169.253.1.1", async () => {
    await allowed("http://169.253.1.1/", { resolve: privateResolver });
  });
  it("allows 169.255.0.1", async () => {
    await allowed("http://169.255.0.1/", { resolve: privateResolver });
  });
  it("allows 192.167.1.1", async () => {
    await allowed("http://192.167.1.1/", { resolve: privateResolver });
  });
  it("allows 192.169.1.1", async () => {
    await allowed("http://192.169.1.1/", { resolve: privateResolver });
  });
  it("allows 9.255.255.255", async () => {
    await allowed("http://9.255.255.255/", { resolve: privateResolver });
  });
  it("allows 11.0.0.1", async () => {
    await allowed("http://11.0.0.1/", { resolve: privateResolver });
  });
  it("allows 126.255.255.254", async () => {
    await allowed("http://126.255.255.254/", { resolve: privateResolver });
  });
  it("allows 128.0.0.1", async () => {
    await allowed("http://128.0.0.1/", { resolve: privateResolver });
  });
});

/* ── 2. Obfuscated loopback (WHATWG URL) ────────────────────────── */

describe("Obfuscated loopback (WHATWG URL)", () => {
  const privateResolver = (): Promise<string[]> => Promise.resolve(["10.0.0.1"]);

  it("blocks http://0x7f000001/", async () => {
    const msg = await blocked("http://0x7f000001/", { resolve: privateResolver });
    expect(msg).toContain("non-public address rejected: 127.0.0.1");
  });
  it("blocks http://2130706433/", async () => {
    const msg = await blocked("http://2130706433/", { resolve: privateResolver });
    expect(msg).toContain("non-public address rejected: 127.0.0.1");
  });
  it("blocks http://127.1/", async () => {
    const msg = await blocked("http://127.1/", { resolve: privateResolver });
    expect(msg).toContain("non-public address rejected: 127.0.0.1");
  });
});

/* ── 3. IPv6 literals ───────────────────────────────────────────── */

describe("IPv6 literals", () => {
  const privateResolver = (): Promise<string[]> => Promise.resolve(["10.0.0.1"]);

  it("blocks http://[::]/ (unspecified)", async () => {
    const msg = await blocked("http://[::]/", { resolve: privateResolver });
    expect(msg).toContain("non-public address rejected");
  });
  it("blocks http://[fd12:3456::1]/ (ULA)", async () => {
    const msg = await blocked("http://[fd12:3456::1]/", { resolve: privateResolver });
    expect(msg).toContain("non-public address rejected");
  });
  it("blocks http://[febf::1]/ (link-local range edge)", async () => {
    const msg = await blocked("http://[febf::1]/", { resolve: privateResolver });
    expect(msg).toContain("non-public address rejected");
  });
  it("blocks http://[fdff:ffff::1]/ (unique-local range edge)", async () => {
    const msg = await blocked("http://[fdff:ffff::1]/", { resolve: privateResolver });
    expect(msg).toContain("non-public address rejected");
  });

  it("allows http://[fec0::1]/", async () => {
    await allowed("http://[fec0::1]/", { resolve: privateResolver });
  });
  it("allows http://[fe00::1]/", async () => {
    await allowed("http://[fe00::1]/", { resolve: privateResolver });
  });
  it("allows http://[fbff::1]/", async () => {
    await allowed("http://[fbff::1]/", { resolve: privateResolver });
  });
  it("allows http://[2606:2800:220:1::1]/", async () => {
    await allowed("http://[2606:2800:220:1::1]/", { resolve: privateResolver });
  });
});

/* ── 4. IPv4-mapped IPv6 ────────────────────────────────────────── */

describe("IPv4-mapped IPv6", () => {
  const privateResolver = (): Promise<string[]> => Promise.resolve(["10.0.0.1"]);

  it("allows http://[::ffff:93.184.216.34]/ (public v4)", async () => {
    await allowed("http://[::ffff:93.184.216.34]/", { resolve: privateResolver });
  });
  it("blocks http://[::ffff:a00:1]/ (private v4)", async () => {
    const msg = await blocked("http://[::ffff:a00:1]/", { resolve: privateResolver });
    expect(msg).toContain("non-public address rejected");
  });
  it("blocks http://[::ffff:c0a8:101]/ (private v4)", async () => {
    const msg = await blocked("http://[::ffff:c0a8:101]/", { resolve: privateResolver });
    expect(msg).toContain("non-public address rejected");
  });
});

/* ── 5. Hostname / DNS path ─────────────────────────────────────── */

describe("Hostname / DNS path", () => {
  describe("multi-family resolution", () => {
    it("blocks when one address is private (93.184.216.34 + 10.0.0.5)", async () => {
      const msg = await blocked("http://docs.example.com/", {
        resolve: (): Promise<string[]> => Promise.resolve(["93.184.216.34", "10.0.0.5"]),
      });
      expect(msg).toContain("resolved to non-public address 10.0.0.5");
    });
    it("blocks when one address is ::1 (2606:2800:220:1::1 + ::1)", async () => {
      const msg = await blocked("http://docs.example.com/", {
        resolve: (): Promise<string[]> => Promise.resolve(["2606:2800:220:1::1", "::1"]),
      });
      expect(msg).toContain("resolved to non-public address ::1");
    });
  });

  describe("empty resolution", () => {
    it("blocks when resolver returns []", async () => {
      const msg = await blocked("http://empty.test/", {
        resolve: (): Promise<string[]> => Promise.resolve([]),
      });
      expect(msg).toContain("resolved to no addresses");
    });
  });

  describe("resolution failure", () => {
    it("blocks with ENOTFOUND message", async () => {
      const msg = await blocked("http://x.test/", {
        resolve: (): Promise<never> => Promise.reject(new Error("ENOTFOUND x.test")),
      });
      expect(msg).toContain("host resolution failed for x.test");
      expect(msg).toContain("ENOTFOUND");
    });
  });

  describe("port stripping", () => {
    it("calls resolver with hostname only (no port)", async () => {
      const calledWith: string[] = [];
      const fn = (host: string): Promise<string[]> => {
        calledWith.push(host);
        return Promise.resolve(["93.184.216.34"]);
      };
      await allowed("http://docs.example.com:8443/a?b", { resolve: fn });
      expect(calledWith).toEqual(["docs.example.com"]);
    });
  });

  describe("literal IP with spy resolver", () => {
    it("spy is called 0 times for literal IP", async () => {
      let callCount = 0;
      const fn = (): Promise<string[]> => {
        callCount++;
        return Promise.resolve(["10.0.0.1"]);
      };
      await allowed("http://93.184.216.34/", { resolve: fn });
      expect(callCount).toBe(0);
    });
  });
});

/* ── 6. Loopback names (before DNS) ─────────────────────────────── */

describe("Loopback names (before DNS)", () => {
  const publicResolver = (): Promise<string[]> => Promise.resolve(["93.184.216.34"]);

  it("blocks http://localhost./", async () => {
    const msg = await blocked("http://localhost./", { resolve: publicResolver });
    expect(msg).toContain("loopback host rejected");
  });
  it("blocks http://LOCALHOST/", async () => {
    const msg = await blocked("http://LOCALHOST/", { resolve: publicResolver });
    expect(msg).toContain("loopback host rejected");
  });
  it("blocks http://a.b.localhost:9/", async () => {
    const msg = await blocked("http://a.b.localhost:9/", { resolve: publicResolver });
    expect(msg).toContain("loopback host rejected");
  });

  it("allows http://localhost.evil.test/", async () => {
    await allowed("http://localhost.evil.test/", { resolve: publicResolver });
  });
});

/* ── 7. Fail-closed parsing ─────────────────────────────────────── */

describe("Fail-closed parsing", () => {
  it("blocks unparseable URL", async () => {
    const msg = await blocked("not a url");
    expect(msg).toContain("unparseable URL");
  });
  it("blocks non-http(s) scheme (ftp)", async () => {
    const msg = await blocked("ftp://example.com/");
    expect(msg).toContain("non-http(s) scheme rejected: ftp:");
  });
  it("error name is SsrfBlockedError", async () => {
    let err: unknown;
    try {
      await assertPublicUrl("not a url");
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ name: "SsrfBlockedError" });
  });
});

/* ── 8. Classifier through __test ────────────────────────────────── */

describe("Classifier (__test)", () => {
  it("isBlockedIpv6('fe80::1%eth0') === true", () => {
    expect(isBlockedIpv6("fe80::1%eth0")).toBe(true);
  });

  it("ipv6Groups('::ffff:1.2.3.4')", () => {
    expect(ipv6Groups("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
  });

  it("ipv6Groups('1:2:3:4:5:6:1.2.3.4')", () => {
    expect(ipv6Groups("1:2:3:4:5:6:1.2.3.4")).toEqual([1, 2, 3, 4, 5, 6, 0x0102, 0x0304]);
  });

  it("ipv6Groups('2001:db8::')", () => {
    expect(ipv6Groups("2001:db8::")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
  });

  it("ipv6Groups returns null for '1:2:3:4:5:6:7:8:9'", () => {
    expect(ipv6Groups("1:2:3:4:5:6:7:8:9")).toBeNull();
  });

  it("ipv6Groups returns null for '1::2::3'", () => {
    expect(ipv6Groups("1::2::3")).toBeNull();
  });

  it("ipv6Groups returns null for '::ffff:1.2.3.999'", () => {
    expect(ipv6Groups("::ffff:1.2.3.999")).toBeNull();
  });

  it("isBlockedIp('::ffff:7f00:1') === true", () => {
    expect(isBlockedIp("::ffff:7f00:1")).toBe(true);
  });

  it("isBlockedIp('::1') === true", () => {
    expect(isBlockedIp("::1")).toBe(true);
  });

  it("isBlockedIp('::2') === false", () => {
    expect(isBlockedIp("::2")).toBe(false);
  });

  it("isBlockedIp('not-an-ip') === false", () => {
    expect(isBlockedIp("not-an-ip")).toBe(false);
  });
});
