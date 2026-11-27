import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { checkUnitSecrets, defaultUnitSecretOptions } from "../src/commands/doctor-unit-secrets.js";
import { type DoctorDeps, runDoctor } from "../src/commands/doctor.js";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

/**
 * `llamactl doctor [secrets]` unit-file scan (#289). Installed launchd
 * plists and systemd units are operator-visible files, so embedding a
 * tunnel bearer or another secret-looking environment value in one is a
 * disclosure risk. These fixtures inject every directory and use only a
 * fake token; the probe never reads the real home, launchd, or systemd
 * locations.
 */

const FAKE_TOKEN = "fake-tunnel-bearer-0000-not-real";
const SKIP_OTHER_PROBES = ["--skip=agent", "--skip=docker", "--skip=kubernetes", "--skip=units"];

interface UnitSecretsProbeOptions {
  platform: NodeJS.Platform;
  launchdDirs: string[];
  systemdDirs: string[];
}

type DoctorDepsWithUnitSecrets = DoctorDeps & {
  unitSecrets: UnitSecretsProbeOptions;
};

function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);

  process.stdout.write = (s: string | Uint8Array): boolean => {
    chunks.push(typeof s === "string" ? s : String(s));
    return true;
  };
  return fn()
    .then((result) => ({ result, out: chunks.join("") }))
    .finally(() => {
      process.stdout.write = original;
    });
}

