// Issue frozename/llamactl#335 — the agent artifact manifest and current-pointer
// validation in src/server/artifacts.ts. Nothing pins it today: artifacts.test.ts
// only walks the legacy top-level layout, and artifacts-versioned.test.ts feeds the
// handler one hand-written valid manifest (the invalid-pointer and same-name
// republish cases at lines 219-263 and 376+). Every field rule of the build
// manifest, the build-name grammar and the pointer's unreadable/whitespace/reason
// paths are unpinned, so they are pinned here. Fixtures are seeded by hand under a
// temp dir; the suite reads no environment variables.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import {
  AGENT_BUILD_NAME_RE,
  agentBuildBinaryPath,
  agentBuildDir,
  agentBuildName,
  agentCurrentPointerPath,
  handleArtifact,
  readAgentBuildManifest,
  readCurrentAgentBuild,
} from "../src/server/artifacts.js";

type ManifestRecord = Record<string, unknown>;

interface HandlerResult {
  status: number;
  headers: Headers;
  body: string;
}

interface InvalidFieldCase {
  key: string;
  value: unknown;
}

interface InvalidPointerCase {
  raw: string;
  reason: string;
  label: string;
}

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const PLATFORM = "linux-arm64";
const COMMIT = "0f1e2d3c4b5a69788796a5b4c3d2e1f012345678";
const BUILD = "0f1e2d3c4b5a";
const BUILT_AT = "2026-11-17T10:00:00.000Z";
const BYTES = "agent-binary-bytes";
const BYTES_SHA = sha256hex(BYTES);
const MANIFEST_KEYS = ["platform", "commit", "dirty", "sha256", "builtAt", "bun", "signIdentity"];

let dir = "";

function platformDir(): string {
  return join(dir, "agent", PLATFORM);
}

function buildDir(name: string): string {
  return join(platformDir(), name);
}

function manifestPath(name: string): string {
  return join(buildDir(name), "manifest.json");
}

function pointerPath(): string {
  return join(platformDir(), "current");
}

function validManifest(): ManifestRecord {
  return {
    platform: PLATFORM,
    commit: COMMIT,
    dirty: false,
    sha256: BYTES_SHA,
    builtAt: BUILT_AT,
    bun: "1.4.3",
    signIdentity: null,
  };
}

function writeManifestText(text: string, name = BUILD): void {
  mkdirSync(buildDir(name), { recursive: true });
  writeFileSync(manifestPath(name), text, "utf8");
}

function writeManifest(record: ManifestRecord, name = BUILD): void {
  writeManifestText(JSON.stringify(record), name);
}

function manifestWithout(key: string): ManifestRecord {
  const record: ManifestRecord = {};
  for (const [field, value] of Object.entries(validManifest())) {
    if (field !== key) {
      record[field] = value;
    }
  }
  return record;
}

function writeBuildBinary(name = BUILD, bytes = BYTES): void {
  mkdirSync(buildDir(name), { recursive: true });
  writeFileSync(join(buildDir(name), "llamactl-agent"), bytes, "utf8");
}

function writeLegacyTopLevel(bytes: string): void {
  mkdirSync(platformDir(), { recursive: true });
  writeFileSync(join(platformDir(), "llamactl-agent"), bytes, "utf8");
}

function writeCurrent(content: string): void {
  mkdirSync(platformDir(), { recursive: true });
  writeFileSync(pointerPath(), content, "utf8");
}

