import { loadConfig } from "@llamactl/core/config/kubeconfig";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

import { runNode } from "../src/commands/node.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "../src/safe-fs.js";

/**
 * Pins for `llamactl node` dispatch + `ls` / `rm` / `test` argument
 * handling (frozename/llamactl#335). Each test isolates one rule and
 * names the mutation it would catch.
 */

let tmp = "";
let configPath = "";
let originalEnv: NodeJS.ProcessEnv = {};

beforeEach(() => {
  originalEnv = { ...process.env };
  tmp = mkdtempSync(join(tmpdir(), "llamactl-node-ls-rm-"));
  configPath = join(tmp, "config");
  process.env["LLAMACTL_CONFIG"] = configPath;
  process.env["DEV_STORAGE"] = tmp;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

async function capture(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s: string | Uint8Array): boolean => {
    out.push(typeof s === "string" ? s : String(s));
    return true;
  };
  process.stderr.write = (s: string | Uint8Array): boolean => {
    err.push(typeof s === "string" ? s : String(s));
    return true;
  };
  try {
    const code = await runNode(args);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

function seedConfig(nodes: unknown[], users: unknown[] = [{ name: "me", token: "tok-a" }]): void {
  writeFileSync(
    configPath,
    stringify({
      apiVersion: "llamactl/v1",
      kind: "Config",
      currentContext: "default",
      contexts: [{ name: "default", cluster: "home", user: "me", defaultNode: "local" }],
      clusters: [{ name: "home", nodes }],
      users,
    }),
  );
}

describe("node — subcommand dispatch", () => {
  test("no subcommand prints usage on stdout and exits 0", async () => {
    const { code, out, err } = await capture([]);
    expect(code).toBe(0);
    expect(out.startsWith("Usage: llamactl node <subcommand>")).toBe(true);
    expect(err).toBe("");
  });

  test.each(["--help", "-h", "help"])("%s prints the same usage and exits 0", async (flag) => {
    const { code, out, err } = await capture([flag]);
    expect(code).toBe(0);
    expect(out.startsWith("Usage: llamactl node <subcommand>")).toBe(true);
    expect(err).toBe("");
  });

  test("unknown subcommand exits 1 with usage on stderr", async () => {
    const { code, out, err } = await capture(["frobnicate"]);
    expect(code).toBe(1);
    expect(err.startsWith("Unknown node subcommand: frobnicate")).toBe(true);
    expect(err).toContain("Usage: llamactl node");
    expect(out).toBe("");
  });
});

describe("node ls", () => {
  test("--json with no config file lists the fresh default context", async () => {
    const { code, out } = await capture(["ls", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as {
      context: string;
      nodes: { name: string; endpoint: string }[];
    };
    expect(parsed.context).toBe("default");
    expect(parsed.nodes).toEqual([{ name: "local", endpoint: "inproc://local" }]);
  });

  test("unknown argument exits 1 with no stdout", async () => {
    const { code, out, err } = await capture(["ls", "--wide"]);
    expect(code).toBe(1);
    expect(err).toBe("node ls: unknown argument --wide\n");
    expect(out).toBe("");
  });

  test("names pad to the longest name and only defaultNode is marked", async () => {
    seedConfig([
      { name: "local", endpoint: "inproc://local" },
      { name: "gpu-long", endpoint: "https://gpu.lan:7843" },
    ]);
    const { code, out } = await capture(["ls"]);
    expect(code).toBe(0);
    expect(out).toBe("local     inproc://local (default)\ngpu-long  https://gpu.lan:7843\n");
  });

  test("empty cluster prints the placeholder and exits 0", async () => {
    seedConfig([]);
    const { code, out, err } = await capture(["ls"]);
    expect(code).toBe(0);
    expect(out).toBe("(no nodes in context default)\n");
    expect(err).toBe("");
  });
});

describe("node rm", () => {
  test("missing name exits 1", async () => {
    const { code, err } = await capture(["rm"]);
    expect(code).toBe(1);
    expect(err).toBe("node rm: missing <name>\n");
  });

  test("dash-prefixed name counts as missing", async () => {
    const { code, err } = await capture(["rm", "--x"]);
    expect(code).toBe(1);
    expect(err).toBe("node rm: missing <name>\n");
  });

  test("extra argument exits 1 and leaves the config byte-identical", async () => {
    seedConfig([
      { name: "local", endpoint: "inproc://local" },
      { name: "gpu", endpoint: "https://gpu.lan:7843" },
    ]);
    const before = readFileSync(configPath, "utf8");
    const { code, err } = await capture(["rm", "gpu", "extra"]);
    expect(code).toBe(1);
    expect(err).toBe("node rm: unexpected argument extra\n");
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("removes only the named node", async () => {
    seedConfig([
      { name: "local", endpoint: "inproc://local" },
      { name: "gpu", endpoint: "https://gpu.lan:7843" },
    ]);
    const { code, out } = await capture(["rm", "gpu"]);
    expect(code).toBe(0);
    expect(out).toBe("removed node 'gpu' from context 'default'\n");
    const nodes = loadConfig(configPath).clusters.find((c) => c.name === "home")!.nodes;
    expect(nodes.some((n) => n.name === "gpu")).toBe(false);
    expect(nodes.some((n) => n.name === "local")).toBe(true);
  });
});

describe("node test", () => {
  test("missing name exits 1", async () => {
    const { code, err } = await capture(["test"]);
    expect(code).toBe(1);
    expect(err).toBe("node test: missing <name>\n");
  });

  test("extra argument exits 1 before the config is resolved", async () => {
    const { code, err } = await capture(["test", "gpu", "extra"]);
    expect(code).toBe(1);
    expect(err).toBe("node test: unexpected argument extra\n");
  });
});