function plistXml(label: string, env: Record<string, string>): string {
  const entries = Object.entries(env)
    .map(([key, value]) => `    <key>${key}</key><string>${value}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/llamactl/bin/llamactl</string>
    <string>agent</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${entries}
  </dict>
</dict>
</plist>
`;
}

function secretWarnings(out: string): string[] {
  return out.split("\n").filter((line) => line.includes("[secrets]") && line.includes("⚠"));
}

describe("doctor [secrets] unit-file scan (#289)", () => {
  let root: string;
  let agents: string;
  let daemons: string;
  let userUnits: string;
  let systemUnits: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "doctor-unit-secrets-"));
    agents = join(root, "agents");
    daemons = join(root, "daemons");
    userUnits = join(root, "user-units");
    systemUnits = join(root, "system-units");
    for (const dir of [agents, daemons, userUnits, systemUnits]) {
      mkdirSync(dir, { recursive: true });
    }
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  function unitSecrets(platform: NodeJS.Platform): UnitSecretsProbeOptions {
    return {
      platform,
      launchdDirs: [agents, daemons],
      systemdDirs: [userUnits, systemUnits],
    };
  }

  function depsFor(secrets: UnitSecretsProbeOptions): DoctorDeps {
    const deps: DoctorDepsWithUnitSecrets = {
      checkSecrets: () => [{ system: "secrets", status: "ok", message: "stub keychain ok" }],
      unitSecrets: secrets,
    };
    return deps;
  }

  function runProbe(
    secrets: UnitSecretsProbeOptions,
    extraArgs: string[] = [],
  ): Promise<{ result: number; out: string }> {
    return captureStdout(() => runDoctor([...SKIP_OTHER_PROBES, ...extraArgs], depsFor(secrets)));
  }

  function writePlist(
    dir: string,
    name: string,
    label: string,
    env: Record<string, string>,
  ): string {
    const path = join(dir, name);
    writeFileSync(path, plistXml(label, env));
    return path;
  }

  test("darwin warns when a user LaunchAgent embeds the tunnel bearer", async () => {
    const plistPath = writePlist(
      agents,
      "com.llamactl.node-agent.plist",
      "com.llamactl.node-agent",
      {
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        LLAMACTL_TUNNEL_BEARER: FAKE_TOKEN,
      },
    );

    const { result, out } = await runProbe(unitSecrets("darwin"));

    expect(result).toBe(1);
    expect(out).toContain("[secrets]");
    expect(out).toContain("⚠");
    expect(out).toContain(plistPath);
    expect(out).toContain("LLAMACTL_TUNNEL_BEARER");
    expect(out).toContain("llamactl agent migrate-tunnel-bearer");
    expect(out).not.toContain(FAKE_TOKEN);
  });

  test("darwin emits one warning per secret kind in the same plist", async () => {
    const plistPath = writePlist(agents, "com.llamactl.agent.plist", "com.llamactl.agent", {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      LLAMACTL_TUNNEL_CENTRAL_BEARER: FAKE_TOKEN,
      OPENAI_API_KEY: FAKE_TOKEN,
    });

    const { result, out } = await runProbe(unitSecrets("darwin"));

    expect(result).toBe(1);
    const lines = out.split("\n").filter((line) => line.includes(plistPath) && line.includes("⚠"));
    expect(lines).toHaveLength(2);
    const tunnelLine = lines.find((line) => line.includes("LLAMACTL_TUNNEL_CENTRAL_BEARER")) ?? "";
    const openAiLine = lines.find((line) => line.includes("OPENAI_API_KEY")) ?? "";
    expect(tunnelLine).toContain("LLAMACTL_TUNNEL_CENTRAL_BEARER");
    expect(out).toContain("migrate-tunnel-bearer");
    expect(openAiLine).toContain("OPENAI_API_KEY");
    expect(out).toContain("0600");
    expect(tunnelLine).not.toContain("OPENAI_API_KEY");
    expect(out).not.toContain(FAKE_TOKEN);
  });

  test("darwin scans system-scope LaunchDaemons as well as user LaunchAgents", async () => {
    const plistPath = writePlist(daemons, "com.llamactl.agent.plist", "com.llamactl.agent", {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      LLAMACTL_TUNNEL_BEARER: FAKE_TOKEN,
    });

    const { result, out } = await runProbe(unitSecrets("darwin"));

    expect(result).toBe(1);
    const warningLine = secretWarnings(out).find((line) => line.includes(plistPath)) ?? "";
    expect(warningLine).toContain("LLAMACTL_TUNNEL_BEARER");
    expect(out).not.toContain(FAKE_TOKEN);
  });

  test("darwin accepts bearer-file indirection and ignores foreign labels", async () => {
    writePlist(agents, "com.llamactl.node-agent.plist", "com.llamactl.node-agent", {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      HOME: "/Users/example",
      LLAMACTL_TUNNEL_BEARER_FILE: "/abs/tunnel-bearer",
    });
    writePlist(agents, "com.example.other.plist", "com.example.other", {
      FOO_TOKEN: FAKE_TOKEN,
    });

    const { result, out } = await runProbe(unitSecrets("darwin"));

    expect(result).toBe(0);
    const cleanLine =
      out
        .split("\n")
        .find(
          (line) =>
            line.includes("[secrets]") &&
            line.includes("✓") &&
            line.includes("com.llamactl.node-agent.plist"),
        ) ?? "";
    expect(cleanLine).toContain("no secret-looking env");
    expect(out).not.toContain("com.example.other");
    expect(out).not.toContain("FOO_TOKEN");
    expect(out).not.toContain(FAKE_TOKEN);
  });

  test("darwin reports binary plists as convertible instead of throwing", async () => {
    const plistPath = join(agents, "com.llamactl.node-agent.plist");
    writeFileSync(plistPath, "bplist00-not-xml");

    const { result, out } = await runProbe(unitSecrets("darwin"));

    expect(result).toBe(0);
    const infoLine =
      out
        .split("\n")
        .find(
          (line) => line.includes("[secrets]") && line.includes("ℹ") && line.includes(plistPath),
        ) ?? "";
    expect(infoLine).not.toBe("");
    expect(out).toContain("plutil -convert xml1");
  });

  test("linux scans user units, drop-ins, and system units without printing values", async () => {
    writeFileSync(
      join(userUnits, "llamactl-agent.service"),
      `[Service]\nExecStart=/opt/llamactl agent serve\nEnvironment=LLAMACTL_TUNNEL_BEARER=${FAKE_TOKEN}\n`,
    );
    writeFileSync(
      join(userUnits, "llamactl-controller.service"),
      "[Service]\nExecStart=/opt/llamactl controller run\n",
    );
    const dropInDir = join(userUnits, "llamactl-controller.service.d");
    mkdirSync(dropInDir, { recursive: true });
    writeFileSync(
      join(dropInDir, "env.conf"),
      `[Service]\nEnvironment="LLAMACTL_TUNNEL_CENTRAL_BEARER=${FAKE_TOKEN} x"\n`,
    );
    const systemAgentPath = join(systemUnits, "llamactl-agent.service");
    writeFileSync(
      systemAgentPath,
      `[Service]\nEnvironmentFile=/etc/llamactl/env\nEnvironment=LLAMACTL_TUNNEL_BEARER=${FAKE_TOKEN}\n`,
    );

    const { result, out } = await runProbe(unitSecrets("linux"));

    expect(result).toBe(1);
    const warnings = secretWarnings(out);
    expect(
      warnings.some(
        (line) =>
          line.includes("llamactl-agent.service") && line.includes("LLAMACTL_TUNNEL_BEARER"),
      ),
    ).toBe(true);
    expect(
      warnings.some(
        (line) =>
          line.includes("llamactl-controller.service.d/env.conf") &&
          line.includes("LLAMACTL_TUNNEL_CENTRAL_BEARER"),
      ),
    ).toBe(true);
    expect(
      warnings.some(
        (line) => line.includes(systemAgentPath) && line.includes("LLAMACTL_TUNNEL_BEARER"),
      ),
    ).toBe(true);
    expect(out).toContain("llamactl agent migrate-tunnel-bearer");
    expect(out).toContain("--dir=<abs path>");
    expect(out).not.toContain(FAKE_TOKEN);
  });

  // Regression pin — passes at the base commit: --skip=secrets already
  // suppresses the only [secrets] probe, and the scan must live behind the
  // same namespace once it exists.
  test("--skip=secrets suppresses the unit-secret scan", async () => {
    writePlist(agents, "com.llamactl.node-agent.plist", "com.llamactl.node-agent", {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      LLAMACTL_TUNNEL_BEARER: FAKE_TOKEN,
    });

    const { result, out } = await runProbe(unitSecrets("darwin"), ["--skip=secrets"]);

    expect(result).toBe(0);
    expect(out).not.toContain("[secrets]");
    expect(out).not.toContain("LLAMACTL_TUNNEL_BEARER");
    expect(out).not.toContain(FAKE_TOKEN);
  });

  // Regression pin — passes at the base commit: an unsupported platform or
  // empty scan directories add no unit-secret rows to the keychain stub.
  test("win32 and empty scan directories stay quiet", async () => {
    for (const host of ["win32", "darwin", "linux"] as const) {
      const { result, out } = await runProbe(unitSecrets(host));

      expect(result).toBe(0);
      expect(out.split("\n").filter((line) => line.includes("[secrets]"))).toHaveLength(1);
      expect(out).toContain("stub keychain ok");
    }
  });
});