async function call(method: "GET" | "HEAD" = "GET"): Promise<HandlerResult> {
  const req = new Request(`http://agent/artifacts/agent/${PLATFORM}`, { method });
  const res = handleArtifact(req, new URL(req.url), { artifactsDir: dir });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llamactl-artifacts-manifest-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("agent build name grammar + layout (#335)", () => {
  test("AGENT_BUILD_NAME_RE accepts exactly 12 lowercase hex, bare or -dirty", () => {
    for (const name of [BUILD, `${BUILD}-dirty`, "000000000000", `${COMMIT.slice(0, 12)}-dirty`]) {
      expect(AGENT_BUILD_NAME_RE.test(name)).toBe(true);
    }
  });

  test("AGENT_BUILD_NAME_RE rejects any other shape", () => {
    const rejected = [
      "",
      "abcdef7",
      "0f1e2d3c4b5",
      "0f1e2d3c4b5a1",
      "0F1E2D3C4B5A",
      "0f1e2d3c4b5A",
      "0f1e2d3c4b5a-",
      "0f1e2d3c4b5a-dirtyy",
      "0f1e2d3c4b5adirty",
      "current",
      "v0.9.0",
      "0f1e2d3c4b5a/llamactl-agent",
      "0f1e2d3c4b5a ",
    ];
    for (const name of rejected) {
      expect(AGENT_BUILD_NAME_RE.test(name)).toBe(false);
    }
  });

  test("agentBuildName truncates the commit to 12 chars and flags a dirty tree", () => {
    expect(agentBuildName(COMMIT, false)).toBe(BUILD);
    expect(agentBuildName(COMMIT, true)).toBe(`${BUILD}-dirty`);
    expect(AGENT_BUILD_NAME_RE.test(agentBuildName(COMMIT, false))).toBe(true);
    expect(AGENT_BUILD_NAME_RE.test(agentBuildName(COMMIT, true))).toBe(true);
  });

  test("build dir, binary and current pointer nest under agent/<platform>", () => {
    expect(agentBuildDir(PLATFORM, BUILD, dir)).toBe(join(dir, "agent", PLATFORM, BUILD));
    expect(agentBuildBinaryPath(PLATFORM, BUILD, dir)).toBe(
      join(dir, "agent", PLATFORM, BUILD, "llamactl-agent"),
    );
    expect(agentCurrentPointerPath(PLATFORM, dir)).toBe(join(dir, "agent", PLATFORM, "current"));
  });
});

describe("readAgentBuildManifest (#335)", () => {
  test("returns all seven manifest fields for a well-formed manifest.json", () => {
    writeManifest(validManifest());
    expect(readAgentBuildManifest(PLATFORM, BUILD, dir)).toEqual({
      platform: PLATFORM,
      commit: COMMIT,
      dirty: false,
      sha256: BYTES_SHA,
      builtAt: BUILT_AT,
      bun: "1.4.3",
      signIdentity: null,
    });
  });

  test("keeps a signed dirty build and drops keys it does not know", () => {
    writeManifest({
      ...validManifest(),
      dirty: true,
      signIdentity: "Apple Development: ops@example.com",
      rustTarget: "a field a newer builder added",
    });
    expect(readAgentBuildManifest(PLATFORM, BUILD, dir)).toEqual({
      platform: PLATFORM,
      commit: COMMIT,
      dirty: true,
      sha256: BYTES_SHA,
      builtAt: BUILT_AT,
      bun: "1.4.3",
      signIdentity: "Apple Development: ops@example.com",
    });
  });

  test("reads the manifest of the named build only", () => {
    writeManifest(validManifest(), BUILD);
    mkdirSync(buildDir("aaaaaaaaaaaa"), { recursive: true });
    expect(readAgentBuildManifest(PLATFORM, "aaaaaaaaaaaa", dir)).toBeNull();
    expect(readAgentBuildManifest(PLATFORM, BUILD, dir)).not.toBeNull();
  });

  test("returns null when the build directory does not exist at all", () => {
    expect(readAgentBuildManifest(PLATFORM, BUILD, dir)).toBeNull();
  });

  test("returns null when manifest.json is missing beside an existing binary", () => {
    writeBuildBinary();
    expect(readAgentBuildManifest(PLATFORM, BUILD, dir)).toBeNull();
  });

  test("returns null when manifest.json cannot be read (a directory stands in)", () => {
    mkdirSync(manifestPath(BUILD), { recursive: true });
    expect(readAgentBuildManifest(PLATFORM, BUILD, dir)).toBeNull();
  });

  test("returns null when manifest.json is not valid JSON", () => {
    for (const text of ["", "{", '{"platform":"linux-arm64"', "not json", "[]]", "undefined"]) {
      writeManifestText(text);
      expect(readAgentBuildManifest(PLATFORM, BUILD, dir)).toBeNull();
    }
  });

  test("returns null for a JSON document that is not an object", () => {
    for (const text of ["null", "42", "true", '"a string"', "[]", "[1,2,3]"]) {
      writeManifestText(text);
      expect(readAgentBuildManifest(PLATFORM, BUILD, dir)).toBeNull();
    }
  });

  for (const key of MANIFEST_KEYS) {
    test(`returns null when manifest.json omits ${key}`, () => {
      writeManifest(manifestWithout(key));
      expect(readAgentBuildManifest(PLATFORM, BUILD, dir)).toBeNull();
    });
  }

  const invalidFieldCases: InvalidFieldCase[] = [
    { key: "platform", value: 42 },
    { key: "platform", value: null },
    { key: "platform", value: true },
    { key: "commit", value: 42 },
    { key: "commit", value: "" },
    { key: "commit", value: COMMIT.slice(0, 39) },
    { key: "commit", value: `${COMMIT}0` },
    { key: "commit", value: COMMIT.toUpperCase() },
    { key: "commit", value: `${COMMIT.slice(0, 39)}z` },
    { key: "commit", value: BUILD },
    { key: "dirty", value: "false" },
    { key: "dirty", value: 0 },
    { key: "dirty", value: 1 },
    { key: "dirty", value: null },
    { key: "sha256", value: 42 },
    { key: "sha256", value: BYTES_SHA.slice(0, 63) },
    { key: "sha256", value: `${BYTES_SHA}0` },
    { key: "sha256", value: BYTES_SHA.toUpperCase() },
    { key: "sha256", value: `${BYTES_SHA.slice(0, 63)}z` },
    { key: "sha256", value: COMMIT },
    { key: "builtAt", value: 42 },
    { key: "builtAt", value: null },
    { key: "builtAt", value: {} },
    { key: "builtAt", value: [] },
    { key: "bun", value: 42 },
    { key: "bun", value: null },
    { key: "bun", value: [] },
    { key: "bun", value: {} },
    { key: "signIdentity", value: 0 },
    { key: "signIdentity", value: true },
    { key: "signIdentity", value: [] },
    { key: "signIdentity", value: {} },
  ];

  for (const testCase of invalidFieldCases) {
    test(`returns null when manifest.json's ${testCase.key} is ${JSON.stringify(
      testCase.value,
    )}`, () => {
      const record = validManifest();
      record[testCase.key] = testCase.value;
      writeManifest(record);
      expect(readAgentBuildManifest(PLATFORM, BUILD, dir)).toBeNull();
    });
  }

  test("treats builtAt and bun as strings only, not as formats", () => {
    writeManifest({ ...validManifest(), builtAt: "", bun: "n/a" });
    const manifest = readAgentBuildManifest(PLATFORM, BUILD, dir);
    expect(manifest?.builtAt).toBe("");
    expect(manifest?.bun).toBe("n/a");
  });

  test("does not cross-check the manifest platform against the requested platform", () => {
    writeManifest({ ...validManifest(), platform: "darwin-x64" });
    expect(readAgentBuildManifest(PLATFORM, BUILD, dir)?.platform).toBe("darwin-x64");
  });
});

describe("readCurrentAgentBuild (#335)", () => {
  test("returns null when no current pointer exists", () => {
    expect(readCurrentAgentBuild(PLATFORM, dir)).toBeNull();
  });

  test("returns null when builds exist but the pointer does not", () => {
    writeBuildBinary();
    writeManifest(validManifest());
    expect(readCurrentAgentBuild(PLATFORM, dir)).toBeNull();
  });

  test("trims the pointer file and reports the trimmed build name", () => {
    for (const raw of [BUILD, `${BUILD}\n`, `  ${BUILD}  \n`, `\n\t${BUILD}\r\n`]) {
      writeCurrent(raw);
      expect(readCurrentAgentBuild(PLATFORM, dir)).toEqual({ ok: true, name: BUILD });
    }
  });

  test("accepts a -dirty build name", () => {
    writeCurrent(`${BUILD}-dirty\n`);
    expect(readCurrentAgentBuild(PLATFORM, dir)).toEqual({ ok: true, name: `${BUILD}-dirty` });
  });

  const invalidPointers: InvalidPointerCase[] = [
    { raw: "", reason: "", label: "empty" },
    { raw: "   \n", reason: "", label: "whitespace only" },
    { raw: "latest", reason: "latest", label: "latest" },
    { raw: "  latest  \n", reason: "latest", label: "padded latest" },
    { raw: "abcdef7", reason: "abcdef7", label: "7 hex chars" },
    { raw: "0f1e2d3c4b5", reason: "0f1e2d3c4b5", label: "11 hex chars" },
    { raw: "0f1e2d3c4b5a1", reason: "0f1e2d3c4b5a1", label: "13 hex chars" },
    { raw: "0F1E2D3C4B5A", reason: "0F1E2D3C4B5A", label: "uppercase hex" },
    {
      raw: "0f1e2d3c4b5a-dirtyy",
      reason: "0f1e2d3c4b5a-dirtyy",
      label: "misspelled -dirty",
    },
    { raw: `release-${BUILD}`, reason: `release-${BUILD}`, label: "prefixed build name" },
    { raw: "../../etc", reason: "../../etc", label: "path traversal" },
    {
      raw: "0f1e2d3c4b5a/llamactl-agent",
      reason: "0f1e2d3c4b5a/llamactl-agent",
      label: "nested path",
    },
  ];

  for (const testCase of invalidPointers) {
    test(`reports the trimmed pointer content as the reason when it is ${testCase.label}`, () => {
      writeCurrent(testCase.raw);
      expect(readCurrentAgentBuild(PLATFORM, dir)).toEqual({ ok: false, reason: testCase.reason });
    });
  }

  test("fails closed with a read error when the pointer cannot be read", () => {
    mkdirSync(pointerPath(), { recursive: true });
    const result = readCurrentAgentBuild(PLATFORM, dir);
    expect(result?.ok).toBe(false);
    if (result === null || result.ok) {
      throw new Error(
        `expected an unreadable pointer to fail closed, got ${JSON.stringify(result)}`,
      );
    }
    expect(result.reason.startsWith("pointer could not be read:")).toBe(true);
  });
});

describe("handleArtifact current-build manifest gate (#335)", () => {
  test("GET serves the pointed build and reports its manifest sha256 + commit", async () => {
    writeBuildBinary();
    writeManifest(validManifest());
    writeCurrent(`${BUILD}\n`);
    writeLegacyTopLevel("stale-legacy-bytes");

    const { status, headers, body } = await call();
    expect(status).toBe(200);
    expect(body).toBe(BYTES);
    expect(headers.get("x-sha256")).toBe(BYTES_SHA);
    expect(headers.get("x-llamactl-commit")).toBe(COMMIT);
    expect(headers.get("content-length")).toBe(String(BYTES.length));
    expect(headers.get("content-disposition")).toContain(`llamactl-agent-${PLATFORM}`);
  });

  test("HEAD carries the same manifest headers with an empty body", async () => {
    writeBuildBinary();
    writeManifest(validManifest());
    writeCurrent(`${BUILD}\n`);

    const { status, headers, body } = await call("HEAD");
    expect(status).toBe(200);
    expect(body).toBe("");
    expect(headers.get("x-sha256")).toBe(BYTES_SHA);
    expect(headers.get("x-llamactl-commit")).toBe(COMMIT);
  });

  test("a build without manifest.json is a 500, never the legacy binary", async () => {
    writeBuildBinary();
    writeCurrent(`${BUILD}\n`);
    writeLegacyTopLevel("stale-legacy-bytes");

    const { status, headers, body } = await call();
    expect(status).toBe(500);
    expect(body).toContain("manifest");
    expect(body).toContain(BUILD);
    expect(body).not.toContain("stale-legacy-bytes");
    expect(headers.get("x-sha256")).toBeNull();
  });

  test("a malformed manifest.json is a 500", async () => {
    writeBuildBinary();
    writeManifestText('{"platform":"linux-arm64",');
    writeCurrent(`${BUILD}\n`);

    const { status, body } = await call();
    expect(status).toBe(500);
    expect(body).toContain("missing or invalid");
  });

  test("a manifest.json that cannot be read is a 500", async () => {
    writeBuildBinary();
    mkdirSync(manifestPath(BUILD), { recursive: true });
    writeCurrent(`${BUILD}\n`);

    const { status, body } = await call();
    expect(status).toBe(500);
    expect(body).toContain("missing or invalid");
  });

  for (const key of ["builtAt", "bun"]) {
    test(`a manifest that omits ${key} is a 500, not a served build`, async () => {
      writeManifest(manifestWithout(key));
      writeBuildBinary();
      writeCurrent(`${BUILD}\n`);

      const { status, body } = await call();
      expect(status).toBe(500);
      expect(body).toContain("missing or invalid");
    });
  }

  test("an invalid manifest is a 500, not the 503 republish retry", async () => {
    writeManifest({ ...validManifest(), sha256: "deadbeef" });
    writeBuildBinary();
    writeCurrent(`${BUILD}\n`);

    const { status, body } = await call();
    expect(status).toBe(500);
    expect(body).toContain("missing or invalid");
    expect(body).not.toContain("retry shortly");
  });

  test("a valid manifest over swapped bytes is the 503 republish retry, not a 500", async () => {
    writeManifest(validManifest());
    writeBuildBinary(BUILD, "half-written-replacement-build");
    writeCurrent(`${BUILD}\n`);

    const { status, headers, body } = await call();
    expect(status).toBe(503);
    expect(headers.get("retry-after")).toBe("1");
    expect(headers.get("x-sha256")).toBeNull();
    expect(body).toContain("retry shortly");
    expect(body).not.toContain("half-written-replacement-build");
  });

  test("the manifest is read for the build the pointer names", async () => {
    writeManifest(validManifest(), BUILD);
    writeBuildBinary("aaaaaaaaaaaa");
    writeCurrent("aaaaaaaaaaaa\n");

    const { status, body } = await call();
    expect(status).toBe(500);
    expect(body).toContain("aaaaaaaaaaaa");
    expect(body).toContain("missing or invalid");
  });

  test("a pointer naming a directory that is not a build name is a 500", async () => {
    writeBuildBinary("abcdef7");
    writeManifest(validManifest(), "abcdef7");
    writeCurrent("abcdef7\n");

    const { status, headers, body } = await call();
    expect(status).toBe(500);
    expect(body).toContain("invalid current pointer");
    expect(body).toContain(pointerPath());
    expect(headers.get("x-sha256")).toBeNull();
  });

  test("an unreadable pointer is a 500, never the legacy binary", async () => {
    writeBuildBinary();
    writeManifest(validManifest());
    mkdirSync(pointerPath(), { recursive: true });
    writeLegacyTopLevel("stale-legacy-bytes");

    const { status, body } = await call();
    expect(status).toBe(500);
    expect(body).toContain("invalid current pointer");
    expect(body).not.toContain("stale-legacy-bytes");
  });
});
