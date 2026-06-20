import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type FetchAgentReleaseFn, resolveUpdateBinary } from "../src/commands/agent-update.js";

// Minimal parsed-args shape the helper needs for the fetch path.
function makeReleaseParsed(
  overrides: Partial<{
    fromRelease: string;
    repo: string;
    platform: string;
    noVerify: boolean;
  }> = {},
): {
  fromRelease: string;
  repo: string;
  platform?: string;
  readinessTimeoutSec: number;
  json: boolean;
  noVerify: boolean;
} {
  return {
    fromRelease: "v0.5.0",
    repo: "frozename/llamactl",
    readinessTimeoutSec: 30,
    json: false,
    noVerify: false,
    ...overrides,
  };
}

function withTempBinary(
  fn: (
    fakePath: string,
    makeOkFetch: (
      onCall?: (opts: Parameters<FetchAgentReleaseFn>[0]) => void,
    ) => FetchAgentReleaseFn,
  ) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-update-test-"));
    const fakePath = join(dir, "llamactl-agent");
    writeFileSync(fakePath, "#!/bin/sh\necho fake\n");
    const makeOkFetch =
      (onCall?: (opts: Parameters<FetchAgentReleaseFn>[0]) => void): FetchAgentReleaseFn =>
      // eslint-disable-next-line @typescript-eslint/require-await -- async signature mirrors the real fetchAgentRelease
      async (opts) => {
        onCall?.(opts);
        return {
          ok: true,
          version: opts.version,
          target: opts.target,
          path: fakePath,
          sha256: "deadbeef".repeat(8),
          bytes: 0,
          signature: { verified: null, reason: "skipped" },
        };
      };
    try {
      await fn(fakePath, makeOkFetch);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// -----------------------------------------------------------------------
// Bug 1 — wrong arch: resolveUpdateBinary must pass platform-arch target,
// NOT just platform (e.g. "linux" instead of "linux-x64").
// -----------------------------------------------------------------------

describe("resolveUpdateBinary — wrong-arch bug", () => {
  test(
    "uses platform+arch from node facts, not platform alone",
    withTempBinary(async (_fakePath, makeOkFetch) => {
      let capturedTarget: string | undefined;
      const node = { facts: { platform: "linux", arch: "x64" } };
      const result = await resolveUpdateBinary(makeReleaseParsed(), node, {
        fetchAgentRelease: makeOkFetch((opts) => {
          capturedTarget = opts.target;
        }),
      });
      // Should have called fetch with "linux-x64", not the bare "linux" that
      // the old node.facts?.platform-only derivation would produce.
      expect(typeof result).toBe("string");
      expect(capturedTarget).toBe("linux-x64");
    }),
  );

  test(
    "linux-arm64 node gets correct target",
    withTempBinary(async (_fakePath, makeOkFetch) => {
      let capturedTarget: string | undefined;
      const node = { facts: { platform: "linux", arch: "arm64" } };
      await resolveUpdateBinary(makeReleaseParsed(), node, {
        fetchAgentRelease: makeOkFetch((opts) => {
          capturedTarget = opts.target;
        }),
      });
      expect(capturedTarget).toBe("linux-arm64");
    }),
  );

  test(
    "darwin-arm64 node gets correct target",
    withTempBinary(async (_fakePath, makeOkFetch) => {
      let capturedTarget: string | undefined;
      const node = { facts: { platform: "darwin", arch: "arm64" } };
      await resolveUpdateBinary(makeReleaseParsed(), node, {
        fetchAgentRelease: makeOkFetch((opts) => {
          capturedTarget = opts.target;
        }),
      });
      expect(capturedTarget).toBe("darwin-arm64");
    }),
  );

  test("returns error when node has no facts, not silent darwin-arm64 fallback", async () => {
    const node = {};
    const result = await resolveUpdateBinary(makeReleaseParsed(), node, {
      // eslint-disable-next-line @typescript-eslint/require-await -- async signature mirrors the real fetchAgentRelease
      fetchAgentRelease: async () => ({
        ok: true as const,
        version: "v0.5.0",
        target: "darwin-arm64",
        path: "/nonexistent",
        sha256: "x",
        bytes: 0,
        signature: { verified: null, reason: "skipped" },
      }),
    });
    // Must be an error, not silently proceed with darwin-arm64.
    expect(typeof result).toBe("object");
    expect(result).toHaveProperty("error");
    if (typeof result === "object" && "error" in result) {
      expect(result.error).toContain("platform");
    }
  });

  test(
    "--platform flag overrides absent facts",
    withTempBinary(async (_fakePath, makeOkFetch) => {
      let capturedTarget: string | undefined;
      const node = {};
      await resolveUpdateBinary(makeReleaseParsed({ platform: "linux-x64" }), node, {
        fetchAgentRelease: makeOkFetch((opts) => {
          capturedTarget = opts.target;
        }),
      });
      expect(capturedTarget).toBe("linux-x64");
    }),
  );
});

// -----------------------------------------------------------------------
// Bug 2 — silent sig bypass: verifySig must default to "require", not
// "best-effort" (which silently skips when cosign/sig assets are absent).
// -----------------------------------------------------------------------

describe("resolveUpdateBinary — silent-sig-bypass bug", () => {
  test(
    "passes verifySig=require to fetchAgentRelease by default",
    withTempBinary(async (_fakePath, makeOkFetch) => {
      let capturedVerifySig: string | undefined;
      const node = { facts: { platform: "darwin", arch: "arm64" } };
      await resolveUpdateBinary(makeReleaseParsed(), node, {
        fetchAgentRelease: makeOkFetch((opts) => {
          capturedVerifySig = opts.verifySig;
        }),
      });
      // Must be "require", not the silent "best-effort".
      expect(capturedVerifySig).toBe("require");
    }),
  );

  test(
    "--no-verify downgrades to best-effort and result is still returned",
    withTempBinary(async (_fakePath, makeOkFetch) => {
      let capturedVerifySig: string | undefined;
      const node = { facts: { platform: "darwin", arch: "arm64" } };
      const result = await resolveUpdateBinary(makeReleaseParsed({ noVerify: true }), node, {
        fetchAgentRelease: makeOkFetch((opts) => {
          capturedVerifySig = opts.verifySig;
        }),
      });
      expect(capturedVerifySig).toBe("best-effort");
      expect(typeof result).toBe("string");
    }),
  );

  test("fetch failure with sig-verify-failed is surfaced as error", async () => {
    const node = { facts: { platform: "darwin", arch: "arm64" } };
    const result = await resolveUpdateBinary(makeReleaseParsed(), node, {
      // eslint-disable-next-line @typescript-eslint/require-await -- async signature mirrors the real fetchAgentRelease
      fetchAgentRelease: async () => ({
        ok: false,
        reason: "sig-verify-failed" as const,
        message: "cosign mismatch",
      }),
    });
    expect(typeof result).toBe("object");
    if (typeof result === "object" && "error" in result) {
      expect(result.error).toContain("sig-verify-failed");
    }
  });
});
