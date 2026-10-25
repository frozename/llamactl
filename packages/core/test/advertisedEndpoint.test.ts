import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";
import type { LocalRoute } from "../src/workloadRuntime.js";

import { writeModelHostState } from "../src/engines/state.js";
import { resolveEnv } from "../src/env.js";
import { collectNodeFacts, resolveNodeAdvertisedEndpoint } from "../src/nodeFacts.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";
import { advertisedEndpoint, dialableHost, endpoint } from "../src/server.js";

const origEnv = { ...process.env };

afterEach(() => {
  process.env = { ...origEnv };
});

describe("advertisedEndpoint", () => {
  test("falls back to bind endpoint when LLAMA_CPP_ADVERTISED_HOST is unset", () => {
    process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
    process.env["LLAMA_CPP_PORT"] = "8080";
    delete process.env["LLAMA_CPP_ADVERTISED_HOST"];
    const resolved = resolveEnv();
    expect(endpoint(resolved)).toBe("http://127.0.0.1:8080");
    expect(advertisedEndpoint(resolved)).toBe("http://127.0.0.1:8080");
  });

  test("overrides the host when LLAMA_CPP_ADVERTISED_HOST is set", () => {
    process.env["LLAMA_CPP_HOST"] = "0.0.0.0";
    process.env["LLAMA_CPP_PORT"] = "8080";
    process.env["LLAMA_CPP_ADVERTISED_HOST"] = "mac-mini.local";
    const resolved = resolveEnv();
    expect(endpoint(resolved)).toBe("http://0.0.0.0:8080");
    expect(advertisedEndpoint(resolved)).toBe("http://mac-mini.local:8080");
  });

  test("prefers LLAMA_CPP_ADVERTISED_HOST over an override host", () => {
    process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
    process.env["LLAMA_CPP_PORT"] = "8080";
    process.env["LLAMA_CPP_ADVERTISED_HOST"] = "mac-mini.local";
    const resolved = resolveEnv();
    expect(advertisedEndpoint(resolved, { host: "0.0.0.0", port: 8181 })).toBe(
      "http://mac-mini.local:8181",
    );
  });

  test("keeps bind endpoint unchanged when override matches bind", () => {
    process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
    process.env["LLAMA_CPP_PORT"] = "8080";
    process.env["LLAMA_CPP_ADVERTISED_HOST"] = "127.0.0.1";
    const resolved = resolveEnv();
    expect(endpoint(resolved)).toBe("http://127.0.0.1:8080");
    expect(advertisedEndpoint(resolved)).toBe("http://127.0.0.1:8080");
  });

  test("replaces a wildcard bind host with loopback when nothing is advertised", () => {
    process.env["LLAMA_CPP_HOST"] = "0.0.0.0";
    process.env["LLAMA_CPP_PORT"] = "8080";
    delete process.env["LLAMA_CPP_ADVERTISED_HOST"];
    const resolved = resolveEnv();
    expect(endpoint(resolved)).toBe("http://0.0.0.0:8080");
    expect(advertisedEndpoint(resolved)).toBe("http://127.0.0.1:8080");
  });

  test("falls back to a non-wildcard LLAMA_CPP_HOST over a wildcard override host", () => {
    process.env["LLAMA_CPP_HOST"] = "192.168.1.20";
    process.env["LLAMA_CPP_PORT"] = "8080";
    delete process.env["LLAMA_CPP_ADVERTISED_HOST"];
    const resolved = resolveEnv();
    expect(advertisedEndpoint(resolved, { host: "0.0.0.0", port: 8181 })).toBe(
      "http://192.168.1.20:8181",
    );
  });

  test("maps an IPv6 wildcard override host to loopback", () => {
    process.env["LLAMA_CPP_HOST"] = "0.0.0.0";
    process.env["LLAMA_CPP_PORT"] = "8080";
    delete process.env["LLAMA_CPP_ADVERTISED_HOST"];
    const resolved = resolveEnv();
    expect(advertisedEndpoint(resolved, { host: "::", port: 8080 })).toBe("http://127.0.0.1:8080");
  });
});

