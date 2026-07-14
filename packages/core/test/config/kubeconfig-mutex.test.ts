import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, mutateConfig, saveConfig, upsertNode } from "../../src/config/kubeconfig.js";
import { type Config, freshConfig } from "../../src/config/schema.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

/**
 * Concurrency + atomicity pins for the kubeconfig read-modify-write
 * path. Before the mutex + atomic-write landed, a racing CLI and
 * daemon could each load the same baseline, mutate independently, and
 * whichever `saveConfig` fired second silently erased the other's
 * write. A separate class of bugs — non-atomic writes — let readers
 * see zero-length or half-serialized YAML mid-save.
 */

let tmp = "";
let cfgPath = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-kcfg-mutex-"));
  cfgPath = join(tmp, "config");
  saveConfig(freshConfig(), cfgPath);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("mutateConfig — cross-process concurrency", () => {
  test("two subprocesses racing on the same config both persist their node (no lost write)", async () => {
    const script = `
      import { mutateConfig, upsertNode } from "${resolveKubeconfigModule()}";
      const [nodeName, endpoint] = process.argv.slice(2);
      mutateConfig(process.env.CFG_PATH, (cfg) =>
        upsertNode(cfg, "home", { name: nodeName, endpoint }),
      );
    `;
    const scriptPath = join(tmp, "mutator.mjs");
    writeFileSync(scriptPath, script);

    // Fire both simultaneously; whichever loses the initial lock race
    // must wait for the winner to release, then re-read + write the
    // superset. Both nodes surviving proves neither snapshot was
    // stale-clobbered.
    const p1 = Bun.spawn({
      cmd: ["bun", "run", scriptPath, "raceA", "https://a.lan:7843"],
      env: { ...process.env, CFG_PATH: cfgPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const p2 = Bun.spawn({
      cmd: ["bun", "run", scriptPath, "raceB", "https://b.lan:7843"],
      env: { ...process.env, CFG_PATH: cfgPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [c1, c2] = await Promise.all([p1.exited, p2.exited]);
    if (c1 !== 0 || c2 !== 0) {
      const stderr1 = await new Response(p1.stderr).text();
      const stderr2 = await new Response(p2.stderr).text();
      throw new Error(
        `subprocess failed: c1=${String(c1)} c2=${String(c2)}\n${stderr1}\n---\n${stderr2}`,
      );
    }

    const cfg = loadConfig(cfgPath);
    const names = cfg.clusters
      .find((c) => c.name === "home")!
      .nodes.map((n) => n.name)
      .sort();
    expect(names).toContain("raceA");
    expect(names).toContain("raceB");
  }, 15_000);

  test("two subprocesses reaping the same stale lock both persist their node", async () => {
    const script = `
      import { mutateConfig, upsertNode } from "${resolveKubeconfigModule()}";
      const [nodeName, endpoint] = process.argv.slice(2);
      mutateConfig(process.env.CFG_PATH, (cfg) =>
        upsertNode(cfg, "home", { name: nodeName, endpoint }),
      );
    `;
    const scriptPath = join(tmp, "mutator-stale.mjs");
    writeFileSync(scriptPath, script);
    const lockPath = `${cfgPath}.lock`;
    const rounds = 12;
    for (let i = 0; i < rounds; i++) {
      writeFileSync(lockPath, "2147483000");
      const p1 = Bun.spawn({
        cmd: ["bun", "run", scriptPath, `stale-a-${String(i)}`, `https://a-${String(i)}.lan:7843`],
        env: { ...process.env, CFG_PATH: cfgPath },
        stdout: "pipe",
        stderr: "pipe",
      });
      const p2 = Bun.spawn({
        cmd: ["bun", "run", scriptPath, `stale-b-${String(i)}`, `https://b-${String(i)}.lan:7843`],
        env: { ...process.env, CFG_PATH: cfgPath },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [c1, c2] = await Promise.all([p1.exited, p2.exited]);
      if (c1 !== 0 || c2 !== 0) {
        const stderr1 = await new Response(p1.stderr).text();
        const stderr2 = await new Response(p2.stderr).text();
        throw new Error(
          `subprocess failed on round ${String(i)}: c1=${String(c1)} c2=${String(c2)}\n${stderr1}\n---\n${stderr2}`,
        );
      }
    }

    const cfg = loadConfig(cfgPath);
    const names = cfg.clusters
      .find((c) => c.name === "home")!
      .nodes.map((n) => n.name)
      .sort();
    for (let i = 0; i < rounds; i++) {
      expect(names).toContain(`stale-a-${String(i)}`);
      expect(names).toContain(`stale-b-${String(i)}`);
    }
  }, 25_000);

  test("stale pidfile (dead holder) is reaped and the new mutator proceeds", () => {
    // Simulate a holder that crashed without releasing: pid 1 is
    // always alive, so pick a pid that's virtually never allocated
    // (very high; `process.kill(N, 0)` returns ESRCH for missing pids).
    const lockPath = `${cfgPath}.lock`;
    writeFileSync(lockPath, "2147483000");
    expect(existsSync(lockPath)).toBe(true);

    mutateConfig(cfgPath, (cfg) =>
      upsertNode(cfg, "home", { name: "reaped", endpoint: "https://x:7" }),
    );

    // After successful mutation the lock is released.
    expect(existsSync(lockPath)).toBe(false);
    const cfg = loadConfig(cfgPath);
    expect(cfg.clusters[0]!.nodes.some((n) => n.name === "reaped")).toBe(true);
  });

  test("throws with a clear error when the lock is held by a live process beyond the retry window", async () => {
    // Spawn a child that grabs the lock and then sleeps well past the
    // parent's retry deadline (50ms * 40 = 2s). The parent's
    // mutateConfig must throw rather than lose or clobber a write.
    const holderScript = `
      import { openSync, writeSync } from "node:fs";
      const fd = openSync(process.env.LOCK_PATH, "wx");
      writeSync(fd, String(process.pid));
      // Keep the fd open — hold the lock until parent kills us.
      setInterval(() => {}, 1000);
    `;
    const scriptPath = join(tmp, "holder.mjs");
    writeFileSync(scriptPath, holderScript);
    const lockPath = `${cfgPath}.lock`;
    const holder = Bun.spawn({
      cmd: ["bun", "run", scriptPath],
      env: { ...process.env, LOCK_PATH: lockPath },
      stdout: "ignore",
      stderr: "ignore",
    });
    // Wait until the child has actually written the lockfile.
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !existsSync(lockPath)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(existsSync(lockPath)).toBe(true);

    try {
      const start = Date.now();
      expect(() =>
        mutateConfig(cfgPath, (cfg) =>
          upsertNode(cfg, "home", { name: "shouldnotpersist", endpoint: "https://x:8" }),
        ),
      ).toThrow(/still held after/);
      const elapsed = Date.now() - start;
      // Bounded wait: ~2s (50ms * 40) minus scheduling slop.
      expect(elapsed).toBeGreaterThanOrEqual(1_500);
      expect(elapsed).toBeLessThan(6_000);

      // And the mutation must NOT have leaked into the config.
      const cfg = loadConfig(cfgPath);
      expect(cfg.clusters[0]!.nodes.some((n) => n.name === "shouldnotpersist")).toBe(false);
    } finally {
      holder.kill();
      await holder.exited;
    }
  }, 15_000);
});

describe("saveConfig — atomic write (no torn reads)", () => {
  test("a subprocess hammering readFileSync during many saves never observes a torn/empty file", async () => {
    // Bulk up the config so serialization spans a measurable window —
    // the OS-level O_TRUNC step of a bare writeFileSync opens a torn-
    // read window a concurrent process can slip into. Same-process
    // readers can't catch this (sync JS runs to completion), so the
    // reader lives in a Bun subprocess that spins on readFileSync.
    let cfg: Config = freshConfig();
    for (let i = 0; i < 400; i++) {
      cfg = upsertNode(cfg, "home", {
        name: `bulk-${String(i)}`,
        endpoint: `https://bulk-${String(i)}.example.lan:7843`,
      });
    }
    saveConfig(cfg, cfgPath);

    const readerScript = `
      import { readFileSync, existsSync } from "node:fs";
      import { parse } from "yaml";
      const path = process.env.CFG_PATH;
      const errors = [];
      const start = Date.now();
      while (Date.now() - start < 3000) {
        try {
          if (!existsSync(path)) continue;
          const raw = readFileSync(path, "utf8");
          if (raw.length === 0) { errors.push("empty"); continue; }
          const parsed = parse(raw);
          if (parsed?.apiVersion !== "llamactl/v1" || parsed?.kind !== "Config") {
            errors.push("bad_shape");
          }
        } catch (err) {
          errors.push("parse:" + err.message.slice(0, 60));
        }
      }
      process.stdout.write(JSON.stringify(errors));
    `;
    const readerPath = join(tmp, "reader.mjs");
    writeFileSync(readerPath, readerScript);
    const reader = Bun.spawn({
      cmd: ["bun", "run", readerPath],
      env: { ...process.env, CFG_PATH: cfgPath },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Writer: rapid saves for the reader's full window. Under the
    // pre-fix bare-writeFileSync path the reader trips repeatedly on
    // the O_TRUNC window and reports "empty" reads.
    const writerDeadline = Date.now() + 2_500;
    let iter = 0;
    while (Date.now() < writerDeadline) {
      cfg = upsertNode(cfg, "home", {
        name: `writer-${String(iter++)}`,
        endpoint: `https://writer-${String(iter)}.lan:7843`,
      });
      saveConfig(cfg, cfgPath);
      // Yield briefly so the reader subprocess gets scheduled between
      // saves; without this the sync writeFileSync hogs the CPU and
      // the reader never lands during the torn window.
      await new Promise((r) => setTimeout(r, 1));
    }

    await reader.exited;
    const raw = await new Response(reader.stdout).text();
    const errors = JSON.parse(raw || "[]") as string[];
    // We tolerate ENOENT-flavoured errors from the file-doesn't-exist
    // sliver (the tempdir may briefly not have it); the pin is on
    // torn-content reads specifically.
    const contentErrors = errors.filter(
      (e) => e === "empty" || e === "bad_shape" || e.startsWith("parse:"),
    );
    expect(contentErrors).toEqual([]);
  }, 15_000);
});

function resolveKubeconfigModule(): string {
  return new URL("../../src/config/kubeconfig.ts", import.meta.url).pathname;
}
