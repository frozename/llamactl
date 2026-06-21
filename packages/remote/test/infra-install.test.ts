import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type InfraExtractor,
  type InfraFetcher,
  installInfraPackage,
} from "../src/infra/install.js";
import {
  infraCurrentSymlink,
  infraVersionDir,
  listInstalledInfra,
  resolveCurrentVersion,
} from "../src/infra/layout.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../src/safe-fs.js";

/**
 * Install flow tests with both injection points (fetcher + extractor)
 * stubbed. Real curl/tar behavior is validated in a separate manual
 * smoke test against the actual llama.cpp release tarballs.
 */

let base = "";

const FAKE_PAYLOAD = new TextEncoder().encode("fake-tarball-contents");
const FAKE_SHA = createHash("sha256").update(FAKE_PAYLOAD).digest("hex");

function failIfUnsettled<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new Error(message));
      }, ms);
    }),
  ]);
}

function stubFetcher(url: string, bytes: Uint8Array = FAKE_PAYLOAD): InfraFetcher {
  return async (reqUrl: string) => {
    await Promise.resolve();
    if (reqUrl !== url) throw new Error(`unexpected fetch url: ${reqUrl}`);
    return bytes;
  };
}

function stubExtractor(contents: Record<string, string>): InfraExtractor {
  return async (_tarballPath: string, destDir: string) => {
    await Promise.resolve();
    for (const [rel, body] of Object.entries(contents)) {
      const full = join(destDir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, body, "utf8");
    }
  };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "llamactl-infra-install-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("installInfraPackage", () => {
  test("happy path: downloads, verifies sha, extracts, activates", async () => {
    const url = "https://pkgs.example.com/llama-cpp/b4500.tar.gz";
    const result = await installInfraPackage({
      pkg: "llama-cpp",
      version: "b4500",
      tarballUrl: url,
      sha256: FAKE_SHA,
      base,
      fetcher: stubFetcher(url),
      extractor: stubExtractor({
        "bin/llama-server": "#!/bin/sh\necho llama-server\n",
        "bin/llama-bench": "#!/bin/sh\necho llama-bench\n",
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toBe("installed");
    expect(result.activated).toBe(true);
    // Version dir populated with the extracted files.
    const versionDir = infraVersionDir("llama-cpp", "b4500", base);
    expect(existsSync(versionDir)).toBe(true);
    expect(readFileSync(join(versionDir, "bin/llama-server"), "utf8")).toContain(
      "echo llama-server",
    );
    // Active symlink flipped.
    const active = resolveCurrentVersion("llama-cpp", base);
    expect(active?.version).toBe("b4500");
  });

  test("sha mismatch rejects without writing the version dir", async () => {
    const url = "https://pkgs.example.com/x";
    const result = await installInfraPackage({
      pkg: "llama-cpp",
      version: "b4500",
      tarballUrl: url,
      sha256: "deadbeef" + "0".repeat(56),
      base,
      fetcher: stubFetcher(url),
      extractor: stubExtractor({ "bin/x": "x" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("sha-mismatch");
    // No version dir written — installInfraPackage creates the
    // package directory early (ensurePackageDir) so a subsequent
    // install can write into it, but the verification-fail path
    // leaves zero versions inside.
    expect(existsSync(infraVersionDir("llama-cpp", "b4500", base))).toBe(false);
    const rows = listInstalledInfra(base);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.versions).toEqual([]);
    expect(rows[0]!.active).toBeNull();
  });

  test("re-install skips extraction when version already present + still flips symlink", async () => {
    const url = "https://pkgs.example.com/x";
    let extractCalls = 0;
    const fetcher: InfraFetcher = () => Promise.resolve(FAKE_PAYLOAD);
    const extractor: InfraExtractor = async (_t, dest) => {
      await Promise.resolve();
      extractCalls++;
      writeFileSync(join(dest, "marker"), "a", "utf8");
    };
    // First install.
    const first = await installInfraPackage({
      pkg: "llama-cpp",
      version: "b4500",
      tarballUrl: url,
      sha256: FAKE_SHA,
      base,
      fetcher,
      extractor,
    });
    expect(first.ok).toBe(true);
    expect(extractCalls).toBe(1);

    // Re-install without --force — skipIfPresent default.
    const second = await installInfraPackage({
      pkg: "llama-cpp",
      version: "b4500",
      tarballUrl: url,
      sha256: FAKE_SHA,
      base,
      fetcher,
      extractor,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.state).toBe("already-present");
    expect(extractCalls).toBe(1); // extractor NOT called again
    // Symlink still points at the version.
    expect(existsSync(infraCurrentSymlink("llama-cpp", base))).toBe(true);
  });

  test("skipIfPresent:false + re-install forces a fresh extract", async () => {
    const url = "https://pkgs.example.com/x";
    let extractCalls = 0;
    const fetcher: InfraFetcher = () => Promise.resolve(FAKE_PAYLOAD);
    const extractor: InfraExtractor = async (_t, dest) => {
      await Promise.resolve();
      extractCalls++;
      writeFileSync(join(dest, `v${String(extractCalls)}`), "x", "utf8");
    };
    await installInfraPackage({
      pkg: "llama-cpp",
      version: "b4500",
      tarballUrl: url,
      sha256: FAKE_SHA,
      base,
      fetcher,
      extractor,
    });
    const result = await installInfraPackage({
      pkg: "llama-cpp",
      version: "b4500",
      tarballUrl: url,
      sha256: FAKE_SHA,
      base,
      fetcher,
      extractor,
      skipIfPresent: false,
    });
    expect(result.ok).toBe(true);
    expect(extractCalls).toBe(2);
    // Second extract's marker file wins — first install's marker was purged.
    expect(existsSync(join(infraVersionDir("llama-cpp", "b4500", base), "v1"))).toBe(false);
    expect(existsSync(join(infraVersionDir("llama-cpp", "b4500", base), "v2"))).toBe(true);
  });

  test("activate:false installs without flipping the current symlink", async () => {
    const url = "https://pkgs.example.com/x";
    const result = await installInfraPackage({
      pkg: "llama-cpp",
      version: "b4500",
      tarballUrl: url,
      sha256: FAKE_SHA,
      base,
      fetcher: stubFetcher(url),
      extractor: stubExtractor({ "bin/x": "x" }),
      activate: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activated).toBe(false);
    expect(existsSync(infraCurrentSymlink("llama-cpp", base))).toBe(false);
  });

  test("fetch failure surfaces as fetch-failed", async () => {
    const result = await installInfraPackage({
      pkg: "llama-cpp",
      version: "b4500",
      tarballUrl: "https://pkgs.example.com/x",
      sha256: FAKE_SHA,
      base,
      fetcher: async () => {
        await Promise.resolve();
        throw new Error("DNS fail");
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("fetch-failed");
    expect(result.error).toContain("DNS fail");
  });

  test("default fetcher aborts a stalled tarball fetch after the configured timeout", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as typeof fetch;
    try {
      const result = await failIfUnsettled(
        installInfraPackage({
          pkg: "llama-cpp",
          version: "b4500",
          tarballUrl: "https://pkgs.example.com/stall.tar.gz",
          sha256: FAKE_SHA,
          base,
          fetchTimeoutMs: 20,
          extractor: stubExtractor({ "bin/x": "x" }),
        }),
        250,
        "installInfraPackage did not abort the stalled fetch",
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("fetch-failed");
      expect(result.error).toContain("timed out after 20ms");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("extractor failure leaves no partial version dir", async () => {
    const url = "https://pkgs.example.com/x";
    const result = await installInfraPackage({
      pkg: "llama-cpp",
      version: "b4500",
      tarballUrl: url,
      sha256: FAKE_SHA,
      base,
      fetcher: stubFetcher(url),
      extractor: async () => {
        await Promise.resolve();
        throw new Error("corrupt tarball");
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("extract-failed");
    expect(existsSync(infraVersionDir("llama-cpp", "b4500", base))).toBe(false);
  });

  test("two versions installed side-by-side + final activation pins the chosen one", async () => {
    const url = "https://pkgs.example.com/x";
    const fetcher: InfraFetcher = () => Promise.resolve(FAKE_PAYLOAD);
    await installInfraPackage({
      pkg: "llama-cpp",
      version: "b4500",
      tarballUrl: url,
      sha256: FAKE_SHA,
      base,
      fetcher,
      extractor: stubExtractor({ "bin/x": "v4500" }),
    });
    await installInfraPackage({
      pkg: "llama-cpp",
      version: "b4501",
      tarballUrl: url,
      sha256: FAKE_SHA,
      base,
      fetcher,
      extractor: stubExtractor({ "bin/x": "v4501" }),
    });
    const rows = listInstalledInfra(base);
    expect(rows[0]!.versions).toEqual(["b4500", "b4501"]);
    expect(rows[0]!.active).toBe("b4501");
  });
});