describe("dialableHost", () => {
  test("returns specific hosts unchanged", () => {
    const resolved = { LLAMA_CPP_HOST: "0.0.0.0" } as ResolvedEnv;
    expect(dialableHost("127.0.0.1", resolved)).toBe("127.0.0.1");
    expect(dialableHost("10.0.0.5", resolved)).toBe("10.0.0.5");
  });

  test("maps a wildcard to the advertised host when set", () => {
    const resolved = {
      LLAMA_CPP_HOST: "0.0.0.0",
      LLAMA_CPP_ADVERTISED_HOST: "z13.lan",
    } as ResolvedEnv;
    expect(dialableHost("0.0.0.0", resolved)).toBe("z13.lan");
    expect(dialableHost("::", resolved)).toBe("z13.lan");
    expect(dialableHost("[::]", resolved)).toBe("z13.lan");
  });

  test("maps a wildcard to loopback when LLAMA_CPP_HOST is also wildcard", () => {
    const resolved = { LLAMA_CPP_HOST: "0.0.0.0" } as ResolvedEnv;
    expect(dialableHost("0.0.0.0", resolved)).toBe("127.0.0.1");
  });
});

const route = (overrides: Partial<LocalRoute> = {}): LocalRoute => ({
  workload: "seat",
  model: "qwen",
  host: "127.0.0.1",
  port: 8080,
  engine: "llamacpp",
  kind: "ModelRun",
  pid: 1,
  ...overrides,
});

describe("resolveNodeAdvertisedEndpoint", () => {
  test("empty routes fall back to the env endpoint", () => {
    process.env["LLAMA_CPP_HOST"] = "0.0.0.0";
    process.env["LLAMA_CPP_PORT"] = "8080";
    process.env["LLAMA_CPP_ADVERTISED_HOST"] = "z13.lan";
    const resolved = resolveEnv();
    expect(resolveNodeAdvertisedEndpoint(resolved, [])).toBe("http://z13.lan:8080");
  });

  test("ModelRun-only routes fall back to the env endpoint", () => {
    process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
    process.env["LLAMA_CPP_PORT"] = "8080";
    delete process.env["LLAMA_CPP_ADVERTISED_HOST"];
    const resolved = resolveEnv();
    const routes = [route({ port: 8123 })];
    expect(resolveNodeAdvertisedEndpoint(resolved, routes)).toBe("http://127.0.0.1:8080");
  });

  test("wildcard ModelHost uses the advertised host and the host's port", () => {
    process.env["LLAMA_CPP_HOST"] = "0.0.0.0";
    process.env["LLAMA_CPP_PORT"] = "8080";
    process.env["LLAMA_CPP_ADVERTISED_HOST"] = "z13.lan";
    const resolved = resolveEnv();
    const routes = [route({ kind: "ModelHost", host: "0.0.0.0", port: 8094 })];
    expect(resolveNodeAdvertisedEndpoint(resolved, routes)).toBe("http://z13.lan:8094");
  });

  test("wildcard ModelHost with no advertised host uses a non-wildcard LLAMA_CPP_HOST", () => {
    process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
    process.env["LLAMA_CPP_PORT"] = "8080";
    delete process.env["LLAMA_CPP_ADVERTISED_HOST"];
    const resolved = resolveEnv();
    const routes = [route({ kind: "ModelHost", host: "0.0.0.0", port: 8094 })];
    expect(resolveNodeAdvertisedEndpoint(resolved, routes)).toBe("http://127.0.0.1:8094");
  });

  test("loopback ModelHost is reported as-is even with an advertised host", () => {
    process.env["LLAMA_CPP_HOST"] = "0.0.0.0";
    process.env["LLAMA_CPP_PORT"] = "8080";
    process.env["LLAMA_CPP_ADVERTISED_HOST"] = "z13.lan";
    const resolved = resolveEnv();
    const routes = [route({ kind: "ModelHost", host: "127.0.0.1", port: 8094 })];
    expect(resolveNodeAdvertisedEndpoint(resolved, routes)).toBe("http://127.0.0.1:8094");
  });

  test("brackets an IPv6 loopback ModelHost in the advertised URL", () => {
    process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
    process.env["LLAMA_CPP_PORT"] = "8080";
    delete process.env["LLAMA_CPP_ADVERTISED_HOST"];
    const resolved = resolveEnv();
    const routes = [route({ kind: "ModelHost", host: "::1", port: 8094 })];
    expect(resolveNodeAdvertisedEndpoint(resolved, routes)).toBe("http://[::1]:8094");
  });

  test("does not double-bracket an already-bracketed IPv6 ModelHost", () => {
    process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
    process.env["LLAMA_CPP_PORT"] = "8080";
    delete process.env["LLAMA_CPP_ADVERTISED_HOST"];
    const resolved = resolveEnv();
    const routes = [route({ kind: "ModelHost", host: "[::1]", port: 8094 })];
    expect(resolveNodeAdvertisedEndpoint(resolved, routes)).toBe("http://[::1]:8094");
  });

  test("picks the first ModelHost by workload name and leaves the input untouched", () => {
    process.env["LLAMA_CPP_HOST"] = "127.0.0.1";
    process.env["LLAMA_CPP_PORT"] = "8080";
    delete process.env["LLAMA_CPP_ADVERTISED_HOST"];
    const resolved = resolveEnv();
    const routes = [
      route({ workload: "b-host", kind: "ModelHost", port: 9001 }),
      route({ workload: "a-host", kind: "ModelHost", port: 9000 }),
    ];
    expect(resolveNodeAdvertisedEndpoint(resolved, routes)).toBe("http://127.0.0.1:9000");
    expect(routes[0]?.workload).toBe("b-host");
    expect(routes[1]?.workload).toBe("a-host");
  });
});

