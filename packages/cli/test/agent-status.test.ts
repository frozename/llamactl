import {
  agentConfig as agentConfigMod,
  type RunningAgent,
  startAgentServer,
} from "@llamactl/remote";
import {
  type ModelHostManifest,
  ModelHostManifestSchema,
} from "@llamactl/remote/workload/modelhost-schema";
import { saveModelHost } from "@llamactl/remote/workload/modelhost-store";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AgentServiceStatus,
  type AgentStatusReport,
  collectAgentStatus,
  describeAgentService,
  type DescribeServiceFn,
  formatAgentStatus,
  isLoopbackHost,
  type ServiceProbeDeps,
} from "../src/commands/agent-status.js";
import { runAgent } from "../src/commands/agent.js";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "../src/safe-fs.js";

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

async function initAdvertisedHost(): Promise<void> {
  const r = await capture([
    "init",
    `--dir=${tmp}`,
    "--host=192.168.68.139",
    "--port=59996",
    "--san=127.0.0.1,localhost",
    "--json",
  ]);
  expect(r.code).toBe(0);
}

type LoadedAgentConfig = ReturnType<typeof agentConfigMod.loadAgentConfig>;

function advertisedHostOf(cfg: LoadedAgentConfig): unknown {
  return (cfg as { advertisedHost?: unknown }).advertisedHost;
}

function parseReport(out: string): AgentStatusReport {
  return JSON.parse(out) as AgentStatusReport;
}

const SERVICE_KEYS = ["active", "loaded", "manager", "name", "pid"];
const LEAK_MARKER = "leak-marker-6d1f";
const NODE_AGENT: AgentServiceStatus = {
  manager: "launchd",
  name: "com.llamactl.node-agent",
  loaded: true,
  active: true,
  pid: 4242,
};
const SYSTEMD_SERVICE_KEYS = ["active", "linger", "loaded", "manager", "name", "pid"];
const SYSTEMD_AGENT: AgentServiceStatus = {
  manager: "systemd",
  name: "llamactl-agent.service",
  loaded: true,
  active: true,
  pid: 777,
  linger: false,
};
const LINGER_ARGV = ["loginctl", "show-user", "501", "--property=Linger", "--value"];

async function statusWithService(describeService?: DescribeServiceFn): Promise<AgentStatusReport> {
  await seedInit();
  const cfgPath = join(tmp, "agent.yaml");
  const cfg = agentConfigMod.loadAgentConfig(cfgPath);
  return await collectAgentStatus({
    configPath: cfgPath,
    cfg,
    probe: () => Promise.resolve(false),
    listModelHosts: () => [],
    ...(describeService === undefined ? {} : { describeService }),
  });
}

function launchctlPrint(label: string, pid: number): string {
  return [
    `gui/501/${label} = {`,
    "\tstate = running",
    "\targuments = {",
    "\t\t/opt/bun",
    "\t\tagent",
    "\t\tserve",
    "\t}",
    "\tenvironment = {",
    `\t\tLLAMACTL_TUNNEL_BEARER => ${LEAK_MARKER}`,
    "\t}",
    `\tpid = ${String(pid)}`,
    "}",
  ].join("\n");
}

function fakeLaunchctl(
  loaded: Record<string, string>,
  calls: string[][],
): ServiceProbeDeps["exec"] {
  return (argv) => {
    calls.push([...argv]);
    const label = (argv[2] ?? "").split("/").pop() ?? "";
    const stdout = loaded[label];
    return Promise.resolve(
      stdout === undefined
        ? { code: 113, stdout: "", stderr: "Could not find service" }
        : { code: 0, stdout, stderr: "" },
    );
  };
}

function serviceDeps(platform: NodeJS.Platform, exec: ServiceProbeDeps["exec"]): ServiceProbeDeps {
  return { platform, exec, readFile: () => null, uid: 501, env: {} };
}

function fakeSystemd(
  linger: { code: number; stdout: string } | "throw",
  calls: string[][],
): ServiceProbeDeps["exec"] {
  return (argv) => {
    calls.push([...argv]);
    if (argv[0] === "loginctl") {
      return linger === "throw"
        ? Promise.reject(new Error("loginctl not found"))
        : Promise.resolve({ code: linger.code, stdout: linger.stdout, stderr: "" });
    }
    const stdout =
      argv[2] === "show"
        ? "Id=llamactl-agent.service\nLoadState=loaded\nActiveState=active\nMainPID=777\n"
        : "";
    return Promise.resolve({ code: 0, stdout, stderr: "" });
  };
}

function modelHost(
  name: string,
  opts: {
    host: string;
    port?: number;
    node?: string;
    enabled?: boolean;
    allowExternalBind?: boolean;
    extraArgs?: string[];
  },
): ModelHostManifest {
  return ModelHostManifestSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name },
    spec: {
      engine: "llamacpp",
      node: opts.node ?? "local",
      enabled: opts.enabled ?? true,
      binary: "/usr/bin/false",
      endpoint: { host: opts.host, port: opts.port ?? 8080 },
      hostedModels: [{ rel: "org/model.gguf" }],
      ...(opts.extraArgs !== undefined ? { extraArgs: opts.extraArgs } : {}),
      ...(opts.allowExternalBind !== undefined
        ? { allowExternalBind: opts.allowExternalBind }
        : {}),
    },
  });
}

