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
    expect(calls).toHaveLength(2);
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