describe("nodeFacts.advertisedEndpoint", () => {
  test("populated from the env override", () => {
    const dir = mkdtempSync(join(tmpdir(), "nodefacts-adv-"));
    try {
      const facts = collectNodeFacts({
        ...process.env,
        LLAMA_CPP_HOST: "0.0.0.0",
        LLAMA_CPP_PORT: "8080",
        LLAMA_CPP_ADVERTISED_HOST: "gpu-mini.lan",
        LOCAL_AI_RUNTIME_DIR: dir,
      });
      expect(facts.advertisedEndpoint).toBe("http://gpu-mini.lan:8080");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("populated from the bind host when no advertised host is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "nodefacts-adv-"));
    try {
      const facts = collectNodeFacts({
        ...process.env,
        LLAMA_CPP_HOST: "127.0.0.1",
        LLAMA_CPP_PORT: "8080",
        LLAMA_CPP_ADVERTISED_HOST: "",
        LOCAL_AI_RUNTIME_DIR: dir,
      });
      expect(facts.advertisedEndpoint).toBe("http://127.0.0.1:8080");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a live ModelHost bind takes precedence over the env", () => {
    const dir = mkdtempSync(join(tmpdir(), "nodefacts-adv-"));
    try {
      writeModelHostState(
        {
          kind: "ModelHost",
          engine: "llamacpp",
          pid: process.pid,
          host: "0.0.0.0",
          port: 8094,
          modelAliases: ["qwen"],
          startedAt: new Date().toISOString(),
        },
        { name: "seat" },
        { LOCAL_AI_RUNTIME_DIR: dir } as ResolvedEnv,
      );
      const facts = collectNodeFacts({
        ...process.env,
        LLAMA_CPP_HOST: "0.0.0.0",
        LLAMA_CPP_PORT: "8080",
        LLAMA_CPP_ADVERTISED_HOST: "z13.lan",
        LOCAL_AI_RUNTIME_DIR: dir,
      });
      expect(facts.advertisedEndpoint).toBe("http://z13.lan:8094");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a dead ModelHost falls back to the env endpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "nodefacts-adv-"));
    try {
      writeModelHostState(
        {
          kind: "ModelHost",
          engine: "llamacpp",
          pid: 99999999,
          host: "0.0.0.0",
          port: 8094,
          modelAliases: ["qwen"],
          startedAt: new Date().toISOString(),
        },
        { name: "seat" },
        { LOCAL_AI_RUNTIME_DIR: dir } as ResolvedEnv,
      );
      const facts = collectNodeFacts({
        ...process.env,
        LLAMA_CPP_HOST: "0.0.0.0",
        LLAMA_CPP_PORT: "8080",
        LLAMA_CPP_ADVERTISED_HOST: "z13.lan",
        LOCAL_AI_RUNTIME_DIR: dir,
      });
      expect(facts.advertisedEndpoint).toBe("http://z13.lan:8080");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
