import { loadConfig } from "@llamactl/core/config/kubeconfig";
import { agentConfig } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { readFileSync, writeFileSync } from "../src/safe-fs.js";
import { makeTempRuntime, runCli } from "./helpers.js";

/**
 * `node add` writes the new node's bearer into the context user —
 * the single token every remote agent node authenticates with. When
 * other remote agent nodes exist, the add must be refused unless the
 * operator passes --replace-token, and a refusal must leave the
 * config byte-identical.
 */

let temp: ReturnType<typeof makeTempRuntime>;
let cfgPath = "";

function augment(env: NodeJS.ProcessEnv, devStorage: string): NodeJS.ProcessEnv {
  return {
    ...env,
    LLAMACTL_CONFIG: join(devStorage, "config"),
  };
}

function seedConfig(path: string): void {
  writeFileSync(
    path,
    stringifyYaml({
      apiVersion: "llamactl/v1",
      kind: "Config",
      currentContext: "default",
      contexts: [{ name: "default", cluster: "home", user: "me", defaultNode: "local" }],
      clusters: [
        {
          name: "home",
          nodes: [
            { name: "local", endpoint: "inproc://local" },
            {
              name: "mac-mini",
              endpoint: "https://mac-mini.lan:7843",
              certificateFingerprint: "sha256:" + "a".repeat(64),
            },
          ],
        },
      ],
      users: [{ name: "me", token: "tok-a" }],
    }),
  );
}

beforeEach(() => {
  temp = makeTempRuntime();
  cfgPath = join(temp.devStorage, "config");
  seedConfig(cfgPath);
});
afterEach(() => {
  temp.cleanup();
});

describe("node add — shared user token guard", () => {
  test("explicit --token differing from the current one is refused", () => {
    const env = augment(temp.env, temp.devStorage);
    const before = readFileSync(cfgPath);
    const r = runCli(
      [
        "node",
        "add",
        "gpu2",
        "--server",
        "https://gpu2.lan:7843",
        "--fingerprint",
        "sha256:" + "b".repeat(64),
        "--token",
        "tok-b",
        "--force",
      ],
      env,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("node add: ");
    expect(r.stderr).toContain("mac-mini");
    expect(r.stderr).toContain("--replace-token");
    expect(readFileSync(cfgPath)).toEqual(before);
  });

  test("bootstrap blob with a differing token is refused the same way", () => {
    const env = augment(temp.env, temp.devStorage);
    const blob = agentConfig.encodeBootstrap({
      url: "https://gpu2.lan:7843",
      fingerprint: "sha256:" + "b".repeat(64),
      token: "tok-b",
      certificate: "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n",
    });
    const before = readFileSync(cfgPath);
    const r = runCli(["node", "add", "gpu2", "--bootstrap", blob, "--force"], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("mac-mini");
    expect(r.stderr).toContain("--replace-token");
    expect(readFileSync(cfgPath)).toEqual(before);
  });

  test("--replace-token overrides the guard", () => {
    const env = augment(temp.env, temp.devStorage);
    const r = runCli(
      [
        "node",
        "add",
        "gpu2",
        "--server",
        "https://gpu2.lan:7843",
        "--fingerprint",
        "sha256:" + "b".repeat(64),
        "--token",
        "tok-b",
        "--force",
        "--replace-token",
      ],
      env,
    );
    expect(r.code).toBe(0);
    const cfg = loadConfig(cfgPath);
    expect(cfg.users.find((u) => u.name === "me")?.token).toBe("tok-b");
    const cluster = cfg.clusters.find((c) => c.name === "home")!;
    expect(cluster.nodes.some((n) => n.name === "gpu2")).toBe(true);
  });

  test("same token as the current user token passes", () => {
    const env = augment(temp.env, temp.devStorage);
    const r = runCli(
      [
        "node",
        "add",
        "gpu2",
        "--server",
        "https://gpu2.lan:7843",
        "--fingerprint",
        "sha256:" + "b".repeat(64),
        "--token",
        "tok-a",
        "--force",
      ],
      env,
    );
    expect(r.code).toBe(0);
    const cfg = loadConfig(cfgPath);
    expect(cfg.users.find((u) => u.name === "me")?.token).toBe("tok-a");
    const cluster = cfg.clusters.find((c) => c.name === "home")!;
    expect(cluster.nodes.some((n) => n.name === "gpu2")).toBe(true);
  });
});
