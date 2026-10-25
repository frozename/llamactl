import { agentConfig, auth } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgent } from "../src/commands/agent.js";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "../src/safe-fs.js";

/**
 * #222: `agent set-token` adopts an externally issued token hash (e.g. a
 * central's cluster token) into agent.yaml instead of hand-editing it,
 * backing the previous file up to agent.yaml.bak and never printing the
 * token it hashed.
 */

const MALFORMED = [
  "workerRpc: # enabled by hand; the digest was pasted in upper case",
  "  versions: [{major: 1, minor: 0}]",
  "  serviceCredentials:",
  `    - {serviceId: s, operations: [submit], deployments: [], models: [], tenants: [t], tokenHash: ${"A".repeat(64)}}`,
].join("\n");

let dirs: string[] = [];
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

async function seed(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-set-token-"));
  dirs.push(dir);
  const r = await capture(["init", `--dir=${dir}`, "--json"]);
  expect(r.code).toBe(0);
  return dir;
}

async function expectRefused(dir: string, args: string[]): Promise<void> {
  const cfgPath = join(dir, "agent.yaml");
  const before = readFileSync(cfgPath);
  const r = await capture(["set-token", `--dir=${dir}`, ...args]);
  expect(r.code).toBe(1);
  expect(readFileSync(cfgPath)).toEqual(before);
  expect(existsSync(`${cfgPath}.bak`)).toBe(false);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-set-token-base-"));
  dirs = [tmp];
});

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("agent set-token", () => {
  test("an uppercase --hash is stored lowercased with a 0600 backup", async () => {
    const dir = await seed();
    const cfgPath = join(dir, "agent.yaml");
    const before = readFileSync(cfgPath);
    const inoBefore = statSync(cfgPath).ino;
    const entriesBefore = readdirSync(dir).sort();
    const old = agentConfig.loadAgentConfig(cfgPath);

    const r = await capture(["set-token", `--dir=${dir}`, `--hash=${"F".repeat(64)}`]);
    expect(r.code).toBe(0);

    const next = agentConfig.loadAgentConfig(cfgPath);
    expect(next.tokenHash).toBe("f".repeat(64));
    expect(next.certPath).toBe(old.certPath);
    expect(next.keyPath).toBe(old.keyPath);
    expect(next.fingerprint).toBe(old.fingerprint);
    expect(next.nodeName).toBe(old.nodeName);
    expect(next.port).toBe(old.port);

    const stat = statSync(cfgPath);
    expect(stat.ino).not.toBe(inoBefore);
    expect(stat.mode & 0o777).toBe(0o600);

    const bak = `${cfgPath}.bak`;
    expect(readFileSync(bak)).toEqual(before);
    expect(statSync(bak).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual([...entriesBefore, "agent.yaml.bak"].sort());

    expect(r.out).toContain("401");
    expect(r.out).toContain("Restart the agent");
  });

  test("--token-file is hashed locally and never echoed", async () => {
    const dir = await seed();
    const cfgPath = join(dir, "agent.yaml");
    const tokenPath = join(dir, "token");
    writeFileSync(tokenPath, "ll_agt_example-token\n");

    const r = await capture(["set-token", `--dir=${dir}`, `--token-file=${tokenPath}`]);
    expect(r.code).toBe(0);
    expect(agentConfig.loadAgentConfig(cfgPath).tokenHash).toBe(
      auth.hashToken("ll_agt_example-token"),
    );
    expect(r.out).not.toContain("ll_agt_example-token");
    expect(r.err).not.toContain("ll_agt_example-token");
  });

  test("a malformed workerRpc block survives the rewrite verbatim", async () => {
    const dir = await seed();
    const cfgPath = join(dir, "agent.yaml");
    appendFileSync(cfgPath, `\n${MALFORMED}\n`);

    const r = await capture(["set-token", `--dir=${dir}`, `--hash=${"c".repeat(64)}`]);
    expect(r.code).toBe(0);
    expect(readFileSync(cfgPath, "utf8")).toContain(MALFORMED);
  });

  test("the current hash is a no-op: no backup, no rewrite", async () => {
    const dir = await seed();
    const cfgPath = join(dir, "agent.yaml");
    const current = agentConfig.loadAgentConfig(cfgPath).tokenHash;
    const before = readFileSync(cfgPath);
    const inoBefore = statSync(cfgPath).ino;

    const r = await capture(["set-token", `--dir=${dir}`, `--hash=${current}`]);
    expect(r.code).toBe(0);
    expect(statSync(cfgPath).ino).toBe(inoBefore);
    expect(readFileSync(cfgPath)).toEqual(before);
    expect(existsSync(`${cfgPath}.bak`)).toBe(false);
  });

  test("a short --hash exits 1 without touching agent.yaml", async () => {
    const dir = await seed();
    await expectRefused(dir, ["--hash=abc"]);
  });

  test("a 64-char --hash with a non-hex letter exits 1", async () => {
    const dir = await seed();
    await expectRefused(dir, [`--hash=${"g".repeat(64)}`]);
  });

  test("a plaintext token in --hash is refused without echoing it", async () => {
    const dir = await seed();
    const cfgPath = join(dir, "agent.yaml");
    const before = readFileSync(cfgPath);
    const r = await capture(["set-token", `--dir=${dir}`, "--hash=ll_agt_secretvalue"]);
    expect(r.code).toBe(1);
    expect(r.err).not.toContain("ll_agt_secretvalue");
    expect(readFileSync(cfgPath)).toEqual(before);
    expect(existsSync(`${cfgPath}.bak`)).toBe(false);
  });

  test("both --hash and --token-file exit 1", async () => {
    const dir = await seed();
    const tokenPath = join(dir, "token");
    writeFileSync(tokenPath, "ll_agt_example-token\n");
    await expectRefused(dir, [`--hash=${"d".repeat(64)}`, `--token-file=${tokenPath}`]);
  });

  test("neither --hash nor --token-file exits 1", async () => {
    const dir = await seed();
    await expectRefused(dir, []);
  });

  test("an empty token file exits 1", async () => {
    const dir = await seed();
    const tokenPath = join(dir, "token");
    writeFileSync(tokenPath, "");
    await expectRefused(dir, [`--token-file=${tokenPath}`]);
  });

  test("a missing token file exits 1", async () => {
    const dir = await seed();
    await expectRefused(dir, [`--token-file=${join(tmp, "nope")}`]);
  });

  test("an unknown flag exits 1", async () => {
    const dir = await seed();
    await expectRefused(dir, ["--bogus=1"]);
  });

  test("a dir without agent.yaml exits 1", async () => {
    const r = await capture(["set-token", `--dir=${tmp}`, `--hash=${"e".repeat(64)}`]);
    expect(r.code).toBe(1);
    expect(existsSync(join(tmp, "agent.yaml"))).toBe(false);
  });

  test("an existing backup symlink is replaced, never written through", async () => {
    const dir = await seed();
    const cfgPath = join(dir, "agent.yaml");
    const before = readFileSync(cfgPath);
    const victim = join(tmp, "victim");
    writeFileSync(victim, "do not overwrite me\n");
    symlinkSync(victim, `${cfgPath}.bak`);

    const r = await capture(["set-token", `--dir=${dir}`, `--hash=${"9".repeat(64)}`]);
    expect(r.code).toBe(0);

    expect(readFileSync(victim, "utf8")).toBe("do not overwrite me\n");
    const bak = `${cfgPath}.bak`;
    expect(lstatSync(bak).isSymbolicLink()).toBe(false);
    expect(readFileSync(bak)).toEqual(before);
    expect(statSync(bak).mode & 0o777).toBe(0o600);
  });

  test("a repeated backup replaces the prior one in place", async () => {
    const dir = await seed();
    const cfgPath = join(dir, "agent.yaml");
    const bak = `${cfgPath}.bak`;
    const v0 = readFileSync(cfgPath);

    const first = await capture(["set-token", `--dir=${dir}`, `--hash=${"a".repeat(64)}`]);
    expect(first.code).toBe(0);
    expect(readFileSync(bak)).toEqual(v0);
    const v1 = readFileSync(cfgPath);

    const second = await capture(["set-token", `--dir=${dir}`, `--hash=${"b".repeat(64)}`]);
    expect(second.code).toBe(0);

    expect(readFileSync(bak)).toEqual(v1);
    expect(readFileSync(cfgPath)).not.toEqual(v1);
    expect(statSync(bak).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  test("a fresh backup is created at 0600 under a 022 umask", async () => {
    const dir = await seed();
    const cfgPath = join(dir, "agent.yaml");
    const bak = `${cfgPath}.bak`;
    const prevUmask = process.umask(0o022);
    try {
      const r = await capture(["set-token", `--dir=${dir}`, `--hash=${"7".repeat(64)}`]);
      expect(r.code).toBe(0);
    } finally {
      process.umask(prevUmask);
    }

    expect(statSync(bak).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});
