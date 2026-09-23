import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadConfig,
  lockProbe,
  mutateConfig,
  saveConfig,
  upsertNode,
} from "../../src/config/kubeconfig.js";
import { freshConfig } from "../../src/config/schema.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../../src/safe-fs.js";

/**
 * Pin for the stale-lock restore orphan. When a reaper's check->rename
 * gap lands on a freshly planted live lockfile, it restores the seized
 * file over its own plant. If the displaced owner released during that
 * window, the restored file used to sit at lockPath forever: its pid is
 * still alive, so no contender will reap it, and its owner already
 * walked away — every writer failed "still held" until the owner
 * happened to re-enter mutateConfig. The owner-side release sweep makes
 * the orphan impossible: a live-pid file is never unlinked by a reaper,
 * so it is always at lockPath or at a discoverable `.reap-*` sibling,
 * and release does not return until the copy is verifiably gone.
 */

let tmp = "";
let cfgPath = "";
let sig = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-kcfg-orphan-"));
  cfgPath = join(tmp, "config");
  sig = join(tmp, "sig");
  mkdirSync(sig);
  saveConfig(freshConfig(), cfgPath);
});
afterEach(() => {
  delete lockProbe.beforeSeizeRename;
  delete lockProbe.afterSeizePlant;
  rmSync(tmp, { recursive: true, force: true });
});

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const waitForSignal = (name: string, ms: number): string => {
  const deadline = Date.now() + ms;
  while (!existsSync(join(sig, name))) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for signal ${name}`);
    sleepSync(20);
  }
  return readFileSync(join(sig, name), "utf8");
};

describe("mutateConfig — stale-lock restore orphan", () => {
  test("a lockfile restored after its owner released cannot wedge other writers", async () => {
    const lockPath = `${cfgPath}.lock`;
    const modulePath = new URL("../../src/config/kubeconfig.ts", import.meta.url).pathname;

    // Owner: blocks inside its critical section until the reaper holds
    // its lockfile aside, then releases while displaced and stays alive —
    // the orphan wedge needs the recorded pid to remain live.
    const ownerScript = `
      import { existsSync, writeFileSync } from "node:fs";
      import { mutateConfig } from "${modulePath}";
      const sig = process.env.SIGNAL_DIR;
      const waitFor = (name, ms) => {
        const deadline = Date.now() + ms;
        while (!existsSync(sig + "/" + name)) {
          if (Date.now() > deadline) return;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      };
      waitFor("start", 30000);
      let note = "mutateConfig returned";
      try {
        mutateConfig(process.env.CFG_PATH, (cfg) => {
          writeFileSync(sig + "/acquired", String(process.pid));
          waitFor("release", 20000);
          throw new Error("release while displaced");
        });
      } catch (err) {
        note = "mutateConfig threw: " + String(err);
      }
      writeFileSync(sig + "/released", note);
      setInterval(() => {}, 5000);
    `;
    const contenderScript = `
      import { mutateConfig, upsertNode } from "${modulePath}";
      const start = Date.now();
      try {
        mutateConfig(process.env.CFG_PATH, (cfg) =>
          upsertNode(cfg, "home", { name: process.env.NODE_NAME, endpoint: "https://c:1" }),
        );
        console.log("ok ms=" + (Date.now() - start));
      } catch (err) {
        console.log("threw ms=" + (Date.now() - start) + " err=" + String(err));
        process.exit(3);
      }
    `;
    const ownerPath = join(tmp, "owner.mjs");
    const contenderPath = join(tmp, "contender.mjs");
    writeFileSync(ownerPath, ownerScript);
    writeFileSync(contenderPath, contenderScript);

    // A dead pidfile is what sends this process down the seize path.
    writeFileSync(lockPath, "2147483000");

    const owner = Bun.spawn({
      cmd: ["bun", "run", ownerPath],
      env: { ...process.env, CFG_PATH: cfgPath, SIGNAL_DIR: sig },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Interleaving, pinned by the seam:
    //   beforeSeizeRename — owner reaps the dead file and plants T_A.
    //   afterSeizePlant   — we hold T_A aside at our reap path and have
    //                       planted T_B; owner releases mid-displacement.
    lockProbe.beforeSeizeRename = (): void => {
      writeFileSync(join(sig, "start"), "");
      waitForSignal("acquired", 30_000);
    };
    lockProbe.afterSeizePlant = (): void => {
      writeFileSync(join(sig, "release"), "");
      waitForSignal("released", 30_000);
    };

    try {
      // Pre-fix this threw "still held after 2000ms": the restore put
      // T_A back at lockPath after the owner had already released it.
      mutateConfig(cfgPath, (cfg) =>
        upsertNode(cfg, "home", { name: "reaper", endpoint: "https://p:1" }),
      );

      // The owner's release finished while its lockfile sat at our reap
      // path — the sweep must have removed it, so the failed restore
      // left our own plant owning the slot and nothing outlives the
      // owner.
      const releasedNote = waitForSignal("released", 1);
      expect(releasedNote).toContain("release while displaced");
      expect(existsSync(lockPath)).toBe(false);
      expect(readdirSync(tmp).filter((n) => n.includes("reap-"))).toEqual([]);
      expect(loadConfig(cfgPath).clusters[0]!.nodes.some((n) => n.name === "reaper")).toBe(true);

      // The wedge check: an unrelated writer mutates promptly even
      // though the (still-alive) owner's pid is what an orphaned
      // lockfile would have recorded.
      const contender = Bun.spawn({
        cmd: ["bun", "run", contenderPath],
        env: { ...process.env, CFG_PATH: cfgPath, NODE_NAME: "third-writer" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await contender.exited;
      const out = await new Response(contender.stdout).text();
      expect(code).toBe(0);
      expect(out).toContain("ok");
      expect(loadConfig(cfgPath).clusters[0]!.nodes.some((n) => n.name === "third-writer")).toBe(
        true,
      );
    } finally {
      owner.kill();
      await owner.exited;
    }
  }, 20_000);
});
