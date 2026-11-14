// RED for frozename/llamactl#289: agent migrate-tunnel-bearer
//
// `llamactl agent migrate-tunnel-bearer <unit-path> [--dir=<path>]
// [--write]` moves LLAMACTL_TUNNEL_BEARER / LLAMACTL_TUNNEL_CENTRAL_BEARER
// out of a launchd plist or systemd unit into a 0600 bearer file inside
// the agent dir the unit itself names, then prints the reload hint.
// Dry-run by default; --write applies. The agent dir comes from the
// unit's own env/args, never the operator's shell env.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSystemdUnit } from "../src/commands/agent-install/systemd-template.js";
import { buildSystemPlist, buildUserPlist } from "../src/commands/agent-install/templates.js";
import { runAgent } from "../src/commands/agent.js";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "../src/safe-fs.js";
import { captureProcessStreams } from "./helpers.js";

const TOKEN = "fixture-bearer-289-DO-NOT-ECHO";
const CENTRAL = "fixture-central-289-DO-NOT-ECHO";
// Bearers whose unit spelling differs from the value: systemd's %% escape
// and XML entities in a plist. Both spellings must stay out of output.
const PCT_TOKEN = "fixture-pct-289-%-DO-NOT-ECHO";
const PCT_TOKEN_UNIT = "fixture-pct-289-%%-DO-NOT-ECHO";
const XML_TOKEN = "fixture-xml-289-&-<-&lt;-DO-NOT-ECHO";
const XML_TOKEN_PLIST = "fixture-xml-289-&amp;-&lt;-&amp;lt;-DO-NOT-ECHO";
const SECRETS = [TOKEN, CENTRAL, PCT_TOKEN, PCT_TOKEN_UNIT, XML_TOKEN, XML_TOKEN_PLIST];

// Read-only dirs do not stop root, so those tests cannot fail the write.
const IS_ROOT = process.getuid?.() === 0;

const ENV_KEYS = ["LLAMACTL_AGENT_DIR", "DEV_STORAGE", "HOME"] as const;

let dir = "";
let home = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llamactl-migrate-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ result: number; stdout: string; stderr: string }> {
  return await captureProcessStreams(() => runAgent(["migrate-tunnel-bearer", ...args]));
}

function plistWithDir(
  agentDir: string,
  extraArgs: string[] = [],
  env: Record<string, string> = {
    PATH: "/usr/bin",
    HOME: home,
    LLAMACTL_TUNNEL_BEARER: TOKEN,
  },
): string {
  return buildUserPlist({
    label: "com.llamactl.agent",
    execPath: "/usr/local/bin/llamactl-agent",
    args: [
      "agent",
      "serve",
      `--dir=${agentDir}`,
      ...extraArgs,
      "--dial-central=wss://c:7843/tunnel",
    ],
    logDir: "/tmp/l",
    env,
  });
}

