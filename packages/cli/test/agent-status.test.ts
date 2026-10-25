import {
  agentConfig as agentConfigMod,
  type RunningAgent,
  startAgentServer,
} from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AgentStatusReport, isLoopbackHost } from "../src/commands/agent-status.js";
import { runAgent } from "../src/commands/agent.js";
import { mkdtempSync, rmSync, unlinkSync } from "../src/safe-fs.js";

/**
 * #211: `agent status` must report liveness (GET /healthz), flag a
 * loopback-only bind, and check cert expiry + SAN coverage of the
 * advertised host — not just echo agent.yaml.
 */

let tmp = "";
let agent: RunningAgent | null = null;

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

async function seedInit(extraArgs: string[] = []): Promise<void> {
  const r = await capture([
    "init",
    `--dir=${tmp}`,
    "--host=127.0.0.1",
    "--port=59996",
    "--san=127.0.0.1,localhost",
    "--json",
    ...extraArgs,
  ]);
  expect(r.code).toBe(0);
}

function parseReport(out: string): AgentStatusReport {
  return JSON.parse(out) as AgentStatusReport;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-agent-status-"));
});

afterEach(async () => {
  if (agent) {
    await agent.stop();
    agent = null;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("agent status", () => {
  test("--json with nothing listening: one JSON line, running false, loopback flagged", async () => {
    await seedInit();
    const r = await capture(["status", `--dir=${tmp}`, "--json"]);
    expect(r.code).toBe(0);
    expect(r.out.trimEnd().split("\n")).toHaveLength(1);
    const rep = parseReport(r.out);
    expect(rep.running).toBe(false);
    expect(rep.probeUrl).toBe("https://127.0.0.1:59996/healthz");
    expect(rep.loopbackOnly).toBe(true);
    const cert = rep.cert as { sans: string[]; notAfter: string; expired: boolean };
    expect(cert.sans).toContain("127.0.0.1");
    expect(cert.sans).toContain("localhost");
    expect(cert.expired).toBe(false);
    expect(rep.warnings.some((w) => w.includes("loopback"))).toBe(true);
    expect(rep.nodeName).toBeTypeOf("string");
    expect(rep.bind).toBe("127.0.0.1:59996");
    expect(rep.fingerprint).toStartWith("sha256:");
    expect(rep.configPath).toBe(join(tmp, "agent.yaml"));
    expect(rep.certPath).toContain("agent.crt");
    expect(rep.keyPath).toContain("agent.key");
  });

  test("--json reports running true against a live agent", async () => {
    await seedInit();
    const cfgPath = join(tmp, "agent.yaml");
    const cfg = agentConfigMod.loadAgentConfig(cfgPath);
    agent = startAgentServer({
      bindHost: "127.0.0.1",
      port: 0,
      tokenHash: cfg.tokenHash,
      tls: { certPath: cfg.certPath, keyPath: cfg.keyPath },
      advertiseMdns: false,
    });
    try {
      agentConfigMod.saveAgentConfig({ ...cfg, port: agent.port }, cfgPath);
      const r = await capture(["status", `--dir=${tmp}`, "--json"]);
      expect(r.code).toBe(0);
      expect(parseReport(r.out).running).toBe(true);
    } finally {
      await agent.stop();
      agent = null;
    }
  });

  test("--host reports SAN coverage of the advertised host", async () => {
    await seedInit();
    const miss = await capture(["status", `--dir=${tmp}`, "--host=192.168.68.139", "--json"]);
    expect(miss.code).toBe(0);
    const missRep = parseReport(miss.out);
    expect(missRep.advertisedHost).toBe("192.168.68.139");
    expect(missRep.advertisedHostCovered).toBe(false);
    expect(missRep.warnings.some((w) => w.includes("192.168.68.139"))).toBe(true);

    const hit = await capture(["status", `--dir=${tmp}`, "--host=localhost", "--json"]);
    expect(hit.code).toBe(0);
    const hitRep = parseReport(hit.out);
    expect(hitRep.advertisedHost).toBe("localhost");
    expect(hitRep.advertisedHostCovered).toBe(true);

    const none = await capture(["status", `--dir=${tmp}`, "--json"]);
    const noneRep = parseReport(none.out);
    expect(noneRep.advertisedHost).toBeNull();
    expect(noneRep.advertisedHostCovered).toBeNull();
  });

  test("--bind=0.0.0.0 is not loopback-only and probes on 127.0.0.1", async () => {
    await seedInit(["--bind=0.0.0.0"]);
    const r = await capture(["status", `--dir=${tmp}`, "--json"]);
    expect(r.code).toBe(0);
    const rep = parseReport(r.out);
    expect(rep.loopbackOnly).toBe(false);
    expect(rep.warnings.some((w) => w.includes("loopback"))).toBe(false);
    expect(rep.probeUrl).toContain("127.0.0.1");
  });

  test("unreadable cert degrades to cert.error + a warning, still exit 0", async () => {
    await seedInit();
    unlinkSync(join(tmp, "agent.crt"));
    const r = await capture(["status", `--dir=${tmp}`, "--json"]);
    expect(r.code).toBe(0);
    const rep = parseReport(r.out);
    expect("error" in rep.cert).toBe(true);
    expect(rep.warnings.length).toBeGreaterThan(0);
  });

  test("unknown flag exits 1", async () => {
    await seedInit();
    const r = await capture(["status", "--bogus"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("bogus");
  });
});

describe("isLoopbackHost", () => {
  for (const host of ["127.0.0.1", "127.1.2.3", "::1", "localhost"]) {
    test(`${host} is loopback`, () => {
      expect(isLoopbackHost(host)).toBe(true);
    });
  }
  for (const host of ["0.0.0.0", "::", "192.168.1.5"]) {
    test(`${host} is not loopback`, () => {
      expect(isLoopbackHost(host)).toBe(false);
    });
  }
});
