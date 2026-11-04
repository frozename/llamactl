import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

import { runTunnel } from "../src/commands/tunnel.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "../src/safe-fs.js";

/**
 * Pins for `llamactl tunnel pin-central` flag parsing + precondition
 * error handling (frozename/llamactl#335). Each test isolates one rule
 * and names the mutation it would catch.
 */

let tmp = "";
let configPath = "";
let originalEnv: NodeJS.ProcessEnv = {};

beforeEach(() => {
  originalEnv = { ...process.env };
  tmp = mkdtempSync(join(tmpdir(), "llamactl-tunnel-pin-"));
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
    const code = await runTunnel(args);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

function seedConfig(
  contexts: {
    name: string;
    cluster: string;
    user: string;
    defaultNode: string;
    tunnelCentralUrl?: string;
  }[],
  currentContext: string,
): void {
  writeFileSync(
    configPath,
    stringify({
      apiVersion: "llamactl/v1",
      kind: "Config",
      currentContext,
      contexts,
      clusters: [{ name: "home", nodes: [{ name: "local", endpoint: "inproc://local" }] }],
      users: [{ name: "me", token: "tok-a" }],
    }),
  );
}

describe("tunnel — subcommand dispatch", () => {
  test("no subcommand prints usage on stdout and exits 0", async () => {
    const { code, out, err } = await capture([]);
    expect(code).toBe(0);
    expect(out).toContain("llamactl tunnel");
    expect(out).toContain("pin-central");
    expect(err).toBe("");
  });

  test('["--help"] prints the same usage and exits 0', async () => {
    const { code, out, err } = await capture(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("llamactl tunnel");
    expect(err).toBe("");
  });

  test('["-h"] prints the same usage and exits 0', async () => {
    const { code, out, err } = await capture(["-h"]);
    expect(code).toBe(0);
    expect(out).toContain("llamactl tunnel");
    expect(err).toBe("");
  });

  test("unknown subcommand exits 1 with usage on stderr", async () => {
    const { code, out, err } = await capture(["bogus"]);
    expect(code).toBe(1);
    expect(err.startsWith("unknown subcommand: tunnel bogus")).toBe(true);
    expect(err).toContain("llamactl tunnel");
    expect(out).toBe("");
  });
});

describe("tunnel pin-central — usage before config", () => {
  test('["pin-central","--help"] returns 0 with usage on stdout and empty stderr', async () => {
    // Mutation: treat "help" like the other errors (exit 1 with stderr).
    const { code, out, err } = await capture(["pin-central", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("llamactl tunnel");
    expect(err).toBe("");
  });
});

describe("tunnel pin-central — flag parsing", () => {
  test('["pin-central","foo"] rejects unexpected positional', async () => {
    // Mutation: silently ignore unexpected positional args.
    const { code, err } = await capture(["pin-central", "foo"]);
    expect(code).toBe(1);
    expect(err).toContain("tunnel pin-central: unexpected positional foo");
  });

  test('["pin-central","--context","x"] rejects space-separated flag', async () => {
    // Mutation: accept space-separated --context x form.
    const { code, err } = await capture(["pin-central", "--context", "x"]);
    expect(code).toBe(1);
    expect(err).toContain("tunnel pin-central: flag must be --key=value: --context");
  });

  test('["pin-central","--bogus=1"] rejects unknown flags', async () => {
    // Mutation: silently ignore unknown flags.
    const { code, err } = await capture(["pin-central", "--bogus=1"]);
    expect(code).toBe(1);
    expect(err).toContain("tunnel pin-central: unknown flag --bogus");
  });
});

describe("tunnel pin-central — precondition errors", () => {
  test("--context=missing gives context-not-found with resolved config path", async () => {
    // Mutation: use a hardcoded config path instead of the resolved one.
    seedConfig([{ name: "default", cluster: "home", user: "me", defaultNode: "local" }], "default");
    const { code, err } = await capture(["pin-central", "--context=missing"]);
    expect(code).toBe(1);
    expect(err).toContain("context 'missing' not found in");
    expect(err).toContain(configPath);
  });

  test("no --context uses currentContext which may lack tunnelCentralUrl", async () => {
    // Mutation: default to contexts[0] or the wrong name instead of cfg.currentContext.
    seedConfig(
      [
        { name: "default", cluster: "home", user: "me", defaultNode: "local" },
        {
          name: "remote",
          cluster: "home",
          user: "me",
          defaultNode: "local",
          tunnelCentralUrl: "https://127.0.0.1:1",
        },
      ],
      "default",
    );
    const { code, err } = await capture(["pin-central"]);
    expect(code).toBe(1);
    expect(err).toContain("context 'default' has no tunnelCentralUrl");
  });

  test("--url= (empty) does not fall back to the context URL", async () => {
    // Mutation: `??` changed to `||` would dial the context URL instead of refusing.
    seedConfig(
      [
        {
          name: "default",
          cluster: "home",
          user: "me",
          defaultNode: "local",
          tunnelCentralUrl: "https://127.0.0.1:1",
        },
      ],
      "default",
    );
    const { code, err } = await capture(["pin-central", "--url="]);
    expect(code).toBe(1);
    expect(err).toContain("has no tunnelCentralUrl");
  });

  test("--url=not-a-url gives invalid URL error", async () => {
    // Mutation: pass the string through to the TLS layer instead of validating.
    seedConfig([{ name: "default", cluster: "home", user: "me", defaultNode: "local" }], "default");
    const { code, err } = await capture(["pin-central", "--url=not-a-url"]);
    expect(code).toBe(1);
    expect(err).toContain("invalid URL 'not-a-url'");
  });

  test("--url overrides the context URL", async () => {
    // Mutation: prefer ctx.tunnelCentralUrl over the flag.
    seedConfig(
      [
        {
          name: "default",
          cluster: "home",
          user: "me",
          defaultNode: "local",
          tunnelCentralUrl: "https://127.0.0.1:1",
        },
      ],
      "default",
    );
    const { code, err } = await capture(["pin-central", "--url=http://127.0.0.1:1"]);
    expect(code).toBe(1);
    expect(err).toContain("must be https:// (got 'http:')");
  });

  test("context tunnelCentralUrl of http:// is also refused", async () => {
    // Mutation: drop the protocol check entirely.
    seedConfig(
      [
        {
          name: "default",
          cluster: "home",
          user: "me",
          defaultNode: "local",
          tunnelCentralUrl: "http://127.0.0.1:1",
        },
      ],
      "default",
    );
    const { code, err } = await capture(["pin-central"]);
    expect(code).toBe(1);
    expect(err).toContain("must be https:// (got 'http:')");
  });

  test("--url=https://127.0.0.1:0 gives invalid port", async () => {
    // Mutation: `port <= 0` changed to `port < 0` would accept port 0.
    seedConfig([{ name: "default", cluster: "home", user: "me", defaultNode: "local" }], "default");
    const { code, err } = await capture(["pin-central", "--url=https://127.0.0.1:0"]);
    expect(code).toBe(1);
    expect(err).toContain("invalid port '0'");
  });

  test("refusal leaves the config file byte-identical with no TLS fields", async () => {
    // Mutation: mutateConfig before validation writes partial state.
    seedConfig(
      [
        {
          name: "default",
          cluster: "home",
          user: "me",
          defaultNode: "local",
          tunnelCentralUrl: "https://127.0.0.1:1",
        },
      ],
      "default",
    );
    const before = readFileSync(configPath, "utf8");
    const { code, err } = await capture(["pin-central", "--url=http://127.0.0.1:1"]);
    expect(code).toBe(1);
    const after = readFileSync(configPath, "utf8");
    expect(after).toBe(before);
    expect(after).not.toContain("tunnelCentralCertificate");
    expect(after).not.toContain("tunnelCentralFingerprint");
  });
});
