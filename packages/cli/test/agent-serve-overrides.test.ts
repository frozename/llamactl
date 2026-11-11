import { agentConfig, type StartAgentOptions } from "@llamactl/remote";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildServeOptions, parseServeFlags, type ServeFlags } from "../src/commands/agent.js";
import { mkdtempSync, readFileSync, rmSync } from "../src/safe-fs.js";

const dirs: string[] = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const idleWiring = {
  dialUrl: undefined,
  dialBearer: undefined,
  tunnelCentralOn: false,
  tunnelCentralBearer: undefined,
};

function seedConfig(dir: string, bindHost: string, port: number): agentConfig.AgentConfig {
  const config: agentConfig.AgentConfig = {
    apiVersion: "llamactl/v1",
    kind: "AgentConfig",
    bindHost,
    port,
    certPath: join(dir, "agent.crt"),
    keyPath: join(dir, "agent.key"),
    tokenHash: "a".repeat(64),
    fingerprint: `sha256:${"b".repeat(64)}`,
  };
  agentConfig.saveAgentConfig(config, join(dir, "agent.yaml"));
  return agentConfig.loadAgentConfig(join(dir, "agent.yaml"));
}

function serveFlags(args: string[]): ServeFlags {
  const parsed = parseServeFlags(args);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

describe("agent serve bind/port overrides (#209)", () => {
  test("--bind and --port override the persisted agent.yaml values", () => {
    const dir = freshDir("serve-overrides-both-");
    const cfg = seedConfig(dir, "127.0.0.1", 7843);
    const parsed = serveFlags([`--dir=${dir}`, "--bind=0.0.0.0", "--port=9443"]);
    const options = buildServeOptions(parsed, cfg, idleWiring, "test-node");
    expect(options.bindHost).toBe("0.0.0.0");
    expect(options.port).toBe(9443);
  });

  test("agent.yaml values apply when no flags are passed", () => {
    const dir = freshDir("serve-overrides-none-");
    const cfg = seedConfig(dir, "10.0.0.5", 8123);
    const parsed = serveFlags([`--dir=${dir}`]);
    const options = buildServeOptions(parsed, cfg, idleWiring, "test-node");
    expect(options.bindHost).toBe("10.0.0.5");
    expect(options.port).toBe(8123);
  });

  test("each flag overrides independently", () => {
    const dir = freshDir("serve-overrides-split-");
    const cfg = seedConfig(dir, "127.0.0.1", 7843);
    const bindOnly = buildServeOptions(
      serveFlags([`--dir=${dir}`, "--bind=192.168.1.50"]),
      cfg,
      idleWiring,
      "test-node",
    );
    expect(bindOnly.bindHost).toBe("192.168.1.50");
    expect(bindOnly.port).toBe(7843);
    const portOnly = buildServeOptions(
      serveFlags([`--dir=${dir}`, "--port=9443"]),
      cfg,
      idleWiring,
      "test-node",
    );
    expect(portOnly.bindHost).toBe("127.0.0.1");
    expect(portOnly.port).toBe(9443);
  });

  test("--host is a bind alias for serve", () => {
    const dir = freshDir("serve-overrides-host-");
    const cfg = seedConfig(dir, "127.0.0.1", 7843);
    const parsed = serveFlags([`--dir=${dir}`, "--host=10.0.0.9"]);
    expect(parsed.bindHost).toBe("10.0.0.9");
    const options = buildServeOptions(parsed, cfg, idleWiring, "test-node");
    expect(options.bindHost).toBe("10.0.0.9");
  });

  test("overrides leave the identity fields from agent.yaml untouched", () => {
    const dir = freshDir("serve-overrides-identity-");
    const cfg = seedConfig(dir, "127.0.0.1", 7843);
    const parsed = serveFlags([`--dir=${dir}`, "--bind=0.0.0.0", "--port=9443"]);
    const options = buildServeOptions(parsed, cfg, idleWiring, "test-node");
    expect(options.tokenHash).toBe(cfg.tokenHash);
    expect(options.tls?.certPath).toBe(cfg.certPath);
    expect(options.tls?.keyPath).toBe(cfg.keyPath);
  });

  test("overrides are runtime-only; agent.yaml on disk is unchanged", () => {
    const dir = freshDir("serve-overrides-disk-");
    seedConfig(dir, "127.0.0.1", 7843);
    const before = readFileSync(join(dir, "agent.yaml"), "utf8");
    const parsed = serveFlags([`--dir=${dir}`, "--bind=0.0.0.0", "--port=9443"]);
    buildServeOptions(
      parsed,
      agentConfig.loadAgentConfig(join(dir, "agent.yaml")),
      idleWiring,
      "test-node",
    );
    expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toBe(before);
  });
});

describe("parseServeFlags for bind/port overrides", () => {
  test("parses --bind, --host and --port", () => {
    const parsed = serveFlags(["--bind=0.0.0.0", "--port=9443"]);
    expect(parsed.bindHost).toBe("0.0.0.0");
    expect(parsed.port).toBe(9443);
    const aliased = serveFlags(["--host=192.168.1.50"]);
    expect(aliased.bindHost).toBe("192.168.1.50");
  });

  test("leaves bind and port unset when not passed", () => {
    const parsed = serveFlags([]);
    expect(parsed.bindHost).toBeUndefined();
    expect(parsed.port).toBeUndefined();
  });

  test("rejects a non-numeric port", () => {
    const parsed = parseServeFlags(["--port=abc"]);
    if (!("error" in parsed)) throw new Error("expected a parse error");
    expect(parsed.error).toContain("invalid --port");
  });

  test("rejects a bare flag and an unknown flag", () => {
    const bare = parseServeFlags(["--bind"]);
    if (!("error" in bare)) throw new Error("expected a parse error");
    expect(bare.error).toContain("--key=value");
    const unknown = parseServeFlags(["--listen=0.0.0.0"]);
    if (!("error" in unknown)) throw new Error("expected a parse error");
    expect(unknown.error).toContain("unknown flag");
  });
});

describe("agent serve declared-models opt-in (#280)", () => {
  const DECLARED_MODELS_ENV = "LLAMACTL_DECLARED_MODELS";
  let savedDeclaredModelsEnv: string | undefined;

  beforeEach(() => {
    savedDeclaredModelsEnv = process.env[DECLARED_MODELS_ENV];
  });

  afterEach(() => {
    if (savedDeclaredModelsEnv === undefined) {
      Reflect.deleteProperty(process.env, DECLARED_MODELS_ENV);
    } else {
      process.env[DECLARED_MODELS_ENV] = savedDeclaredModelsEnv;
    }
  });

  function declaredModelsOption(): boolean | undefined {
    const dir = freshDir("serve-declared-");
    const cfg = seedConfig(dir, "127.0.0.1", 7843);
    const parsed = serveFlags([`--dir=${dir}`]);
    const options = buildServeOptions(parsed, cfg, idleWiring, "test-node") as StartAgentOptions & {
      declaredModels?: boolean;
    };
    return options.declaredModels;
  }

  test("unset, '0' and 'true' leave the declared-model source off", () => {
    Reflect.deleteProperty(process.env, DECLARED_MODELS_ENV);
    expect(declaredModelsOption()).not.toBe(true);
    process.env[DECLARED_MODELS_ENV] = "0";
    expect(declaredModelsOption()).not.toBe(true);
    process.env[DECLARED_MODELS_ENV] = "true";
    expect(declaredModelsOption()).not.toBe(true);
  });

  test("'1' opts the agent into the declared-model source", () => {
    process.env[DECLARED_MODELS_ENV] = "1";
    expect(declaredModelsOption()).toBe(true);
  });
});
