import type { tls } from "@llamactl/remote";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AgentCommandDeps, runAgent } from "../src/commands/agent.js";
import { mkdtempSync, readFileSync, rmSync } from "../src/safe-fs.js";

let tmp = "";

async function capture(
  args: string[],
  deps?: AgentCommandDeps,
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array): true => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): true => {
    err += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  try {
    const code = await runAgent(args, deps);
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function certFromTmp(): X509Certificate {
  return new X509Certificate(readFileSync(join(tmp, "agent.crt"), "utf8"));
}

function recordingGenerator(): {
  calls: { commonName: string; hostnames: string[] }[];
  generate: typeof tls.generateSelfSignedCert;
} {
  const calls: { commonName: string; hostnames: string[] }[] = [];
  const generate: typeof tls.generateSelfSignedCert = (opts) => {
    calls.push({ commonName: opts.commonName, hostnames: opts.hostnames ?? [] });
    return Promise.resolve({
      certPath: join(opts.dir, "agent.crt"),
      keyPath: join(opts.dir, "agent.key"),
      certPem: "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n",
      keyPem: "fake-key",
      fingerprint: "sha256:" + "0".repeat(64),
    });
  };
  return { calls, generate };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-agent-init-sans-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("agent init SAN selection (#217, #976)", () => {
  test("explicit --san with wildcard bind keeps loopback SANs", async () => {
    const gen = recordingGenerator();
    const r = await capture(
      ["init", `--dir=${tmp}`, "--json", "--bind=0.0.0.0", "--san=192.168.1.5,z13"],
      { generateSelfSignedCert: gen.generate },
    );
    expect(r.code).toBe(0);
    expect(gen.calls).toHaveLength(1);
    expect(gen.calls[0]?.hostnames).toEqual([
      "127.0.0.1",
      "192.168.1.5",
      "z13",
      "::1",
      "localhost",
    ]);
    expect(gen.calls[0]?.commonName).toBe("127.0.0.1");
  });

  test("default path with wildcard bind adds loopback SANs", async () => {
    const gen = recordingGenerator();
    const r = await capture(
      ["init", `--dir=${tmp}`, "--json", "--host=192.168.1.5", "--bind=0.0.0.0"],
      { generateSelfSignedCert: gen.generate },
    );
    expect(r.code).toBe(0);
    expect(gen.calls).toHaveLength(1);
    expect(gen.calls[0]?.hostnames).toEqual([
      "192.168.1.5",
      "0.0.0.0",
      "127.0.0.1",
      "::1",
      "localhost",
    ]);
    expect(gen.calls[0]?.commonName).toBe("192.168.1.5");
  });

  test("IPv6 wildcard bind adds loopback SANs", async () => {
    const gen = recordingGenerator();
    const r = await capture(["init", `--dir=${tmp}`, "--json", "--bind=::"], {
      generateSelfSignedCert: gen.generate,
    });
    expect(r.code).toBe(0);
    expect(gen.calls).toHaveLength(1);
    expect(gen.calls[0]?.hostnames).toEqual(["127.0.0.1", "::", "::1", "localhost"]);
    expect(gen.calls[0]?.commonName).toBe("127.0.0.1");
  });

  test("loopback bind with explicit --san=127.0.0.1 adds ::1 and localhost", async () => {
    const gen = recordingGenerator();
    const r = await capture(["init", `--dir=${tmp}`, "--json", "--san=127.0.0.1"], {
      generateSelfSignedCert: gen.generate,
    });
    expect(r.code).toBe(0);
    expect(gen.calls).toHaveLength(1);
    expect(gen.calls[0]?.hostnames).toEqual(["127.0.0.1", "::1", "localhost"]);
    expect(gen.calls[0]?.commonName).toBe("127.0.0.1");
  });

  test("non-loopback bind does not get loopback SANs", async () => {
    const gen = recordingGenerator();
    const r = await capture(
      [
        "init",
        `--dir=${tmp}`,
        "--json",
        "--host=192.168.1.5",
        "--bind=192.168.1.5",
        "--san=192.168.1.5",
      ],
      { generateSelfSignedCert: gen.generate },
    );
    expect(r.code).toBe(0);
    expect(gen.calls).toHaveLength(1);
    expect(gen.calls[0]?.hostnames).toEqual(["192.168.1.5"]);
    expect(gen.calls[0]?.commonName).toBe("192.168.1.5");
  });

  test("--no-loopback-san opts out on a wildcard bind", async () => {
    const gen = recordingGenerator();
    const r = await capture(
      [
        "init",
        `--dir=${tmp}`,
        "--json",
        "--host=192.168.1.5",
        "--bind=0.0.0.0",
        "--san=192.168.1.5",
        "--no-loopback-san",
      ],
      { generateSelfSignedCert: gen.generate },
    );
    expect(r.code).toBe(0);
    expect(gen.calls).toHaveLength(1);
    expect(gen.calls[0]?.hostnames).toEqual(["192.168.1.5"]);
    expect(gen.calls[0]?.commonName).toBe("192.168.1.5");
  });

  test("loopback SANs are not duplicated when already requested", async () => {
    const gen = recordingGenerator();
    const r = await capture(
      ["init", `--dir=${tmp}`, "--json", "--bind=0.0.0.0", "--san=127.0.0.1,localhost"],
      { generateSelfSignedCert: gen.generate },
    );
    expect(r.code).toBe(0);
    expect(gen.calls).toHaveLength(1);
    expect(gen.calls[0]?.hostnames).toEqual(["127.0.0.1", "localhost", "::1"]);
    expect(gen.calls[0]?.commonName).toBe("127.0.0.1");
    expect(gen.calls[0]?.hostnames.filter((hostname) => hostname === "127.0.0.1")).toHaveLength(1);
    expect(gen.calls[0]?.hostnames.filter((hostname) => hostname === "::1")).toHaveLength(1);
    expect(gen.calls[0]?.hostnames.filter((hostname) => hostname === "localhost")).toHaveLength(1);
  });

  test("summary prints the exact sans line and JSON record keys are unchanged", async () => {
    const gen = recordingGenerator();
    const r = await capture(
      ["init", `--dir=${tmp}`, "--json", "--bind=0.0.0.0", "--san=192.168.1.5,z13"],
      { generateSelfSignedCert: gen.generate },
    );
    expect(r.code).toBe(0);
    expect(gen.calls).toHaveLength(1);
    expect(gen.calls[0]?.hostnames).toEqual([
      "127.0.0.1",
      "192.168.1.5",
      "z13",
      "::1",
      "localhost",
    ]);
    expect(gen.calls[0]?.commonName).toBe("127.0.0.1");
    expect(r.err.split("\n")).toContain("sans   127.0.0.1,192.168.1.5,z13,::1,localhost");
    const lastLine = r.out.trimEnd().split("\n").at(-1) ?? "";
    const record = JSON.parse(lastLine) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([
      "bindHost",
      "blob",
      "configPath",
      "fingerprint",
      "nodeName",
      "port",
    ]);
    expect(record["fingerprint"]).toBe("sha256:" + "0".repeat(64));
  });
});

describe("agent init real cert generator", () => {
  // This starts openssl twice and pays first-import warm-up; on a busy hosted
  // macos-latest runner that ran past bun's 5s default (#976, run 46109186307).
  test("explicit --san with wildcard bind writes the expected SANs", async () => {
    const r = await capture([
      "init",
      `--dir=${tmp}`,
      "--json",
      "--bind=0.0.0.0",
      "--san=192.168.1.5,z13",
    ]);
    expect(r.code).toBe(0);
    const cert = certFromTmp();
    expect(cert.checkIP("192.168.1.5")).toBeDefined();
    expect(cert.checkHost("z13")).toBeDefined();
    expect(cert.checkIP("127.0.0.1")).toBeDefined();
    expect(cert.checkIP("::1")).toBeDefined();
    expect(cert.checkHost("localhost")).toBeDefined();
    expect(cert.checkIP("10.9.9.9")).toBeUndefined();
  }, 30_000);
});
