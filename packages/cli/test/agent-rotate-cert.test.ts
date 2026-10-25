import { tls } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgent } from "../src/commands/agent.js";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { parseJsonRecord } from "./helpers.js";

let dir = "";
const originalEnv = { ...process.env };

let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;
let stdoutBuf = "";

function captureStdout(): void {
  stdoutBuf = "";
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array): true => {
    stdoutBuf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  process.stderr.write = (_chunk: string | Uint8Array): true => true;
}

function restore(): void {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
}

function lastJsonRecord(): Record<string, unknown> {
  return parseJsonRecord(stdoutBuf.trim().split("\n").pop()!);
}

function decodeBlob(blob: string): Record<string, unknown> {
  return parseJsonRecord(Buffer.from(blob, "base64url").toString("utf8"));
}

function certSans(certPath: string): string[] {
  const pem = readFileSync(certPath, "utf8");
  return (new X509Certificate(pem).subjectAltName ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function seedAgent(): Promise<{ fingerprint: string; blob: string }> {
  captureStdout();
  try {
    const code = await runAgent([
      "init",
      `--dir=${dir}`,
      "--host=127.0.0.1",
      "--port=7843",
      "--json",
    ]);
    expect(code).toBe(0);
    const record = lastJsonRecord();
    return { fingerprint: String(record["fingerprint"]), blob: String(record["blob"]) };
  } finally {
    restore();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rotate-cert-"));
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

describe("agent rotate-cert", () => {
  test("rotates the cert with explicit SANs, keeps the tokenHash, leaves no staging dir", async () => {
    const initRecord = await seedAgent();

    captureStdout();
    let code: number;
    let record: Record<string, unknown>;
    try {
      code = await runAgent([
        "rotate-cert",
        `--dir=${dir}`,
        "--san=127.0.0.1,192.168.1.50",
        "--json",
      ]);
      expect(code).toBe(0);
      record = lastJsonRecord();
    } finally {
      restore();
    }

    const yaml = readFileSync(join(dir, "agent.yaml"), "utf8");
    expect(/tokenHash:\s*(\S+)/.exec(yaml)?.[1]).toBeTruthy();
    const yamlFingerprint = /fingerprint:\s*(\S+)/.exec(yaml)?.[1];
    const newCertPem = readFileSync(join(dir, "agent.crt"), "utf8");

    const recordFingerprint = String(record["fingerprint"]);
    expect(yamlFingerprint).toBe(recordFingerprint);
    expect(recordFingerprint).toBe(tls.computeFingerprint(newCertPem));
    expect(recordFingerprint).not.toBe(initRecord.fingerprint);

    expect(certSans(join(dir, "agent.crt"))).toContain("IP Address:192.168.1.50");
    expect(record["blob"]).toBeNull();
    expect(readdirSync(dir).some((e) => e.startsWith(".rotate-cert-"))).toBe(false);
  });

  test("accumulates repeated --san flags and dedupes the list", async () => {
    await seedAgent();

    captureStdout();
    try {
      const code = await runAgent([
        "rotate-cert",
        `--dir=${dir}`,
        "--san=a.local",
        "--san=b.local,a.local",
        "--json",
      ]);
      expect(code).toBe(0);
      const record = lastJsonRecord();
      expect(Array.isArray(record["sans"])).toBe(true);
      expect((record["sans"] as unknown[]).length).toBe(2);
    } finally {
      restore();
    }

    const sans = certSans(join(dir, "agent.crt"));
    expect(sans).toContain("DNS:a.local");
    expect(sans).toContain("DNS:b.local");
  });

  test("emits a bootstrap blob with the current token when --token-file verifies", async () => {
    const initRecord = await seedAgent();
    const initToken = decodeBlob(initRecord.blob)["token"] as string;
    const tokenFile = join(dir, "token.txt");
    writeFileSync(tokenFile, `${initToken}\n`);

    captureStdout();
    let record: Record<string, unknown>;
    try {
      const code = await runAgent([
        "rotate-cert",
        `--dir=${dir}`,
        `--token-file=${tokenFile}`,
        "--json",
      ]);
      expect(code).toBe(0);
      record = lastJsonRecord();
    } finally {
      restore();
    }

    expect(record["blob"]).toBeTruthy();
    const blob = decodeBlob(String(record["blob"]));
    expect(blob["token"]).toBe(initToken);
    expect(blob["url"]).toBe("https://127.0.0.1:7843");
    expect(blob["fingerprint"]).toBe(record["fingerprint"]);
    expect(blob["certificate"]).toBe(readFileSync(join(dir, "agent.crt"), "utf8"));
  });

  test("a wrong --token-file exits 1 without touching any file", async () => {
    await seedAgent();
    const yamlBefore = readFileSync(join(dir, "agent.yaml"));
    const certBefore = readFileSync(join(dir, "agent.crt"));
    const keyBefore = readFileSync(join(dir, "agent.key"));
    const tokenFile = join(dir, "bad-token.txt");
    writeFileSync(tokenFile, "not-the-token\n");

    captureStdout();
    try {
      const code = await runAgent([
        "rotate-cert",
        `--dir=${dir}`,
        `--token-file=${tokenFile}`,
        "--json",
      ]);
      expect(code).toBe(1);
    } finally {
      restore();
    }

    expect(readFileSync(join(dir, "agent.yaml"))).toEqual(yamlBefore);
    expect(readFileSync(join(dir, "agent.crt"))).toEqual(certBefore);
    expect(readFileSync(join(dir, "agent.key"))).toEqual(keyBefore);
    expect(readdirSync(dir).some((e) => e.startsWith(".rotate-cert-"))).toBe(false);
  });

  test("errors with exit code 1 when agent.yaml is missing", async () => {
    captureStdout();
    try {
      const code = await runAgent(["rotate-cert", `--dir=${dir}`]);
      expect(code).toBe(1);
    } finally {
      restore();
    }
  });

  test("rejects unknown flags", async () => {
    captureStdout();
    try {
      const code = await runAgent(["rotate-cert", "--unknown=1"]);
      expect(code).toBe(1);
    } finally {
      restore();
    }
  });
});