// The shape of the hand-installed com.llamactl.node-agent.plist from the
// issue: bun + bin.ts argv, no --dir, and EnvironmentVariables in the
// multi-line <key>K</key>\n<string>V</string> layout.
function issueShapedPlist(env: Record<string, string>): string {
  const envDict = Object.entries(env)
    .map(([key, value]) => `    <key>${key}</key>\n    <string>${value}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.llamactl.node-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/operator/.bun/bin/bun</string>
    <string>/Volumes/WorkSSD/repos/personal/llamactl/packages/cli/src/bin.ts</string>
    <string>agent</string>
    <string>serve</string>
    <string>--dial-central=wss://c:7843/tunnel</string>
    <string>--tunnel-node-name=m4-pro</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envDict}
  </dict>
</dict>
</plist>
`;
}

function systemdUnit(agentDir: string, scope: "user" | "system" = "user"): string {
  return buildSystemdUnit({
    scope,
    execPath: "/home/u/.local/bin/llamactl-agent",
    args: ["agent", "serve", `--dir=${agentDir}`, "--tunnel-central=true"],
    env: { HF_HOME: "/x", LLAMACTL_TUNNEL_CENTRAL_BEARER: CENTRAL },
    envFiles: [],
  });
}

function writeUnit(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

function expectNoSecrets(r: { stdout: string; stderr: string }): void {
  for (const text of [r.stdout, r.stderr]) {
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  }
}

function stashProcessEnv(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  return (): void => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  };
}

describe("agent migrate-tunnel-bearer (#289)", () => {
  test("C1: dry-run is the default — reports the write + plist edit without touching disk", async () => {
    const agentDir = mkdtempSync(join(dir, "agent-"));
    const plistPath = writeUnit("com.llamactl.agent.plist", plistWithDir(agentDir));
    const before = readFileSync(plistPath, "utf8");
    const r = await run([plistPath]);
    expect(r.stderr).not.toContain("Unknown agent subcommand");
    expect(r.result).toBe(0);
    expect(r.stdout).toContain(
      `would write ${join(agentDir, "tunnel-bearer")} (0600) from LLAMACTL_TUNNEL_BEARER`,
    );
    expect(r.stdout).toContain(`would remove LLAMACTL_TUNNEL_BEARER from ${plistPath}`);
    expect(r.stdout).toContain("--write");
    expect(readFileSync(plistPath, "utf8")).toBe(before);
    expect(existsSync(join(agentDir, "tunnel-bearer"))).toBe(false);
    expectNoSecrets(r);
  });

  test("C2: --write moves the dial bearer into a 0600 file and scrubs the plist", async () => {
    const agentDir = mkdtempSync(join(dir, "agent-"));
    const plistPath = writeUnit("com.llamactl.agent.plist", plistWithDir(agentDir));
    const r = await run([plistPath, "--write"]);
    expect(r.stderr).not.toContain("Unknown agent subcommand");
    expect(r.result).toBe(0);

    const bearerPath = join(agentDir, "tunnel-bearer");
    expect(readFileSync(bearerPath, "utf8").trim()).toBe(TOKEN);
    expect(statSync(bearerPath).mode & 0o777).toBe(0o600);

    const plist = readFileSync(plistPath, "utf8");
    expect(plist).not.toContain("LLAMACTL_TUNNEL_BEARER");
    expect(plist).not.toContain(TOKEN);
    expect(plist).toContain("<key>HOME</key>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain(`--dir=${agentDir}`);
    expect(plist).toContain("<key>Label</key>");
    expect(plist.startsWith("<?xml")).toBe(true);

    expect(r.stdout).toContain(`wrote ${bearerPath} (0600)`);
    expect(r.stdout).toContain("removed LLAMACTL_TUNNEL_BEARER from");
    expect(r.stdout).toContain("launchctl kickstart -k gui/");
    expect(r.stdout).toContain("/com.llamactl.agent");
    expect(r.stdout).not.toContain("system/com.llamactl.agent");
    expectNoSecrets(r);
  });

  test("C3: the agent dir comes from the unit's own env, never the operator's", async () => {
    const operatorDir = mkdtempSync(join(tmpdir(), "llamactl-migrate-op-"));
    const restore = stashProcessEnv();
    try {
      for (const key of ENV_KEYS) process.env[key] = operatorDir;
      const ds = mkdtempSync(join(dir, "ds-"));
      const ad = mkdtempSync(join(dir, "ad-"));
      mkdirSync(join(home, ".llamactl"), { recursive: true });

      const cases: [string, Record<string, string>, string][] = [
        [
          "dev-storage",
          { HOME: home, DEV_STORAGE: ds, LLAMACTL_TUNNEL_BEARER: TOKEN },
          join(ds, "tunnel-bearer"),
        ],
        [
          "home-fallback",
          { HOME: home, LLAMACTL_TUNNEL_BEARER: TOKEN },
          join(home, ".llamactl", "tunnel-bearer"),
        ],
        [
          "agent-dir-wins",
          { LLAMACTL_AGENT_DIR: ad, DEV_STORAGE: ds, HOME: home, LLAMACTL_TUNNEL_BEARER: TOKEN },
          join(ad, "tunnel-bearer"),
        ],
      ];
      for (const [name, env, expected] of cases) {
        const plistPath = writeUnit(`${name}.plist`, issueShapedPlist(env));
        const r = await run([plistPath]);
        expect(r.stderr).not.toContain("Unknown agent subcommand");
        expect(r.result).toBe(0);
        expect(r.stdout).toContain(expected);
        expect(r.stdout).not.toContain(operatorDir);
        expectNoSecrets(r);
      }
    } finally {
      restore();
      rmSync(operatorDir, { recursive: true, force: true });
    }
  });

  test("C4: --write refuses when the unit env cannot resolve an agent dir", async () => {
    const opHome = mkdtempSync(join(tmpdir(), "llamactl-migrate-ophome-"));
    const opDs = mkdtempSync(join(tmpdir(), "llamactl-migrate-opds-"));
    const opAd = mkdtempSync(join(tmpdir(), "llamactl-migrate-opad-"));
    mkdirSync(join(opHome, ".llamactl"), { recursive: true });
    const restore = stashProcessEnv();
    try {
      process.env["LLAMACTL_AGENT_DIR"] = opAd;
      process.env["DEV_STORAGE"] = opDs;
      process.env["HOME"] = opHome;

      const plistPath = writeUnit(
        "node-agent.plist",
        issueShapedPlist({ PATH: "/usr/bin", LLAMACTL_TUNNEL_BEARER: TOKEN }),
      );
      const before = readFileSync(plistPath, "utf8");
      const r = await run([plistPath, "--write"]);
      expect(r.stderr).not.toContain("Unknown agent subcommand");
      expect(r.result).toBe(1);
      expect(r.stderr).toContain("agent migrate-tunnel-bearer: cannot determine the agent dir");
      expect(r.stderr).toContain("--dir=");
      expect(readFileSync(plistPath, "utf8")).toBe(before);
      for (const d of [opAd, opDs, join(opHome, ".llamactl"), opHome]) {
        expect(existsSync(join(d, "tunnel-bearer"))).toBe(false);
      }
      expectNoSecrets(r);

      const agentDir = mkdtempSync(join(dir, "agent-"));
      const r2 = await run([plistPath, `--dir=${agentDir}`]);
      expect(r2.stderr).not.toContain("Unknown agent subcommand");
      expect(r2.result).toBe(0);
      expect(r2.stdout).toContain(join(agentDir, "tunnel-bearer"));
      expectNoSecrets(r2);
    } finally {
      restore();
      rmSync(opHome, { recursive: true, force: true });
      rmSync(opDs, { recursive: true, force: true });
      rmSync(opAd, { recursive: true, force: true });
    }
  });

  test("C5: --dir that disagrees with the unit's own --dir is refused", async () => {
    const agentDir = mkdtempSync(join(dir, "agent-"));
    const otherDir = mkdtempSync(join(dir, "other-"));
    const plistPath = writeUnit("com.llamactl.agent.plist", plistWithDir(agentDir));
    const before = readFileSync(plistPath, "utf8");
    const r = await run([plistPath, `--dir=${otherDir}`, "--write"]);
    expect(r.stderr).not.toContain("Unknown agent subcommand");
    expect(r.result).toBe(1);
    expect(r.stderr).toContain("does not match the agent dir the service uses");
    expect(readFileSync(plistPath, "utf8")).toBe(before);
    expect(existsSync(join(otherDir, "tunnel-bearer"))).toBe(false);
    expect(existsSync(join(agentDir, "tunnel-bearer"))).toBe(false);
    expectNoSecrets(r);
  });

  test("C6: systemd unit --write moves LLAMACTL_TUNNEL_CENTRAL_BEARER to tunnel-central-bearer", async () => {
    const agentDir = mkdtempSync(join(dir, "agent-"));
    const unitPath = writeUnit("llamactl-agent.service", systemdUnit(agentDir));
    const r = await run([unitPath, "--write"]);
    expect(r.stderr).not.toContain("Unknown agent subcommand");
    expect(r.result).toBe(0);

    const bearerPath = join(agentDir, "tunnel-central-bearer");
    expect(readFileSync(bearerPath, "utf8").trim()).toBe(CENTRAL);
    expect(statSync(bearerPath).mode & 0o777).toBe(0o600);

    const unit = readFileSync(unitPath, "utf8");
    expect(unit).not.toContain("LLAMACTL_TUNNEL_CENTRAL_BEARER");
    expect(unit).not.toContain(CENTRAL);
    expect(unit).toContain('Environment="HF_HOME=/x"');
    expect(unit).toContain("ExecStart=");
    expect(unit).toContain("[Install]");

    expect(r.stdout).toContain("systemctl --user restart llamactl-agent.service");
    expectNoSecrets(r);
  });

  test("C7: an existing bearer file is never overwritten", async () => {
    const agentDir = mkdtempSync(join(dir, "agent-"));
    const plistPath = writeUnit("com.llamactl.agent.plist", plistWithDir(agentDir));
    const before = readFileSync(plistPath, "utf8");
    const bearerPath = join(agentDir, "tunnel-bearer");
    writeFileSync(bearerPath, "old", { mode: 0o600 });
    const r = await run([plistPath, "--write"]);
    expect(r.stderr).not.toContain("Unknown agent subcommand");
    expect(r.result).toBe(1);
    expect(r.stderr).toContain("already exists");
    expect(readFileSync(bearerPath, "utf8")).toBe("old");
    expect(readFileSync(plistPath, "utf8")).toBe(before);
    expectNoSecrets(r);
  });

  test("C8: usage errors", async () => {
    {
      const r = await run([]);
      expect(r.stderr).not.toContain("Unknown agent subcommand");
      expect(r.result).toBe(1);
      expect(r.stderr).toContain("agent migrate-tunnel-bearer: missing <unit-path>");
      expectNoSecrets(r);
    }
    {
      const r = await run(["--bogus"]);
      expect(r.stderr).not.toContain("Unknown agent subcommand");
      expect(r.result).toBe(1);
      expect(r.stderr).toContain("agent migrate-tunnel-bearer: unknown flag --bogus");
      expectNoSecrets(r);
    }
    {
      const r = await run([join(dir, "no-such-unit")]);
      expect(r.stderr).not.toContain("Unknown agent subcommand");
      expect(r.result).toBe(1);
      expect(r.stderr).toContain("agent migrate-tunnel-bearer: cannot read");
      expectNoSecrets(r);
    }
    {
      const r = await run([writeUnit("hello.txt", "hello")]);
      expect(r.stderr).not.toContain("Unknown agent subcommand");
      expect(r.result).toBe(1);
      expect(r.stderr).toContain("unrecognised unit format");
      expectNoSecrets(r);
    }
    {
      const missingDir = join(dir, "missing-dir");
      const plistPath = writeUnit("com.llamactl.agent.plist", plistWithDir(missingDir));
      const before = readFileSync(plistPath, "utf8");
      const r = await run([plistPath]);
      expect(r.stderr).not.toContain("Unknown agent subcommand");
      expect(r.result).toBe(1);
      expect(r.stderr).toContain("does not exist");
      expect(readFileSync(plistPath, "utf8")).toBe(before);
      expectNoSecrets(r);
    }
  });

  test("C9: nothing to migrate exits 0 before any dir resolution", async () => {
    {
      const agentDir = mkdtempSync(join(dir, "agent-"));
      const plistPath = writeUnit(
        "com.llamactl.agent.plist",
        plistWithDir(agentDir, [], { PATH: "/usr/bin", HOME: home }),
      );
      const before = readFileSync(plistPath, "utf8");
      const r = await run([plistPath]);
      expect(r.stderr).not.toContain("Unknown agent subcommand");
      expect(r.result).toBe(0);
      expect(r.stdout).toContain("nothing to migrate");
      expect(readFileSync(plistPath, "utf8")).toBe(before);
      expect(existsSync(join(agentDir, "tunnel-bearer"))).toBe(false);
      expectNoSecrets(r);
    }
    {
      const plistPath = writeUnit("node-agent.plist", issueShapedPlist({ PATH: "/usr/bin" }));
      const r = await run([plistPath]);
      expect(r.stderr).not.toContain("Unknown agent subcommand");
      expect(r.result).toBe(0);
      expect(r.stdout).toContain("nothing to migrate");
      expectNoSecrets(r);
    }
  });

  test("C10: the last --dir in ProgramArguments wins", async () => {
    const firstDir = mkdtempSync(join(dir, "first-"));
    const agentDir = mkdtempSync(join(dir, "agent-"));
    const plistPath = writeUnit(
      "com.llamactl.agent.plist",
      plistWithDir(firstDir, [`--dir=${agentDir}`]),
    );
    const r = await run([plistPath]);
    expect(r.stderr).not.toContain("Unknown agent subcommand");
    expect(r.result).toBe(0);
    expect(r.stdout).toContain(join(agentDir, "tunnel-bearer"));
    expect(r.stdout).not.toContain(join(firstDir, "tunnel-bearer"));
    expectNoSecrets(r);
  });

  // Hand-written unit: systemd allows several assignments on one
  // Environment= line, which buildSystemdUnit never emits.
  function handSystemdUnit(agentDir: string | undefined, envLines: string[]): string {
    const dirArg = agentDir === undefined ? "" : ` --dir=${agentDir}`;
    return [
      "[Unit]",
      "Description=llamactl agent",
      "",
      "[Service]",
      `ExecStart=/home/u/.local/bin/llamactl-agent agent serve${dirArg}`,
      ...envLines,
      "Restart=on-failure",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
  }

  test("C12: a shared Environment= line keeps its other variables", async () => {
    const agentDir = mkdtempSync(join(dir, "agent-"));
    const unitPath = writeUnit(
      "llamactl-agent.service",
      handSystemdUnit(agentDir, [
        `Environment=HF_HOME=/hf LLAMACTL_TUNNEL_BEARER=${TOKEN} PATH=/usr/bin`,
      ]),
    );
    const r = await run([unitPath, "--write"]);
    expect(r.result).toBe(0);
    expect(readFileSync(join(agentDir, "tunnel-bearer"), "utf8").trim()).toBe(TOKEN);
    const unit = readFileSync(unitPath, "utf8");
    expect(unit).not.toContain("LLAMACTL_TUNNEL_BEARER");
    expect(unit).not.toContain(TOKEN);
    expect(unit).toContain("\nEnvironment=HF_HOME=/hf PATH=/usr/bin\n");
    expect(unit).toContain("Restart=on-failure");
    expectNoSecrets(r);
  });

  test("C13: quoted words with spaces survive the rewrite verbatim", async () => {
    const agentDir = mkdtempSync(join(dir, "agent-"));
    const unitPath = writeUnit(
      "llamactl-agent.service",
      handSystemdUnit(agentDir, [
        `Environment="GREETING=hello  world" "LLAMACTL_TUNNEL_BEARER=${TOKEN}" ` +
          `MSG="say \\"hi\\" 100%%"`,
        `Environment="LLAMACTL_TUNNEL_CENTRAL_BEARER=${CENTRAL}"`,
        'Environment="HF_HOME=/x"',
      ]),
    );
    const r = await run([unitPath, "--write"]);
    expect(r.result).toBe(0);
    expect(readFileSync(join(agentDir, "tunnel-bearer"), "utf8").trim()).toBe(TOKEN);
    expect(readFileSync(join(agentDir, "tunnel-central-bearer"), "utf8").trim()).toBe(CENTRAL);
    const unit = readFileSync(unitPath, "utf8");
    expect(unit).not.toContain("LLAMACTL_TUNNEL");
    expect(unit).not.toContain(TOKEN);
    expect(unit).not.toContain(CENTRAL);
    expect(unit).toContain('\nEnvironment="GREETING=hello  world" MSG="say \\"hi\\" 100%%"\n');
    // The quoted single-assignment line is gone entirely, its neighbour stays.
    expect(unit).toContain('\nEnvironment="HF_HOME=/x"\nRestart=on-failure\n');
    expectNoSecrets(r);
  });

  test("C14: both bearers on one line, agent dir from a co-located DEV_STORAGE", async () => {
    const ds = mkdtempSync(join(dir, "ds-"));
    const unitPath = writeUnit(
      "llamactl-agent.service",
      handSystemdUnit(undefined, [
        `Environment=LLAMACTL_TUNNEL_BEARER=${TOKEN} DEV_STORAGE=${ds} ` +
          `LLAMACTL_TUNNEL_CENTRAL_BEARER=${CENTRAL}`,
        `Environment=LLAMACTL_TUNNEL_BEARER=${TOKEN} LLAMACTL_TUNNEL_CENTRAL_BEARER=${CENTRAL}`,
      ]),
    );
    const before = readFileSync(unitPath, "utf8");

    const dry = await run([unitPath]);
    expect(dry.result).toBe(0);
    expect(dry.stdout).toContain(`would write ${join(ds, "tunnel-bearer")} (0600)`);
    expect(dry.stdout).toContain(`would write ${join(ds, "tunnel-central-bearer")} (0600)`);
    expect(readFileSync(unitPath, "utf8")).toBe(before);
    expectNoSecrets(dry);

    const r = await run([unitPath, "--write"]);
    expect(r.result).toBe(0);
    expect(readFileSync(join(ds, "tunnel-bearer"), "utf8").trim()).toBe(TOKEN);
    expect(readFileSync(join(ds, "tunnel-central-bearer"), "utf8").trim()).toBe(CENTRAL);
    const unit = readFileSync(unitPath, "utf8");
    expect(unit).not.toContain("LLAMACTL_TUNNEL");
    expect(unit).not.toContain(TOKEN);
    expect(unit).not.toContain(CENTRAL);
    expect(unit).toContain(`\nEnvironment=DEV_STORAGE=${ds}\nRestart=on-failure\n`);
    expectNoSecrets(r);
  });

  test("C15: a symlinked unit is rewritten at its target and the link is kept", async () => {
    const agentDir = mkdtempSync(join(dir, "agent-"));
    const realDir = mkdtempSync(join(dir, "real-"));
    const linkDir = mkdtempSync(join(dir, "links-"));
    const targetPath = join(realDir, "llamactl-agent.service");
    writeFileSync(
      targetPath,
      handSystemdUnit(agentDir, [`Environment=HF_HOME=/hf LLAMACTL_TUNNEL_BEARER=${TOKEN}`]),
    );
    const linkPath = join(linkDir, "llamactl-agent.service");
    symlinkSync(targetPath, linkPath);

    const r = await run([linkPath, "--write"]);
    expect(r.result).toBe(0);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(targetPath);
    const unit = readFileSync(targetPath, "utf8");
    expect(unit).not.toContain("LLAMACTL_TUNNEL_BEARER");
    expect(unit).not.toContain(TOKEN);
    expect(unit).toContain("\nEnvironment=HF_HOME=/hf\n");
    expect(readFileSync(join(agentDir, "tunnel-bearer"), "utf8").trim()).toBe(TOKEN);
    expect(r.stdout).toContain(`removed LLAMACTL_TUNNEL_BEARER from ${realpathSync(targetPath)}`);
    expect(r.stdout).toContain("systemctl --user restart llamactl-agent.service");
    expectNoSecrets(r);
  });

  test.skipIf(IS_ROOT)(
    "C16: an unwritable unit dir fails after the bearer file is safely written",
    async () => {
      const agentDir = mkdtempSync(join(dir, "agent-"));
      const unitDir = mkdtempSync(join(dir, "units-"));
      const unitPath = join(unitDir, "llamactl-agent.service");
      writeFileSync(
        unitPath,
        handSystemdUnit(agentDir, [`Environment=LLAMACTL_TUNNEL_BEARER=${TOKEN}`]),
      );
      const before = readFileSync(unitPath, "utf8");
      chmodSync(unitDir, 0o555);
      try {
        const r = await run([unitPath, "--write"]);
        expect(r.result).toBe(1);
        expect(r.stderr).toContain("could not rewrite");
        expectNoSecrets(r);
      } finally {
        chmodSync(unitDir, 0o755);
      }
      // No token lost: the unit still has it and the 0600 file holds it.
      expect(readFileSync(unitPath, "utf8")).toBe(before);
      const bearerPath = join(agentDir, "tunnel-bearer");
      expect(readFileSync(bearerPath, "utf8").trim()).toBe(TOKEN);
      expect(statSync(bearerPath).mode & 0o777).toBe(0o600);
    },
  );

  test.skipIf(IS_ROOT)("C17: an unwritable agent dir leaves the unit unchanged", async () => {
    const agentDir = mkdtempSync(join(dir, "agent-"));
    const unitPath = writeUnit(
      "llamactl-agent.service",
      handSystemdUnit(agentDir, [
        `Environment=LLAMACTL_TUNNEL_BEARER=${TOKEN} LLAMACTL_TUNNEL_CENTRAL_BEARER=${CENTRAL}`,
      ]),
    );
    const before = readFileSync(unitPath, "utf8");
    chmodSync(agentDir, 0o555);
    try {
      const r = await run([unitPath, "--write"]);
      expect(r.result).toBe(1);
      expect(r.stderr).toContain("could not write a bearer file");
      expectNoSecrets(r);
    } finally {
      chmodSync(agentDir, 0o755);
    }
    expect(readFileSync(unitPath, "utf8")).toBe(before);
    expect(existsSync(join(agentDir, "tunnel-bearer"))).toBe(false);
    expect(existsSync(join(agentDir, "tunnel-central-bearer"))).toBe(false);
  });

  test("C18: the rewritten unit keeps its original file mode", async () => {
    const agentDir = mkdtempSync(join(dir, "agent-"));
    const unitPath = writeUnit(
      "llamactl-agent.service",
      handSystemdUnit(agentDir, [`Environment=LLAMACTL_TUNNEL_BEARER=${TOKEN}`]),
    );
    chmodSync(unitPath, 0o640);
    const r = await run([unitPath, "--write"]);
    expect(r.result).toBe(0);
    expect(readFileSync(unitPath, "utf8")).not.toContain(TOKEN);
    expect(statSync(unitPath).mode & 0o777).toBe(0o640);
    expectNoSecrets(r);
  });

  test("C19: a systemd %% in the bearer migrates as a single %", async () => {
    const agentDir = mkdtempSync(join(dir, "agent-"));
    const unitPath = writeUnit(
      "llamactl-agent.service",
      handSystemdUnit(agentDir, [`Environment=LLAMACTL_TUNNEL_BEARER=${PCT_TOKEN_UNIT}`]),
    );
    const r = await run([unitPath, "--write"]);
    expect(r.result).toBe(0);
    expect(readFileSync(join(agentDir, "tunnel-bearer"), "utf8")).toBe(`${PCT_TOKEN}\n`);
    expect(readFileSync(unitPath, "utf8")).not.toContain("LLAMACTL_TUNNEL_BEARER");
    expectNoSecrets(r);
  });

  test("C20: an empty bearer value is refused", async () => {
    const agentDir = mkdtempSync(join(dir, "agent-"));
    const unitPath = writeUnit(
      "llamactl-agent.service",
      handSystemdUnit(agentDir, ["Environment=LLAMACTL_TUNNEL_BEARER="]),
    );
    const before = readFileSync(unitPath, "utf8");
    const r = await run([unitPath, "--write"]);
    expect(r.result).toBe(1);
    expect(r.stderr).toContain(`LLAMACTL_TUNNEL_BEARER in ${unitPath} is empty`);
    expect(readFileSync(unitPath, "utf8")).toBe(before);
    expect(existsSync(join(agentDir, "tunnel-bearer"))).toBe(false);
    expectNoSecrets(r);
  });

  test("C21: a plist bearer is XML-decoded once into the bearer file", async () => {
    const agentDir = mkdtempSync(join(dir, "agent-"));
    const plistPath = writeUnit(
      "node-agent.plist",
      issueShapedPlist({
        PATH: "/usr/bin",
        LLAMACTL_AGENT_DIR: agentDir,
        LLAMACTL_TUNNEL_BEARER: XML_TOKEN_PLIST,
      }),
    );
    const r = await run([plistPath, "--write"]);
    expect(r.result).toBe(0);
    expect(readFileSync(join(agentDir, "tunnel-bearer"), "utf8")).toBe(`${XML_TOKEN}\n`);
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).not.toContain("LLAMACTL_TUNNEL_BEARER");
    expect(plist).not.toContain(XML_TOKEN_PLIST);
    expectNoSecrets(r);
  });

  test("C22: a systemd EnvironmentFile= without --dir needs the operator's --dir", async () => {
    const ds = mkdtempSync(join(dir, "ds-"));
    const unitPath = writeUnit(
      "llamactl-agent.service",
      handSystemdUnit(undefined, [
        "EnvironmentFile=-/etc/llamactl/agent.env",
        `Environment=DEV_STORAGE=${ds} LLAMACTL_TUNNEL_BEARER=${TOKEN}`,
      ]),
    );
    const before = readFileSync(unitPath, "utf8");
    const r = await run([unitPath, "--write"]);
    expect(r.result).toBe(1);
    expect(r.stderr).toContain("EnvironmentFile=");
    expect(r.stderr).toContain("pass --dir=<abs path>");
    expect(readFileSync(unitPath, "utf8")).toBe(before);
    expect(existsSync(join(ds, "tunnel-bearer"))).toBe(false);
    expectNoSecrets(r);

    const agentDir = mkdtempSync(join(dir, "agent-"));
    const r2 = await run([unitPath, `--dir=${agentDir}`]);
    expect(r2.result).toBe(0);
    expect(r2.stdout).toContain(`would write ${join(agentDir, "tunnel-bearer")} (0600)`);
    expectNoSecrets(r2);
  });

  test("C11: system-scope launchd plist gets a system-domain kickstart hint", async () => {
    const agentDir = mkdtempSync(join(dir, "agent-"));
    const plistPath = writeUnit(
      "com.llamactl.agent.plist",
      buildSystemPlist({
        label: "com.llamactl.agent",
        execPath: "/usr/local/bin/llamactl-agent",
        args: ["agent", "serve", `--dir=${agentDir}`],
        logDir: "/tmp/l",
        env: { LLAMACTL_TUNNEL_BEARER: TOKEN },
        user: "llamactl",
        group: "staff",
        workingDir: agentDir,
      }),
    );
    const r = await run([plistPath, "--write"]);
    expect(r.stderr).not.toContain("Unknown agent subcommand");
    expect(r.result).toBe(0);
    expect(readFileSync(join(agentDir, "tunnel-bearer"), "utf8").trim()).toBe(TOKEN);
    expect(r.stdout).toContain("launchctl kickstart -k system/com.llamactl.agent");
    expect(r.stdout).not.toContain("gui/");
    expectNoSecrets(r);
  });
});