async function statusWithModelHosts(
  listModelHosts: () => ModelHostManifest[],
  nodeName?: string,
): Promise<AgentStatusReport> {
  await seedInit();
  const cfgPath = join(tmp, "agent.yaml");
  const loaded = agentConfigMod.loadAgentConfig(cfgPath);
  const cfg = nodeName === undefined ? loaded : { ...loaded, nodeName };
  return await collectAgentStatus({
    configPath: cfgPath,
    cfg,
    probe: () => Promise.resolve(false),
    listModelHosts,
  });
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
    expect(rep.listenerPid).toBeNull();
    expect(Object.keys(rep)).toContain("service");
    if (process.platform === "linux") {
      expect(rep.service).not.toBeNull();
      expect(Object.keys(rep.service ?? {}).sort()).toEqual(SYSTEMD_SERVICE_KEYS);
      expect(rep.service?.linger).not.toBeUndefined();
    } else if (process.platform === "darwin") {
      expect(rep.service).not.toBeNull();
      expect(Object.keys(rep.service ?? {}).sort()).toEqual(SERVICE_KEYS);
    }
    expect(rep.probeUrl).toBe("https://127.0.0.1:59996/healthz");
    expect(rep.loopbackOnly).toBe(true);
    expect(Array.isArray(rep.exposedModelHosts)).toBe(true);
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
    const agentPort = agent.port;
    try {
      agentConfigMod.saveAgentConfig({ ...cfg, port: agentPort }, cfgPath);
      const r = await capture(["status", `--dir=${tmp}`, "--json"]);
      expect(r.code).toBe(0);
      const rep = parseReport(r.out);
      expect(rep.running).toBe(true);
      // #211: runStatus must wire the production listener-address lookup.
      expect("listenAddresses" in rep).toBe(true);
      if (existsSync("/usr/sbin/lsof") || existsSync("/usr/bin/lsof")) {
        expect(rep.listenAddresses).toContain(`127.0.0.1:${String(agentPort)}`);
      }
      expect(rep.warnings.some((w) => w.startsWith("agent listens on"))).toBe(false);
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
    expect(noneRep.advertisedHost).toBe("127.0.0.1");
    expect(noneRep.advertisedHostCovered).toBe(true);

    const cfgPath = join(tmp, "agent.yaml");
    const legacy = { ...agentConfigMod.loadAgentConfig(cfgPath) };
    Reflect.deleteProperty(legacy, "advertisedHost");
    agentConfigMod.saveAgentConfig(legacy, cfgPath);

    const legacyStatus = await capture(["status", `--dir=${tmp}`, "--json"]);
    expect(legacyStatus.code).toBe(0);
    const legacyRep = parseReport(legacyStatus.out);
    expect(legacyRep.advertisedHost).toBeNull();
    expect(legacyRep.advertisedHostCovered).toBeNull();
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

describe("agent status advertised host recorded in agent.yaml (#211)", () => {
  test("agent init records --host", async () => {
    await initAdvertisedHost();
    const cfgPath = join(tmp, "agent.yaml");
    const cfg = agentConfigMod.loadAgentConfig(cfgPath);
    expect(advertisedHostOf(cfg)).toBe("192.168.68.139");
    expect(readFileSync(cfgPath, "utf8")).toContain("advertisedHost: 192.168.68.139");
  });

  test("plain status checks the recorded host after rotate-cert --san drops it", async () => {
    await initAdvertisedHost();
    const rotate = await capture(["rotate-cert", `--dir=${tmp}`, "--san=127.0.0.1,localhost"]);
    expect(rotate.code).toBe(0);

    const cfgPath = join(tmp, "agent.yaml");
    const cfg = agentConfigMod.loadAgentConfig(cfgPath);
    expect(advertisedHostOf(cfg)).toBe("192.168.68.139");

    const json = await capture(["status", `--dir=${tmp}`, "--json"]);
    expect(json.code).toBe(0);
    const rep = parseReport(json.out);
    expect(rep.advertisedHost).toBe("192.168.68.139");
    expect(rep.advertisedHostCovered).toBe(false);
    expect(
      rep.warnings.some((w) => w.includes("192.168.68.139") && w.includes("do not cover")),
    ).toBe(true);

    const human = await capture(["status", `--dir=${tmp}`]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("advertised 192.168.68.139 (cert covers: no)");

    const override = await capture(["status", `--dir=${tmp}`, "--host=localhost", "--json"]);
    expect(override.code).toBe(0);
    const overrideRep = parseReport(override.out);
    expect(overrideRep.advertisedHost).toBe("localhost");
    expect(overrideRep.advertisedHostCovered).toBe(true);
  });

  test("collectAgentStatus falls back to cfg.advertisedHost; o.advertisedHost wins", async () => {
    await seedInit();
    const cfgPath = join(tmp, "agent.yaml");
    const base = agentConfigMod.loadAgentConfig(cfgPath);

    const cfgMiss = { ...base, advertisedHost: "10.9.8.7" };
    const miss = await collectAgentStatus({
      configPath: cfgPath,
      cfg: cfgMiss,
      probe: () => Promise.resolve(false),
      listModelHosts: () => [],
    });
    expect(miss.advertisedHost).toBe("10.9.8.7");
    expect(miss.advertisedHostCovered).toBe(false);
    expect(miss.warnings.some((w) => w.includes("10.9.8.7"))).toBe(true);

    const cfgHit = { ...base, advertisedHost: "localhost" };
    const hit = await collectAgentStatus({
      configPath: cfgPath,
      cfg: cfgHit,
      probe: () => Promise.resolve(false),
      listModelHosts: () => [],
    });
    expect(hit.advertisedHost).toBe("localhost");
    expect(hit.advertisedHostCovered).toBe(true);
    expect(hit.warnings.some((w) => w.includes("10.9.8.7"))).toBe(false);

    const cfgOverride = { ...base, advertisedHost: "10.9.8.7" };
    const override = await collectAgentStatus({
      configPath: cfgPath,
      cfg: cfgOverride,
      advertisedHost: "localhost",
      probe: () => Promise.resolve(false),
      listModelHosts: () => [],
    });
    expect(override.advertisedHost).toBe("localhost");
    expect(override.advertisedHostCovered).toBe(true);
    expect(override.warnings.some((w) => w.includes("10.9.8.7"))).toBe(false);
  });

  test("rotate-token without --host keeps the recorded advertisedHost", async () => {
    await initAdvertisedHost();
    const rotate = await capture(["rotate-token", `--dir=${tmp}`, "--json"]);
    expect(rotate.code).toBe(0);

    const cfgPath = join(tmp, "agent.yaml");
    const cfg = agentConfigMod.loadAgentConfig(cfgPath);
    expect(advertisedHostOf(cfg)).toBe("192.168.68.139");
  });

  test("rotate-cert --host re-advertises and the record follows", async () => {
    await initAdvertisedHost();
    const rotate = await capture([
      "rotate-cert",
      `--dir=${tmp}`,
      "--host=10.0.0.5",
      "--san=10.0.0.5",
    ]);
    expect(rotate.code).toBe(0);

    const cfgPath = join(tmp, "agent.yaml");
    const cfg = agentConfigMod.loadAgentConfig(cfgPath);
    expect(advertisedHostOf(cfg)).toBe("10.0.0.5");

    const status = await capture(["status", `--dir=${tmp}`, "--json"]);
    expect(status.code).toBe(0);
    const rep = parseReport(status.out);
    expect(rep.advertisedHost).toBe("10.0.0.5");
    expect(rep.advertisedHostCovered).toBe(true);
    expect(rep.warnings.some((w) => w.includes("do not cover"))).toBe(false);
  });

  test("rotate-token --host re-advertises and the record follows", async () => {
    await initAdvertisedHost();
    const rotate = await capture(["rotate-token", `--dir=${tmp}`, "--host=10.0.0.6", "--json"]);
    expect(rotate.code).toBe(0);

    const cfgPath = join(tmp, "agent.yaml");
    const cfg = agentConfigMod.loadAgentConfig(cfgPath);
    expect(advertisedHostOf(cfg)).toBe("10.0.0.6");

    const status = await capture(["status", `--dir=${tmp}`, "--json"]);
    expect(status.code).toBe(0);
    const rep = parseReport(status.out);
    expect(rep.advertisedHost).toBe("10.0.0.6");
    expect(rep.advertisedHostCovered).toBe(false);
  });

  test("rotate-token --host= (empty) is refused and keeps the recorded advertisedHost", async () => {
    await initAdvertisedHost();
    const cfgPath = join(tmp, "agent.yaml");
    const before = readFileSync(cfgPath, "utf8");

    const r = await capture(["rotate-token", `--dir=${tmp}`, "--host=", "--json"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--host");
    expect(r.err).toContain("requires a host");
    expect(r.out).toBe("");
    expect(readFileSync(cfgPath, "utf8")).toBe(before);
    expect(advertisedHostOf(agentConfigMod.loadAgentConfig(cfgPath))).toBe("192.168.68.139");
  });

  test("rotate-cert --host= (empty) is refused and keeps the recorded advertisedHost", async () => {
    await initAdvertisedHost();
    const cfgPath = join(tmp, "agent.yaml");
    const crtPath = join(tmp, "agent.crt");
    const cfgBefore = readFileSync(cfgPath, "utf8");
    const crtBefore = readFileSync(crtPath, "utf8");

    const r = await capture([
      "rotate-cert",
      `--dir=${tmp}`,
      "--host=",
      "--san=127.0.0.1,localhost",
      "--json",
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--host");
    expect(r.err).toContain("requires a host");
    expect(r.out).toBe("");
    expect(readFileSync(cfgPath, "utf8")).toBe(cfgBefore);
    expect(readFileSync(crtPath, "utf8")).toBe(crtBefore);
    expect(advertisedHostOf(agentConfigMod.loadAgentConfig(cfgPath))).toBe("192.168.68.139");
  });

  test.each([
    ["a number", "42"],
    ["an empty string", '""'],
    ["an object", "{ host: 10.0.0.1 }"],
  ])(
    "an invalid recorded advertisedHost (%s) is dropped on load, without a write-back",
    async (_label, yamlValue) => {
      await initAdvertisedHost();
      const cfgPath = join(tmp, "agent.yaml");
      const originalLine = "advertisedHost: 192.168.68.139";
      const text = readFileSync(cfgPath, "utf8");
      expect(text).toContain(originalLine);
      const edited = text.replace(originalLine, `advertisedHost: ${yamlValue}`);
      writeFileSync(cfgPath, edited);
      const before = edited;

      const cfg = agentConfigMod.loadAgentConfig(cfgPath);
      expect(advertisedHostOf(cfg)).toBeUndefined();
      expect(readFileSync(cfgPath, "utf8")).toBe(before);

      const s = await capture(["status", `--dir=${tmp}`, "--json"]);
      expect(s.code).toBe(0);
      expect(parseReport(s.out).advertisedHost).toBeNull();
      expect(parseReport(s.out).advertisedHostCovered).toBeNull();
      expect(readFileSync(cfgPath, "utf8")).toBe(before);
    },
  );
});

describe("agent status listener pid", () => {
  test("running agent reports the pid from the lookup on the probe host", async () => {
    await seedInit();
    const cfgPath = join(tmp, "agent.yaml");
    const cfg = agentConfigMod.loadAgentConfig(cfgPath);
    const calls: [string, number][] = [];
    const report = await collectAgentStatus({
      configPath: cfgPath,
      cfg,
      probe: () => Promise.resolve(true),
      findListenerPid: (host, port) => {
        calls.push([host, port]);
        return Promise.resolve(4242);
      },
    });
    expect(report.listenerPid).toBe(4242);
    expect(calls).toEqual([["127.0.0.1", 59996]]);
    expect(formatAgentStatus(report)).toContain(
      "running yes (https://127.0.0.1:59996/healthz) pid=4242\n",
    );
  });

  test("running agent with no resolvable pid prints pid=unknown", async () => {
    await seedInit();
    const cfgPath = join(tmp, "agent.yaml");
    const cfg = agentConfigMod.loadAgentConfig(cfgPath);
    const calls: [string, number][] = [];
    const report = await collectAgentStatus({
      configPath: cfgPath,
      cfg,
      probe: () => Promise.resolve(true),
      findListenerPid: (host, port) => {
        calls.push([host, port]);
        return Promise.resolve(null);
      },
    });
    expect(report.listenerPid).toBeNull();
    expect(calls).toEqual([["127.0.0.1", 59996]]);
    expect(formatAgentStatus(report)).toContain(
      "running yes (https://127.0.0.1:59996/healthz) pid=unknown\n",
    );
  });

  test("a rejecting lookup degrades to pid=unknown", async () => {
    await seedInit();
    const cfgPath = join(tmp, "agent.yaml");
    const cfg = agentConfigMod.loadAgentConfig(cfgPath);
    const report = await collectAgentStatus({
      configPath: cfgPath,
      cfg,
      probe: () => Promise.resolve(true),
      findListenerPid: () => Promise.reject(new Error("lsof failed")),
    });
    expect(report.listenerPid).toBeNull();
    expect(formatAgentStatus(report)).toContain(" pid=unknown\n");
  });

  test("not running never calls the lookup", async () => {
    await seedInit();
    const cfgPath = join(tmp, "agent.yaml");
    const cfg = agentConfigMod.loadAgentConfig(cfgPath);
    const calls: [string, number][] = [];
    const report = await collectAgentStatus({
      configPath: cfgPath,
      cfg,
      probe: () => Promise.resolve(false),
      findListenerPid: (host, port) => {
        calls.push([host, port]);
        return Promise.resolve(4242);
      },
    });
    expect(calls).toEqual([]);
    expect(report.listenerPid).toBeNull();
    expect(formatAgentStatus(report)).toContain("running no (https://127.0.0.1:59996/healthz)\n");
    expect(formatAgentStatus(report)).not.toContain("pid=");
  });

  test("wildcard bind looks the pid up on 127.0.0.1", async () => {
    await seedInit(["--bind=0.0.0.0"]);
    const cfgPath = join(tmp, "agent.yaml");
    const cfg = agentConfigMod.loadAgentConfig(cfgPath);
    const calls: [string, number][] = [];
    const report = await collectAgentStatus({
      configPath: cfgPath,
      cfg,
      probe: () => Promise.resolve(true),
      findListenerPid: (host, port) => {
        calls.push([host, port]);
        return Promise.resolve(7);
      },
    });
    expect(calls).toEqual([["127.0.0.1", 59996]]);
    expect(report.listenerPid).toBe(7);
  });
});

// #211: the fixed mismatch wording, verbatim — it must not prescribe a restart.
function listenWarning(addrs: string, bind: string): string {
  return `agent listens on ${addrs} but agent.yaml binds ${bind}; a --bind on the service command line, or a process started from an older agent.yaml, overrides it`;
}

function noListenWarnings(report: AgentStatusReport): void {
  expect(report.warnings.filter((w) => w.startsWith("agent listens on"))).toEqual([]);
}

// #211: drives collectAgentStatus with an injected findListenerAddresses(port,
// pid) that records its calls. `lookup: "omit"` withholds the option entirely
// (the no-lookup path).
async function statusWithListener(o: {
  bindHost?: string;
  observed?: string[];
  probe?: boolean;
  listenerPid?: number | null;
  lookup?: "record" | "reject" | "omit";
  describeService?: DescribeServiceFn;
}): Promise<{ report: AgentStatusReport; calls: [number, number][] }> {
  await seedInit();
  const cfgPath = join(tmp, "agent.yaml");
  const loaded = agentConfigMod.loadAgentConfig(cfgPath);
  const cfg = o.bindHost === undefined ? loaded : { ...loaded, bindHost: o.bindHost };
  const calls: [number, number][] = [];
  const lookup = o.lookup ?? "record";
  const opts = {
    configPath: cfgPath,
    cfg,
    probe: (): Promise<boolean> => Promise.resolve(o.probe ?? true),
    findListenerPid: (): Promise<number | null> =>
      Promise.resolve(o.listenerPid === undefined ? 4242 : o.listenerPid),
    ...(o.describeService === undefined ? {} : { describeService: o.describeService }),
    ...(lookup === "omit"
      ? {}
      : {
          findListenerAddresses: (port: number, pid: number): Promise<string[]> => {
            calls.push([port, pid]);
            return lookup === "reject"
              ? Promise.reject(new Error("lsof failed"))
              : Promise.resolve(o.observed ?? []);
          },
        }),
  };
  const report = await collectAgentStatus(opts);
  return { report, calls };
}

describe("agent status listen addresses (#211)", () => {
  test("a wildcard listener under a loopback config is flagged, with neutral wording", async () => {
    const { report, calls } = await statusWithListener({
      bindHost: "127.0.0.1",
      observed: ["*:59996"],
    });
    expect(report.listenAddresses).toEqual(["*:59996"]);
    expect(calls).toEqual([[59996, 4242]]);
    expect(report.warnings).toContain(listenWarning("*:59996", "127.0.0.1:59996"));
    expect(report.warnings.some((w) => w.includes("restart"))).toBe(false);
    const text = formatAgentStatus(report);
    expect(text).toContain("listen  *:59996\n");
    expect(text).toContain(
      "warning: agent listens on *:59996 but agent.yaml binds 127.0.0.1:59996; a --bind on the service command line",
    );
  });

  test("0.0.0.0 config with a * listener is not flagged", async () => {
    const { report } = await statusWithListener({
      bindHost: "0.0.0.0",
      observed: ["*:59996"],
    });
    expect(report.listenAddresses).toEqual(["*:59996"]);
    noListenWarnings(report);
  });

  test("0.0.0.0 config with only a loopback listener is flagged", async () => {
    const { report } = await statusWithListener({
      bindHost: "0.0.0.0",
      observed: ["127.0.0.1:59996"],
    });
    expect(report.listenAddresses).toEqual(["127.0.0.1:59996"]);
    expect(report.warnings).toContain(listenWarning("127.0.0.1:59996", "0.0.0.0:59996"));
  });

  test("IPv6 loopback config matches a bracketed listener", async () => {
    const { report } = await statusWithListener({
      bindHost: "::1",
      observed: ["[::1]:59996"],
    });
    expect(report.listenAddresses).toEqual(["[::1]:59996"]);
    noListenWarnings(report);
  });

  test("localhost config matches 127.0.0.1", async () => {
    const { report } = await statusWithListener({
      bindHost: "localhost",
      observed: ["127.0.0.1:59996"],
    });
    expect(report.listenAddresses).toEqual(["127.0.0.1:59996"]);
    noListenWarnings(report);
  });

  test("localhost config matches an IPv6 loopback listener", async () => {
    const { report } = await statusWithListener({
      bindHost: "localhost",
      observed: ["[::1]:59996"],
    });
    expect(report.listenAddresses).toEqual(["[::1]:59996"]);
    noListenWarnings(report);
  });

  test("localhost config with a wildcard listener is flagged", async () => {
    const { report } = await statusWithListener({
      bindHost: "localhost",
      observed: ["*:59996"],
    });
    expect(report.warnings).toContain(listenWarning("*:59996", "localhost:59996"));
  });

  test("a bracketed IPv6 bind host matches a bracketed listener", async () => {
    const { report } = await statusWithListener({
      bindHost: "[::1]",
      observed: ["[::1]:59996"],
    });
    expect(report.listenAddresses).toEqual(["[::1]:59996"]);
    noListenWarnings(report);
  });

  test("an expanded IPv6 bind host matches its compressed listener", async () => {
    const { report } = await statusWithListener({
      bindHost: "0:0:0:0:0:0:0:1",
      observed: ["[::1]:59996"],
    });
    expect(report.listenAddresses).toEqual(["[::1]:59996"]);
    noListenWarnings(report);
  });

  test("an expanded IPv6 listener matches its compressed bind host", async () => {
    const { report } = await statusWithListener({
      bindHost: "::1",
      observed: ["[0:0:0:0:0:0:0:1]:59996"],
    });
    expect(report.listenAddresses).toEqual(["[0:0:0:0:0:0:0:1]:59996"]);
    noListenWarnings(report);
  });

  test("a zone-scoped IPv6 bind host matches its listener without throwing", async () => {
    const { report } = await statusWithListener({
      bindHost: "fe80::1%en0",
      observed: ["[fe80::1%en0]:59996"],
    });
    expect(report.listenAddresses).toEqual(["[fe80::1%en0]:59996"]);
    noListenWarnings(report);
  });

  test("a wildcard bind host with a zone-scoped listener is flagged without throwing", async () => {
    const { report } = await statusWithListener({
      bindHost: "::",
      observed: ["[fe80::1%en0]:59996"],
    });
    expect(report.warnings).toContain(listenWarning("[fe80::1%en0]:59996", ":::59996"));
  });

  test("an uppercase, expanded zone-scoped bind host matches its listener", async () => {
    const { report } = await statusWithListener({
      bindHost: "FE80:0:0:0:0:0:0:1%EN0",
      observed: ["[fe80::1%en0]:59996"],
    });
    noListenWarnings(report);
  });

  test("an uppercase localhost bind host matches a loopback listener", async () => {
    const { report } = await statusWithListener({
      bindHost: "LOCALHOST",
      observed: ["127.0.0.1:59996"],
    });
    noListenWarnings(report);
  });

  test("a zone-scoped IPv6 bind host does not match the same address on another zone", async () => {
    const { report } = await statusWithListener({
      bindHost: "fe80::1%en0",
      observed: ["[fe80::1%en1]:59996"],
    });
    expect(report.warnings).toContain(listenWarning("[fe80::1%en1]:59996", "fe80::1%en0:59996"));
  });

  test("one matching address among several suppresses the mismatch warning", async () => {
    const { report } = await statusWithListener({
      bindHost: "127.0.0.1",
      observed: ["127.0.0.1:59996", "[::1]:59996"],
    });
    expect(report.listenAddresses).toEqual(["127.0.0.1:59996", "[::1]:59996"]);
    noListenWarnings(report);
  });

  // An empty bindHost binds every interface, like 0.0.0.0: it is compared, and
  // only a `*` listener satisfies it.
  test("an empty bind host with a * listener is not flagged", async () => {
    const { report } = await statusWithListener({
      bindHost: "",
      observed: ["*:59996"],
    });
    expect(report.listenAddresses).toEqual(["*:59996"]);
    noListenWarnings(report);
  });

  test("an empty bind host with only a loopback listener is flagged", async () => {
    const { report } = await statusWithListener({
      bindHost: "",
      observed: ["127.0.0.1:59996"],
    });
    expect(report.warnings).toContain(listenWarning("127.0.0.1:59996", ":59996"));
  });

  test("a DNS-name bind host is never compared (lsof -n prints numeric addresses)", async () => {
    const { report } = await statusWithListener({
      bindHost: "agent.example.test",
      observed: ["10.0.0.5:59996"],
    });
    expect(report.listenAddresses).toEqual(["10.0.0.5:59996"]);
    noListenWarnings(report);
  });

  test("a known service pid that differs from the listener pid suppresses the mismatch warning", async () => {
    const { report } = await statusWithListener({
      bindHost: "127.0.0.1",
      observed: ["*:59996"],
      describeService: () =>
        Promise.resolve({ manager: "launchd", name: "x", loaded: true, active: true, pid: 9999 }),
    });
    expect(report.listenAddresses).toEqual(["*:59996"]);
    noListenWarnings(report);
  });

  test("a service pid matching the listener pid keeps the mismatch warning", async () => {
    const { report } = await statusWithListener({
      bindHost: "127.0.0.1",
      observed: ["*:59996"],
      describeService: () =>
        Promise.resolve({ manager: "launchd", name: "x", loaded: true, active: true, pid: 4242 }),
    });
    expect(report.warnings).toContain(listenWarning("*:59996", "127.0.0.1:59996"));
  });

  test("not running never calls the address lookup", async () => {
    const down = await statusWithListener({ probe: false, observed: ["*:59996"] });
    expect(down.calls).toEqual([]);
    expect(down.report.listenAddresses).toBeNull();
    expect(formatAgentStatus(down.report)).not.toContain("listen  ");
  });

  test("no listener pid never calls the address lookup", async () => {
    const noPid = await statusWithListener({ listenerPid: null, observed: ["*:59996"] });
    expect(noPid.calls).toEqual([]);
    expect(noPid.report.listenAddresses).toBeNull();
    expect(formatAgentStatus(noPid.report)).not.toContain("listen  ");
  });

  test("a rejecting address lookup degrades to null with no listen warning", async () => {
    const { report } = await statusWithListener({ observed: ["*:59996"], lookup: "reject" });
    expect(report.listenAddresses).toBeNull();
    noListenWarnings(report);
  });

  test("no injected lookup means no lookup", async () => {
    const { report } = await statusWithListener({ observed: ["*:59996"], lookup: "omit" });
    expect(report.listenAddresses).toBeNull();
  });
});

describe("agent status exposed ModelHost binds", () => {
  test("flags an enabled local ModelHost bound to 0.0.0.0", async () => {
    const report = await statusWithModelHosts(() => [
      modelHost("exposed", { host: "0.0.0.0", allowExternalBind: true }),
      modelHost("loopback", { host: "127.0.0.1" }),
    ]);
    expect(report.exposedModelHosts).toEqual([
      { name: "exposed", bind: "0.0.0.0:8080", allowExternalBind: true },
    ]);
    expect(report.warnings).toContain(
      "modelhost/exposed binds an unauthenticated engine to 0.0.0.0:8080 (spec.allowExternalBind: true)",
    );
    expect(report.warnings.some((w) => w.includes("modelhost/loopback"))).toBe(false);
    expect(formatAgentStatus(report)).toContain(
      "warning: modelhost/exposed binds an unauthenticated engine to 0.0.0.0:8080 (spec.allowExternalBind: true)\n",
    );
  });

  test("an exposed bind without allowExternalBind says its next start is refused", async () => {
    const report = await statusWithModelHosts(() => [
      modelHost("lan", { host: "192.168.1.5", port: 9000 }),
    ]);
    expect(report.exposedModelHosts).toEqual([
      { name: "lan", bind: "192.168.1.5:9000", allowExternalBind: false },
    ]);
    expect(report.warnings).toContain(
      "modelhost/lan binds an unauthenticated engine to 192.168.1.5:9000; spec.allowExternalBind is not true, so its next start is refused",
    );
  });

  test("catches --host in extraArgs and brackets an IPv6 bind", async () => {
    const report = await statusWithModelHosts(() => [
      modelHost("argv", { host: "127.0.0.1", extraArgs: ["--host", "0.0.0.0"] }),
      modelHost("v6", { host: "::", port: 8081 }),
    ]);
    expect(report.exposedModelHosts).toEqual([
      { name: "argv", bind: "0.0.0.0:8080", allowExternalBind: false },
      { name: "v6", bind: "[::]:8081", allowExternalBind: false },
    ]);
  });

  test("skips disabled hosts and other nodes, keeps the agent's own node name", async () => {
    const report = await statusWithModelHosts(
      () => [
        modelHost("off", { host: "0.0.0.0", enabled: false }),
        modelHost("other", { host: "0.0.0.0", node: "mini" }),
        modelHost("named", { host: "0.0.0.0", node: "studio" }),
      ],
      "studio",
    );
    expect(report.exposedModelHosts).toEqual([
      { name: "named", bind: "0.0.0.0:8080", allowExternalBind: false },
    ]);
    expect(
      report.warnings.some((w) => w.includes("modelhost/off") || w.includes("modelhost/other")),
    ).toBe(false);
  });

  test("a failing ModelHost read reports none", async () => {
    const report = await statusWithModelHosts(() => {
      throw new Error("workloads dir unreadable");
    });
    expect(report.exposedModelHosts).toEqual([]);
    expect(report.warnings.some((w) => w.includes("modelhost/"))).toBe(false);
  });

  test("status --json reads exposed ModelHosts from the workloads dir", async () => {
    await seedInit();
    const dir = join(tmp, "workloads");
    saveModelHost(modelHost("exposed", { host: "0.0.0.0", allowExternalBind: true }), dir);
    const prev = process.env["LLAMACTL_WORKLOADS_DIR"];
    process.env["LLAMACTL_WORKLOADS_DIR"] = dir;
    try {
      const r = await capture(["status", `--dir=${tmp}`, "--json"]);
      expect(r.code).toBe(0);
      expect(r.out.trimEnd().split("\n")).toHaveLength(1);
      expect(parseReport(r.out).exposedModelHosts).toEqual([
        { name: "exposed", bind: "0.0.0.0:8080", allowExternalBind: true },
      ]);
    } finally {
      if (prev === undefined) {
        Reflect.deleteProperty(process.env, "LLAMACTL_WORKLOADS_DIR");
      } else {
        process.env["LLAMACTL_WORKLOADS_DIR"] = prev;
      }
    }
  });
});

describe("agent status service manager", () => {
  test("describeService result lands in the report and on the human service line", async () => {
    const report = await statusWithService(() => Promise.resolve(NODE_AGENT));
    expect(report.service).toEqual(NODE_AGENT);
    const text = formatAgentStatus(report);
    expect(text).toContain("\nservice launchd com.llamactl.node-agent (loaded, active) pid=4242\n");
    expect(text).toContain("(https://127.0.0.1:59996/healthz)\nservice launchd");
    expect(JSON.stringify(report)).not.toMatch(/"(?:env|argv)":/);
    expect(text).not.toContain("linger=");
  });

  test("a describer that returns extra fields is cut to the five whitelisted keys", async () => {
    const leaky = {
      ...NODE_AGENT,
      env: { LLAMACTL_TUNNEL_BEARER: LEAK_MARKER },
      argv: ["/opt/bun", LEAK_MARKER],
    };
    const report = await statusWithService(() => Promise.resolve(leaky));
    expect(Object.keys(report.service ?? {}).sort()).toEqual(SERVICE_KEYS);
    expect(JSON.stringify(report)).not.toContain(LEAK_MARKER);
    expect(formatAgentStatus(report)).not.toContain(LEAK_MARKER);
  });

  test("not loaded and loaded-inactive units render without a pid", async () => {
    const report = await statusWithService(() => Promise.resolve(NODE_AGENT));
    expect(
      formatAgentStatus({
        ...report,
        service: {
          manager: "systemd",
          name: "llamactl-agent.service",
          loaded: false,
          active: false,
          pid: null,
        },
      }),
    ).toContain("\nservice systemd llamactl-agent.service (not loaded)\n");
    expect(
      formatAgentStatus({
        ...report,
        service: {
          manager: "systemd",
          name: "llamactl-agent.service",
          loaded: true,
          active: false,
          pid: null,
        },
      }),
    ).toContain("\nservice systemd llamactl-agent.service (loaded, inactive)\n");
  });

  test("a rejecting describer degrades to service null", async () => {
    const report = await statusWithService(() => Promise.reject(new Error("launchctl failed")));
    expect(report.service).toBeNull();
    expect(formatAgentStatus(report)).not.toContain("\nservice ");
  });

  test("no describer reports service null and prints no service line", async () => {
    const report = await statusWithService();
    expect(report.service).toBeNull();
    expect(formatAgentStatus(report)).not.toContain("\nservice ");
  });

  test("systemd linger renders on the service line and in --json", async () => {
    const report = await statusWithService(() => Promise.resolve(SYSTEMD_AGENT));
    expect(report.service?.linger).toBe(false);
    expect((JSON.parse(JSON.stringify(report)) as AgentStatusReport).service?.linger).toBe(false);
    expect(formatAgentStatus(report)).toContain(
      "\nservice systemd llamactl-agent.service (loaded, active) pid=777 linger=no\n",
    );
    expect(formatAgentStatus({ ...report, service: { ...SYSTEMD_AGENT, linger: true } })).toContain(
      "\nservice systemd llamactl-agent.service (loaded, active) pid=777 linger=yes\n",
    );
    expect(formatAgentStatus({ ...report, service: { ...SYSTEMD_AGENT, linger: null } })).toContain(
      "\nservice systemd llamactl-agent.service (loaded, active) pid=777 linger=unknown\n",
    );
    expect(
      formatAgentStatus({
        ...report,
        service: { ...SYSTEMD_AGENT, loaded: false, active: false, pid: null },
      }),
    ).toContain("\nservice systemd llamactl-agent.service (not loaded) linger=no\n");
  });

  test("a systemd describer that returns extra fields is cut to the six named keys", async () => {
    const leaky = {
      ...SYSTEMD_AGENT,
      env: { LLAMACTL_TUNNEL_BEARER: LEAK_MARKER },
      argv: ["/opt/bun", LEAK_MARKER],
    };
    const report = await statusWithService(() => Promise.resolve(leaky));
    expect(Object.keys(report.service ?? {}).sort()).toEqual(SYSTEMD_SERVICE_KEYS);
    expect(report.service?.linger).toBe(false);
    expect(JSON.stringify(report)).not.toContain(LEAK_MARKER);
    expect(formatAgentStatus(report)).not.toContain(LEAK_MARKER);
  });

  test("a system-scope service keeps scope in --json and renders (system, loaded, active)", async () => {
    const scoped = {
      manager: "launchd",
      name: "com.llamactl.agent.daemon",
      loaded: true,
      active: true,
      pid: 31,
      scope: "system",
      env: { LLAMACTL_TUNNEL_BEARER: LEAK_MARKER },
    } as AgentServiceStatus;
    const report = await statusWithService(() => Promise.resolve(scoped));
    expect(report.service).toEqual({
      manager: "launchd",
      name: "com.llamactl.agent.daemon",
      loaded: true,
      active: true,
      pid: 31,
      scope: "system",
    } as AgentServiceStatus);
    const text = formatAgentStatus(report);
    expect(text).toContain(
      "\nservice launchd com.llamactl.agent.daemon (system, loaded, active) pid=31\n",
    );
    expect(JSON.stringify(report)).not.toContain(LEAK_MARKER);
    expect(text).not.toContain(LEAK_MARKER);

    // Only "system" survives the whitelist: a bogus scope is dropped like env/argv.
    const cfgPath = join(tmp, "agent.yaml");
    const cfg = agentConfigMod.loadAgentConfig(cfgPath);
    const bogus = { ...scoped, scope: "bogus" } as unknown as AgentServiceStatus;
    const bogusReport = await collectAgentStatus({
      configPath: cfgPath,
      cfg,
      probe: () => Promise.resolve(false),
      listModelHosts: () => [],
      describeService: () => Promise.resolve(bogus),
    });
    expect(bogusReport.service?.name).toBe("com.llamactl.agent.daemon");
    expect(Object.keys(bogusReport.service ?? {})).not.toContain("scope");
    const bogusText = formatAgentStatus(bogusReport);
    expect(bogusText).toContain("(loaded, active)");
    expect(bogusText).not.toContain("(bogus");
  });
});

describe("describeAgentService", () => {
  test("launchd falls back to com.llamactl.node-agent and drops env and argv", async () => {
    const calls: string[][] = [];
    const s = await describeAgentService(
      serviceDeps(
        "darwin",
        fakeLaunchctl(
          { "com.llamactl.node-agent": launchctlPrint("com.llamactl.node-agent", 4242) },
          calls,
        ),
      ),
    );
    expect(s).toEqual(NODE_AGENT);
    expect(Object.keys(s ?? {}).sort()).toEqual(SERVICE_KEYS);
    expect(JSON.stringify(s)).not.toContain(LEAK_MARKER);
    expect(calls).toEqual([
      ["launchctl", "print", "gui/501/com.llamactl.agent"],
      ["launchctl", "print", "gui/501/com.llamactl.node-agent"],
    ]);
  });

  test("launchd uses a loaded default label without a fallback lookup", async () => {
    const calls: string[][] = [];
    const s = await describeAgentService(
      serviceDeps(
        "darwin",
        fakeLaunchctl({ "com.llamactl.agent": launchctlPrint("com.llamactl.agent", 99) }, calls),
      ),
    );
    expect(s).toEqual({
      manager: "launchd",
      name: "com.llamactl.agent",
      loaded: true,
      active: true,
      pid: 99,
    });
    expect(calls).toEqual([["launchctl", "print", "gui/501/com.llamactl.agent"]]);
  });

  test("launchd with nothing loaded reports the default label as not loaded", async () => {
    const calls: string[][] = [];
    const s = await describeAgentService(serviceDeps("darwin", fakeLaunchctl({}, calls)));
    expect(s).toEqual({
      manager: "launchd",
      name: "com.llamactl.agent",
      loaded: false,
      active: false,
      pid: null,
    });
    expect(calls).toEqual([
      ["launchctl", "print", "gui/501/com.llamactl.agent"],
      ["launchctl", "print", "gui/501/com.llamactl.node-agent"],
      ["launchctl", "print", "system/com.llamactl.agent.daemon"],
    ]);
  });

  test("systemd describes llamactl-agent.service in the user scope and drops its env", async () => {
    const calls: string[][] = [];
    const exec: ServiceProbeDeps["exec"] = (argv) => {
      calls.push([...argv]);
      const stdout =
        argv[2] === "show"
          ? `Id=llamactl-agent.service\nLoadState=loaded\nActiveState=active\nMainPID=777\nEnvironment=LLAMACTL_TUNNEL_BEARER=${LEAK_MARKER}\n`
          : "";
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    };
    const s = await describeAgentService(serviceDeps("linux", exec));
    expect(s).toEqual({
      manager: "systemd",
      name: "llamactl-agent.service",
      loaded: true,
      active: true,
      pid: 777,
      linger: null,
    });
    expect(JSON.stringify(s)).not.toContain(LEAK_MARKER);
    expect(calls.map((c) => c.slice(0, 4))).toEqual([
      ["systemctl", "--user", "show", "llamactl-agent.service"],
      ["systemctl", "--user", "cat", "llamactl-agent.service"],
      ["loginctl", "show-user", "501", "--property=Linger"],
    ]);
  });

  test("systemd reports linger from loginctl show-user for the uid", async () => {
    const calls: string[][] = [];
    const yes = await describeAgentService(
      serviceDeps("linux", fakeSystemd({ code: 0, stdout: "yes\n" }, calls)),
    );
    expect(yes?.linger).toBe(true);
    expect(Object.keys(yes ?? {}).sort()).toEqual(SYSTEMD_SERVICE_KEYS);
    expect(calls.at(-1)).toEqual(LINGER_ARGV);
    const no = await describeAgentService(
      serviceDeps("linux", fakeSystemd({ code: 0, stdout: "no\n" }, [])),
    );
    expect(no).toEqual(SYSTEMD_AGENT);
  });

  test("a failing, throwing or unrecognised loginctl gives linger null", async () => {
    const answers: ({ code: number; stdout: string } | "throw")[] = [
      { code: 1, stdout: "" },
      { code: 1, stdout: "yes\n" },
      "throw",
      { code: 0, stdout: "" },
      { code: 0, stdout: "Linger=yes\n" },
    ];
    const results = await Promise.all(
      answers.map(
        async (a) => await describeAgentService(serviceDeps("linux", fakeSystemd(a, []))),
      ),
    );
    for (const s of results) {
      expect(s?.linger).toBeNull();
      expect(s?.loaded).toBe(true);
    }
  });

  test("launchd never runs loginctl and has no linger key", async () => {
    const calls: string[][] = [];
    const s = await describeAgentService(serviceDeps("darwin", fakeLaunchctl({}, calls)));
    expect(calls.some((c) => c[0] === "loginctl")).toBe(false);
    expect("linger" in (s ?? {})).toBe(false);
    expect(Object.keys(s ?? {}).sort()).toEqual(SERVICE_KEYS);
  });

  test("an unsupported platform returns null and runs nothing", async () => {
    const calls: string[][] = [];
    const exec: ServiceProbeDeps["exec"] = (argv) => {
      calls.push([...argv]);
      return Promise.reject(new Error("must not exec"));
    };
    const s = await describeAgentService(serviceDeps("win32", exec));
    expect(s).toBeNull();
    expect(calls).toEqual([]);
  });

  test("launchd falls back to the system-domain com.llamactl.agent.daemon when no gui label is loaded", async () => {
    const calls: string[][] = [];
    const s = await describeAgentService(
      serviceDeps(
        "darwin",
        fakeLaunchctl(
          { "com.llamactl.agent.daemon": launchctlPrint("com.llamactl.agent.daemon", 31) },
          calls,
        ),
      ),
    );
    expect(s).toEqual({
      manager: "launchd",
      name: "com.llamactl.agent.daemon",
      loaded: true,
      active: true,
      pid: 31,
      scope: "system",
    } as AgentServiceStatus);
    expect(calls).toEqual([
      ["launchctl", "print", "gui/501/com.llamactl.agent"],
      ["launchctl", "print", "gui/501/com.llamactl.node-agent"],
      ["launchctl", "print", "system/com.llamactl.agent.daemon"],
    ]);
    expect(JSON.stringify(s)).not.toContain(LEAK_MARKER);
  });

  test("systemd falls back to the system unit when the --user unit is not loaded, without reading linger", async () => {
    const calls: string[][] = [];
    const exec: ServiceProbeDeps["exec"] = (argv) => {
      calls.push([...argv]);
      if (argv[1] === "--user" && argv[2] === "show") {
        return Promise.resolve({
          code: 0,
          stdout:
            "Id=llamactl-agent.service\nLoadState=not-found\nActiveState=inactive\nMainPID=0\n",
          stderr: "",
        });
      }
      if (argv[1] === "show") {
        return Promise.resolve({
          code: 0,
          stdout: `Id=llamactl-agent.service\nLoadState=loaded\nActiveState=active\nMainPID=888\nEnvironment=LLAMACTL_TUNNEL_BEARER=${LEAK_MARKER}\n`,
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const s = await describeAgentService(serviceDeps("linux", exec));
    expect(s).toEqual({
      manager: "systemd",
      name: "llamactl-agent.service",
      loaded: true,
      active: true,
      pid: 888,
      scope: "system",
    } as AgentServiceStatus);
    expect(calls.some((c) => c[0] === "loginctl")).toBe(false);
    expect(calls.map((c) => c.slice(0, 3))).toEqual([
      ["systemctl", "--user", "show"],
      ["systemctl", "show", "llamactl-agent.service"],
      ["systemctl", "cat", "llamactl-agent.service"],
    ]);
    expect(JSON.stringify(s)).not.toContain(LEAK_MARKER);
  });

  test("systemd with neither scope loaded reports the user unit as not loaded and still reads linger", async () => {
    const calls: string[][] = [];
    const notFound =
      "Id=llamactl-agent.service\nLoadState=not-found\nActiveState=inactive\nMainPID=0\n";
    const exec: ServiceProbeDeps["exec"] = (argv) => {
      calls.push([...argv]);
      if (argv[0] === "loginctl") {
        return Promise.resolve({ code: 0, stdout: "yes\n", stderr: "" });
      }
      if (argv[1] === "--user" && argv[2] === "show") {
        return Promise.resolve({ code: 0, stdout: notFound, stderr: "" });
      }
      if (argv[1] === "show") {
        return Promise.resolve({ code: 0, stdout: notFound, stderr: "" });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const s = await describeAgentService(serviceDeps("linux", exec));
    expect(s).toEqual({
      manager: "systemd",
      name: "llamactl-agent.service",
      loaded: false,
      active: false,
      pid: null,
      linger: true,
    });
    expect(calls.map((c) => c.slice(0, 3))).toEqual([
      ["systemctl", "--user", "show"],
      ["systemctl", "show", "llamactl-agent.service"],
      ["loginctl", "show-user", "501"],
    ]);
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
