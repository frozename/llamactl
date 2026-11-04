import type { ClusterNode } from "@llamactl/core/config/schema";

import { loadConfig } from "@llamactl/core/config/kubeconfig";
import { agentConfig } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

import { runNode } from "../src/commands/node.js";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "../src/safe-fs.js";

/**
 * Pins for `llamactl node add` argument parsing, credential
 * resolution and persistence (frozename/llamactl#335). Every add
 * passes --force so the reachability probe never runs.
 */

const FP = `sha256:${"a".repeat(64)}`;

let tmp = "";
let configPath = "";
let originalEnv: NodeJS.ProcessEnv = {};

beforeEach(() => {
  originalEnv = { ...process.env };
  tmp = mkdtempSync(join(tmpdir(), "llamactl-node-add-args-"));
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

function seedConfig(nodes: unknown[], users: unknown[]): void {
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

function nodeEntry(name: string): ClusterNode | undefined {
  return loadConfig(configPath)
    .clusters.find((c) => c.name === "home")!
    .nodes.find((n) => n.name === name);
}

describe("node add — argument errors", () => {
  test("no arguments exits 1", async () => {
    const { code, err } = await capture(["add"]);
    expect(code).toBe(1);
    expect(err).toBe("node add: missing <name>\n");
  });

  test("--force alone still misses the name", async () => {
    const { code, err } = await capture(["add", "--force"]);
    expect(code).toBe(1);
    expect(err).toBe("node add: missing <name>\n");
  });

  test("unknown argument exits 1 and never creates the config file", async () => {
    const { code, err } = await capture(["add", "gpu", "--bogus"]);
    expect(code).toBe(1);
    expect(err).toBe("node add: unknown argument --bogus\n");
    expect(existsSync(configPath)).toBe(false);
  });

  test("--server without --fingerprint exits 1 with the credentials hint", async () => {
    const { code, err } = await capture([
      "add",
      "gpu",
      "--server",
      "https://x:1",
      "--token",
      "t",
      "--force",
    ]);
    expect(code).toBe(1);
    expect(err).toContain(
      "--bootstrap or (--server + --fingerprint + --token|--token-file) required",
    );
  });
});

describe("node add — credential sources", () => {
  test("inline --key=value form parses and persists the node", async () => {
    const { code } = await capture([
      "add",
      "gpu",
      "--server=https://gpu.lan:7843",
      `--fingerprint=${FP}`,
      "--token=tok-x",
      "--force",
    ]);
    expect(code).toBe(0);
    const node = nodeEntry("gpu");
    expect(node?.endpoint).toBe("https://gpu.lan:7843");
    expect(node?.certificateFingerprint).toBe(FP);
  });

  test("--token-file contents are trimmed", async () => {
    const tokenFile = join(tmp, "tok");
    writeFileSync(tokenFile, "tok-from-file\n\n");
    const { code } = await capture([
      "add",
      "gpu",
      "--server",
      "https://gpu.lan:7843",
      "--fingerprint",
      FP,
      "--token-file",
      tokenFile,
      "--force",
    ]);
    expect(code).toBe(0);
    expect(loadConfig(configPath).users[0]?.token).toBe("tok-from-file");
  });

  test("bootstrap certificate is copied onto the node entry", async () => {
    const certificate = "-----BEGIN CERTIFICATE-----\nABCD\n-----END CERTIFICATE-----\n";
    const blob = agentConfig.encodeBootstrap({
      url: "https://gpu1.lan:7843",
      fingerprint: FP,
      token: "tok-boot",
      certificate,
    });
    const { code } = await capture(["add", "gpu1", "--bootstrap", blob, "--force"]);
    expect(code).toBe(0);
    expect(nodeEntry("gpu1")?.certificate).toBe(certificate);
  });

  test("tokenRef user gets a 0600 token file and keeps the ref", async () => {
    const tokenRef = join(tmp, "secrets", "token");
    seedConfig([{ name: "local", endpoint: "inproc://local" }], [{ name: "me", tokenRef }]);
    const { code } = await capture([
      "add",
      "gpu",
      "--server",
      "https://gpu.lan:7843",
      "--fingerprint",
      FP,
      "--token",
      "tok-ref",
      "--force",
    ]);
    expect(code).toBe(0);
    expect(existsSync(tokenRef)).toBe(true);
    expect(readFileSync(tokenRef, "utf8")).toBe("tok-ref");
    expect(statSync(tokenRef).mode & 0o777).toBe(0o600);
    const user = loadConfig(configPath).users.find((u) => u.name === "me");
    expect(user?.tokenRef).toBe(tokenRef);
    expect(user?.token).toBeUndefined();
  });
});

describe("node add — --force success line", () => {
  test("unverified persistence prints the exact confirmation", async () => {
    const { code, out } = await capture([
      "add",
      "gpu",
      "--server",
      "https://gpu.lan:7843",
      "--fingerprint",
      FP,
      "--token",
      "tok-x",
      "--force",
    ]);
    expect(code).toBe(0);
    expect(out).toBe("added node 'gpu' (https://gpu.lan:7843) to context 'default' [unverified]\n");
  });
});