describe("checkUnitSecrets degrade paths and drop-in hints (#289)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "doctor-unit-secrets-degrade-"));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  test("a drop-in fix names the parent unit and requires --dir", () => {
    const dropInDir = join(root, "llamactl-agent.service.d");
    mkdirSync(dropInDir, { recursive: true });
    writeFileSync(
      join(dropInDir, "bearer.conf"),
      `[Service]\nEnvironment=LLAMACTL_TUNNEL_BEARER=${FAKE_TOKEN}\n`,
    );

    const results = checkUnitSecrets({ platform: "linux", launchdDirs: [], systemdDirs: [root] });

    expect(results).toHaveLength(1);
    const fix = results[0]?.fix ?? "";
    expect(fix).toContain("drop-in of llamactl-agent.service");
    expect(fix).toContain("--dir=<abs path>");
    expect(fix).toContain("is required");
    expect(fix).toContain("restart llamactl-agent.service");
    expect(fix).toContain("daemon-reload");
    expect(JSON.stringify(results)).not.toContain(FAKE_TOKEN);
  });

  test("an unreadable scan dir degrades to an info row instead of throwing", () => {
    if (process.getuid?.() === 0) return; // root ignores directory modes
    const locked = join(root, "locked");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      const results = checkUnitSecrets({
        platform: "darwin",
        launchdDirs: [locked, join(root, "missing")],
        systemdDirs: [],
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("info");
      expect(results[0]?.message).toContain(locked);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

/**
 * Pin the default unit-file directories that `defaultUnitSecretOptions`
 * returns — the paths the inline-bearer warning scans (#905).
 *
 * These tests call the function directly with an explicit env object so
 * they never read the real $HOME, /Library, or /etc.  Expected values are
 * built from `homedir()` (Bun caches it at startup) plus literal path
 * parts, and compared with `toEqual` on the whole array.
 */
describe("defaultUnitSecretOptions scan directories (#905)", () => {
  const home = homedir();

  test("darwin scans user LaunchAgents then system LaunchDaemons", () => {
    const opts = defaultUnitSecretOptions("darwin", {});

    expect(opts.platform).toBe("darwin");
    expect(opts.launchdDirs).toEqual([
      join(home, "Library", "LaunchAgents"),
      "/Library/LaunchDaemons",
    ]);
  });

  test("linux scans ~/.config/systemd/user then /etc/systemd/system when XDG_CONFIG_HOME is unset", () => {
    const opts = defaultUnitSecretOptions("linux", {});

    expect(opts.platform).toBe("linux");
    expect(opts.systemdDirs).toEqual([
      join(home, ".config", "systemd", "user"),
      "/etc/systemd/system",
    ]);
  });

  test("linux honours XDG_CONFIG_HOME for the user unit dir only", () => {
    const opts = defaultUnitSecretOptions("linux", {
      XDG_CONFIG_HOME: "/nonexistent-905/xdg",
    });

    expect(opts.systemdDirs).toEqual(["/nonexistent-905/xdg/systemd/user", "/etc/systemd/system"]);
    // launchd must be unchanged: XDG must not affect launchd
    expect(opts.launchdDirs).toEqual([
      join(home, "Library", "LaunchAgents"),
      "/Library/LaunchDaemons",
    ]);
  });

  test("env defaults to process.env", () => {
    const prev = process.env["XDG_CONFIG_HOME"];
    try {
      process.env["XDG_CONFIG_HOME"] = "/nonexistent-905/proc-env";
      const opts = defaultUnitSecretOptions("linux");
      expect(opts.systemdDirs[0]).toBe("/nonexistent-905/proc-env/systemd/user");
    } finally {
      if (prev === undefined) {
        delete process.env["XDG_CONFIG_HOME"];
      } else {
        process.env["XDG_CONFIG_HOME"] = prev;
      }
    }
  });
});
