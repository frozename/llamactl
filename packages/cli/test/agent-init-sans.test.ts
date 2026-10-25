import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgent } from "../src/commands/agent.js";
import { mkdtempSync, readFileSync, rmSync } from "../src/safe-fs.js";

let tmp = "";

async function capture(args: string[]): Promise<{ code: number; out: string; err: string }> {
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
    const code = await runAgent(args);
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function certFromTmp(): X509Certificate {
  return new X509Certificate(readFileSync(join(tmp, "agent.crt"), "utf8"));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-agent-init-sans-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("agent init SANs (#217)", () => {
  test("explicit --san with wildcard bind keeps loopback SANs", async () => {
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
  });

  test("default path with wildcard bind adds loopback SANs", async () => {
    const r = await capture([
      "init",
      `--dir=${tmp}`,
      "--json",
      "--host=192.168.1.5",
      "--bind=0.0.0.0",
    ]);
    expect(r.code).toBe(0);
    const cert = certFromTmp();
    expect(cert.checkIP("192.168.1.5")).toBeDefined();
    expect(cert.checkIP("127.0.0.1")).toBeDefined();
    expect(cert.checkIP("::1")).toBeDefined();
    expect(cert.checkHost("localhost")).toBeDefined();
  });

  test("IPv6 wildcard bind adds loopback SANs", async () => {
    const r = await capture(["init", `--dir=${tmp}`, "--json", "--bind=::"]);
    expect(r.code).toBe(0);
    const cert = certFromTmp();
    expect(cert.checkIP("127.0.0.1")).toBeDefined();
    expect(cert.checkIP("::1")).toBeDefined();
    expect(cert.checkHost("localhost")).toBeDefined();
  });

  test("loopback bind with explicit --san=127.0.0.1 adds ::1 and localhost", async () => {
    const r = await capture(["init", `--dir=${tmp}`, "--json", "--san=127.0.0.1"]);
    expect(r.code).toBe(0);
    const cert = certFromTmp();
    expect(cert.checkIP("::1")).toBeDefined();
    expect(cert.checkHost("localhost")).toBeDefined();
  });

  test("non-loopback bind does not get loopback SANs", async () => {
    const r = await capture([
      "init",
      `--dir=${tmp}`,
      "--json",
      "--host=192.168.1.5",
      "--bind=192.168.1.5",
      "--san=192.168.1.5",
    ]);
    expect(r.code).toBe(0);
    const cert = certFromTmp();
    expect(cert.checkIP("192.168.1.5")).toBeDefined();
    expect(cert.checkIP("127.0.0.1")).toBeUndefined();
    expect(cert.checkIP("::1")).toBeUndefined();
    expect(cert.checkHost("localhost")).toBeUndefined();
  });

  test("--no-loopback-san opts out on a wildcard bind", async () => {
    const r = await capture([
      "init",
      `--dir=${tmp}`,
      "--json",
      "--host=192.168.1.5",
      "--bind=0.0.0.0",
      "--san=192.168.1.5",
      "--no-loopback-san",
    ]);
    expect(r.code).toBe(0);
    const cert = certFromTmp();
    expect(cert.checkIP("192.168.1.5")).toBeDefined();
    expect(cert.checkIP("127.0.0.1")).toBeUndefined();
    expect(cert.checkIP("::1")).toBeUndefined();
    expect(cert.checkHost("localhost")).toBeUndefined();
  });

  test("loopback SANs are not duplicated when already requested", async () => {
    const r = await capture([
      "init",
      `--dir=${tmp}`,
      "--json",
      "--bind=0.0.0.0",
      "--san=127.0.0.1,localhost",
    ]);
    expect(r.code).toBe(0);
    const entries = (certFromTmp().subjectAltName ?? "").split(", ");
    expect(entries.filter((e) => e === "DNS:localhost").length).toBe(1);
    expect(entries.filter((e) => e === "IP Address:127.0.0.1").length).toBe(1);
  });

  test("summary prints a sans line and JSON record keys are unchanged", async () => {
    const r = await capture([
      "init",
      `--dir=${tmp}`,
      "--json",
      "--bind=0.0.0.0",
      "--san=192.168.1.5,z13",
    ]);
    expect(r.code).toBe(0);
    expect(r.err.split("\n").some((line) => line.startsWith("sans   "))).toBe(true);
    const lastLine = r.out.trimEnd().split("\n").at(-1) ?? "";
    const record = JSON.parse(lastLine) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(
      ["blob", "bindHost", "configPath", "fingerprint", "nodeName", "port"].sort(),
    );
  });
});
