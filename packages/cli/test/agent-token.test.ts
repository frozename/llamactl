import { agentConfig as agentConfigMod, auth } from "@llamactl/remote";
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildServeOptions, parseServeFlags, runAgent } from "../src/commands/agent.js";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "../src/safe-fs.js";
import { parseJsonArray, parseJsonRecord } from "./helpers.js";

let stdoutBuf = "";
let stderrBuf = "";
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;

function capture(): void {
  stdoutBuf = "";
  stderrBuf = "";
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array): true => {
    stdoutBuf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): true => {
    stderrBuf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
}

function restore(): void {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
}

const dirs: string[] = [];

function newAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-token-"));
  dirs.push(dir);
  return dir;
}

/** Seed a real agent (cert + agent.yaml) via runAgent init, then clear stdout. */
async function seedAgent(): Promise<string> {
  const dir = newAgentDir();
  expect(await runAgent(["init", `--dir=${dir}`, "--json"])).toBe(0);
  stdoutBuf = "";
  return dir;
}

function bearerEntries(dir: string): agentConfigMod.AgentBearerToken[] {
  const block = agentConfigMod.loadAgentConfig(join(dir, "agent.yaml")).bearerTokens;
  return block === undefined ? [] : (block as agentConfigMod.AgentBearerToken[]);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agent token", () => {
  test("add records the token's hash beside the unchanged primary tokenHash", async () => {
    capture();
    try {
      const dir = await seedAgent();
      const configPath = join(dir, "agent.yaml");
      const primaryBefore = /tokenHash:\s*([0-9a-f]{64})/.exec(
        readFileSync(configPath, "utf8"),
      )?.[1];

      const code = await runAgent(["token", "add", "ci", `--dir=${dir}`]);
      expect(code).toBe(0);

      const token = /ll_agt_[A-Za-z0-9_-]+/.exec(stdoutBuf)?.[0];
      expect(token).toBeTruthy();

      const entries = bearerEntries(dir);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.name).toBe("ci");
      expect(entries[0]?.tokenHash).toBe(auth.hashToken(token!));
      expect(Date.parse(entries[0]?.createdAt ?? "")).not.toBeNaN();

      // The primary bearer is untouched: its hash is still the first tokenHash.
      expect(/tokenHash:\s*([0-9a-f]{64})/.exec(readFileSync(configPath, "utf8"))?.[1]).toBe(
        primaryBefore,
      );
    } finally {
      restore();
    }
  });

  test("add refuses an invalid or duplicate name with exit 1", async () => {
    capture();
    try {
      const dir = await seedAgent();
      expect(await runAgent(["token", "add", "Bad Name", `--dir=${dir}`])).toBe(1);
      expect(await runAgent(["token", "add", "ci", `--dir=${dir}`])).toBe(0);
      expect(await runAgent(["token", "add", "ci", `--dir=${dir}`])).toBe(1);
      expect(bearerEntries(dir)).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test("add refuses the reserved primary name default with exit 1 and mints nothing", async () => {
    capture();
    try {
      const dir = await seedAgent();
      const before = readFileSync(join(dir, "agent.yaml"), "utf8");
      expect(await runAgent(["token", "add", "default", `--dir=${dir}`])).toBe(1);
      expect(stderrBuf).toContain("token name 'default' is reserved for the primary bearer");
      expect(stdoutBuf).not.toMatch(/ll_agt_/);
      expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toBe(before);
      expect(bearerEntries(dir)).toHaveLength(0);
    } finally {
      restore();
    }
  });

  /** Seed an agent whose agent.yaml records a legacy named token called default. */
  async function seedLegacyDefault(): Promise<{ dir: string; configPath: string; hash: string }> {
    const dir = await seedAgent();
    const configPath = join(dir, "agent.yaml");
    const cfg = agentConfigMod.loadAgentConfig(configPath);
    const hash = auth.hashToken("legacy-default-token");
    agentConfigMod.saveAgentConfig(
      {
        ...cfg,
        bearerTokens: [{ name: "default", tokenHash: hash, createdAt: "2026-01-01T00:00:00.000Z" }],
      },
      configPath,
    );
    return { dir, configPath, hash };
  }

  test("an agent.yaml with a legacy named default still lets add mint another name, but not default", async () => {
    capture();
    try {
      const { dir, hash } = await seedLegacyDefault();
      expect(await runAgent(["token", "add", "default", `--dir=${dir}`])).toBe(1);
      expect(stderrBuf).toContain("token name 'default' is reserved for the primary bearer");
      expect(stdoutBuf).not.toMatch(/ll_agt_/);
      expect(bearerEntries(dir).map((e) => e.name)).toEqual(["default"]);
      expect(await runAgent(["token", "add", "graf", `--dir=${dir}`])).toBe(0);
      const entries = bearerEntries(dir);
      expect(entries.map((e) => e.name)).toEqual(["default", "graf"]);
      expect(entries[0]?.tokenHash).toBe(hash);
    } finally {
      restore();
    }
  });

  test("list shows a legacy named default and warns to rename it, without any hash", async () => {
    capture();
    try {
      const { dir, hash } = await seedLegacyDefault();
      expect(await runAgent(["token", "list", `--dir=${dir}`])).toBe(0);
      expect(stdoutBuf).toMatch(/^default\t2026-01-01T00:00:00.000Z$/m);
      expect(stderrBuf).toContain("token=named:default");
      expect(stderrBuf).toContain("llamactl agent token rename default <new-name>");
      expect(stdoutBuf + stderrBuf).not.toContain(hash);
    } finally {
      restore();
    }
  });

  test("revoke default removes a legacy named default entry", async () => {
    capture();
    try {
      const { dir, configPath } = await seedLegacyDefault();
      expect(await runAgent(["token", "revoke", "default", `--dir=${dir}`])).toBe(0);
      expect(bearerEntries(dir)).toHaveLength(0);
      expect(agentConfigMod.loadAgentConfig(configPath).bearerTokens).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("rename moves a legacy named default to a new name and keeps its hash and createdAt", async () => {
    capture();
    try {
      const { dir, hash } = await seedLegacyDefault();
      expect(await runAgent(["token", "rename", "default", "legacy-ci", `--dir=${dir}`])).toBe(0);
      expect(bearerEntries(dir)).toEqual([
        { name: "legacy-ci", tokenHash: hash, createdAt: "2026-01-01T00:00:00.000Z" },
      ]);
      expect(stdoutBuf + stderrBuf).not.toContain(hash);
    } finally {
      restore();
    }
  });

  test("rename refuses the reserved, an invalid, a taken or an unknown name with exit 1", async () => {
    capture();
    try {
      const dir = await seedAgent();
      expect(await runAgent(["token", "add", "ci", `--dir=${dir}`])).toBe(0);
      expect(await runAgent(["token", "add", "graf", `--dir=${dir}`])).toBe(0);
      const before = readFileSync(join(dir, "agent.yaml"), "utf8");
      stderrBuf = "";
      expect(await runAgent(["token", "rename", "ci", "default", `--dir=${dir}`])).toBe(1);
      expect(stderrBuf).toContain("token name 'default' is reserved for the primary bearer");
      expect(await runAgent(["token", "rename", "ci", "Bad Name", `--dir=${dir}`])).toBe(1);
      expect(await runAgent(["token", "rename", "ci", "graf", `--dir=${dir}`])).toBe(1);
      expect(await runAgent(["token", "rename", "nope", "other", `--dir=${dir}`])).toBe(1);
      expect(await runAgent(["token", "rename", "ci", `--dir=${dir}`])).toBe(1);
      expect(await runAgent(["token", "rename", "ci", "a", "b", `--dir=${dir}`])).toBe(1);
      expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toBe(before);
    } finally {
      restore();
    }
  });

  test("an otherwise invalid bearerTokens block still makes add and revoke exit 1", async () => {
    capture();
    try {
      const dir = await seedAgent();
      const configPath = join(dir, "agent.yaml");
      const cfg = agentConfigMod.loadAgentConfig(configPath);
      agentConfigMod.saveAgentConfig(
        {
          ...cfg,
          bearerTokens: [
            {
              name: "default",
              tokenHash: auth.hashToken("a"),
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            { name: "bad", tokenHash: "not-hex", createdAt: "2026-01-01T00:00:00.000Z" },
          ],
        },
        configPath,
      );
      const before = readFileSync(configPath, "utf8");
      expect(await runAgent(["token", "add", "graf", `--dir=${dir}`])).toBe(1);
      expect(await runAgent(["token", "revoke", "default", `--dir=${dir}`])).toBe(1);
      expect(stderrBuf).toContain("has an invalid bearerTokens block");
      expect(stdoutBuf).not.toMatch(/ll_agt_/);
      expect(readFileSync(configPath, "utf8")).toBe(before);
    } finally {
      restore();
    }
  });

  test("add --out writes the token at mode 0600 and never prints it", async () => {
    capture();
    try {
      const dir = await seedAgent();
      const out = join(dir, "ci.token");
      const code = await runAgent(["token", "add", "ci", `--dir=${dir}`, `--out=${out}`]);
      expect(code).toBe(0);

      const content = readFileSync(out, "utf8");
      expect(content.endsWith("\n")).toBe(true);
      const token = content.trimEnd();
      expect(token.startsWith("ll_agt_")).toBe(true);
      expect(stdoutBuf).not.toContain(token);

      const entries = bearerEntries(dir);
      expect(entries[0]?.tokenHash).toBe(auth.hashToken(token));
      expect(statSync(out).mode & 0o777).toBe(0o600);
    } finally {
      restore();
    }
  });

  test("add --out failure leaves agent.yaml untouched and prints no token", async () => {
    capture();
    try {
      const dir = await seedAgent();
      const configPath = join(dir, "agent.yaml");
      const before = readFileSync(configPath, "utf8");
      stdoutBuf = "";

      const code = await runAgent([
        "token",
        "add",
        "ci",
        `--dir=${dir}`,
        `--out=${join(dir, "no/such/dir/ci.token")}`,
      ]);
      expect(code).toBe(1);
      expect(readFileSync(configPath, "utf8")).toBe(before);
      expect(agentConfigMod.loadAgentConfig(configPath).bearerTokens).toBeUndefined();
      expect(stdoutBuf).not.toContain("ll_agt_");
    } finally {
      restore();
    }
  });

  test("add --out over an existing file leaves it at mode 0600", async () => {
    capture();
    try {
      const dir = await seedAgent();
      const out = join(dir, "ci.token");
      writeFileSync(out, "placeholder", { mode: 0o644 });

      expect(await runAgent(["token", "add", "ci", `--dir=${dir}`, `--out=${out}`])).toBe(0);
      expect(statSync(out).mode & 0o777).toBe(0o600);
      const token = readFileSync(out, "utf8").trimEnd();
      expect(token.startsWith("ll_agt_")).toBe(true);
      expect(bearerEntries(dir)[0]?.tokenHash).toBe(auth.hashToken(token));
    } finally {
      restore();
    }
  });

  test("add --json emits one line with the token, or with out when --out is set", async () => {
    capture();
    try {
      const dir = await seedAgent();
      const printed = await runAgent(["token", "add", "ci", `--dir=${dir}`, "--json"]);
      expect(printed).toBe(0);
      const record = parseJsonRecord(stdoutBuf.trim());
      expect(record["name"]).toBe("ci");
      expect(String(record["token"]).startsWith("ll_agt_")).toBe(true);
      expect(typeof record["createdAt"]).toBe("string");

      stdoutBuf = "";
      const out = join(dir, "graf.token");
      const filed = await runAgent([
        "token",
        "add",
        "graf",
        `--dir=${dir}`,
        `--out=${out}`,
        "--json",
      ]);
      expect(filed).toBe(0);
      const outRecord = parseJsonRecord(stdoutBuf.trim());
      expect(outRecord["name"]).toBe("graf");
      expect(outRecord["out"]).toBe(out);
      expect(outRecord["token"]).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("list --json names tokens without hashes, and human list is name-tab-createdAt", async () => {
    capture();
    try {
      const dir = await seedAgent();
      await runAgent(["token", "add", "ci", `--dir=${dir}`]);
      const entry = bearerEntries(dir)[0]!;

      stdoutBuf = "";
      expect(await runAgent(["token", "list", `--dir=${dir}`, "--json"])).toBe(0);
      const listed = parseJsonArray(stdoutBuf.trim());
      expect(listed).toEqual([{ name: "ci", createdAt: entry.createdAt }]);
      expect(stdoutBuf).not.toContain("tokenHash");
      expect(stdoutBuf).not.toContain("ll_agt_");

      stdoutBuf = "";
      expect(await runAgent(["token", "list", `--dir=${dir}`])).toBe(0);
      expect(stdoutBuf).toBe(`ci\t${entry.createdAt}\n`);
    } finally {
      restore();
    }
  });

  test("revoke removes the entry; an unknown name exits 1", async () => {
    capture();
    try {
      const dir = await seedAgent();
      await runAgent(["token", "add", "ci", `--dir=${dir}`]);
      await runAgent(["token", "add", "graf", `--dir=${dir}`]);

      expect(await runAgent(["token", "revoke", "nope", `--dir=${dir}`])).toBe(1);
      expect(bearerEntries(dir)).toHaveLength(2);

      expect(await runAgent(["token", "revoke", "ci", `--dir=${dir}`])).toBe(0);
      expect(bearerEntries(dir).map((e) => e.name)).toEqual(["graf"]);

      expect(await runAgent(["token", "revoke", "graf", `--dir=${dir}`])).toBe(0);
      expect(agentConfigMod.loadAgentConfig(join(dir, "agent.yaml")).bearerTokens).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("rotate-token after add keeps the named entries", async () => {
    capture();
    try {
      const dir = await seedAgent();
      await runAgent(["token", "add", "ci", `--dir=${dir}`]);
      const before = bearerEntries(dir);

      expect(await runAgent(["rotate-token", `--dir=${dir}`, "--json"])).toBe(0);
      expect(bearerEntries(dir)).toEqual(before);
    } finally {
      restore();
    }
  });

  /** Seed a config whose bearerTokens block fails validation (duplicate names). */
  async function seedMalformedBlock(): Promise<{ dir: string; before: string }> {
    const dir = await seedAgent();
    const configPath = join(dir, "agent.yaml");
    const cfg = agentConfigMod.loadAgentConfig(configPath);
    agentConfigMod.saveAgentConfig(
      {
        ...cfg,
        bearerTokens: [
          { name: "ci", tokenHash: auth.hashToken("a"), createdAt: "2026-01-01T00:00:00.000Z" },
          { name: "ci", tokenHash: auth.hashToken("b"), createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      },
      configPath,
    );
    return { dir, before: readFileSync(configPath, "utf8") };
  }

  test("a malformed block makes add exit 1 and leaves the file byte-identical", async () => {
    capture();
    try {
      const { dir, before } = await seedMalformedBlock();
      expect(await runAgent(["token", "add", "graf", `--dir=${dir}`])).toBe(1);
      expect(stderrBuf).toContain(join(dir, "agent.yaml"));
      expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toBe(before);
    } finally {
      restore();
    }
  });

  test("a malformed block makes revoke exit 1 and leaves the file byte-identical", async () => {
    capture();
    try {
      const { dir, before } = await seedMalformedBlock();
      expect(await runAgent(["token", "revoke", "ci", `--dir=${dir}`])).toBe(1);
      expect(stderrBuf).toContain(join(dir, "agent.yaml"));
      expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toBe(before);
    } finally {
      restore();
    }
  });

  test("help is only usage as the first argument; add help mints the token", async () => {
    capture();
    try {
      const dir = await seedAgent();
      expect(await runAgent(["token", "add", "help", `--dir=${dir}`])).toBe(0);
      expect(bearerEntries(dir).map((e) => e.name)).toEqual(["help"]);
      expect(await runAgent(["token", "revoke", "help", `--dir=${dir}`])).toBe(0);

      stdoutBuf = "";
      expect(await runAgent(["token", "help"])).toBe(0);
      expect(stdoutBuf).toContain("Usage: llamactl agent token");
    } finally {
      restore();
    }
  });

  test("agent token with no subcommand or a help flag prints usage and exits 0", async () => {
    capture();
    try {
      expect(await runAgent(["token"])).toBe(0);
      expect(stdoutBuf).toContain("Usage: llamactl agent token");
      stdoutBuf = "";
      expect(await runAgent(["token", "--help"])).toBe(0);
      expect(stdoutBuf).toContain("Usage: llamactl agent token");
      expect(stderrBuf).toBe("");
      expect(await runAgent(["token", "frobnicate"])).toBe(1);
    } finally {
      restore();
    }
  });

  test("buildServeOptions wires the bearerTokens reader to agent.yaml", async () => {
    capture();
    try {
      const dir = await seedAgent();
      await runAgent(["token", "add", "ci", `--dir=${dir}`]);
      const entry = bearerEntries(dir)[0]!;

      const flags = parseServeFlags([`--dir=${dir}`]);
      if ("error" in flags) throw new Error(flags.error);
      const options = buildServeOptions(
        flags,
        agentConfigMod.loadAgentConfig(join(dir, "agent.yaml")),
        {
          dialUrl: undefined,
          dialBearer: undefined,
          tunnelCentralOn: false,
          tunnelCentralBearer: undefined,
        },
        "n",
      );
      const read = options.bearerTokens?.();
      expect(read).toHaveLength(1);
      expect(read?.[0]?.name).toBe("ci");
      expect(read?.[0]?.tokenHash).toBe(entry.tokenHash);
    } finally {
      restore();
    }
  });
});
