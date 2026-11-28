import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "../../src/safe-fs.js";
import {
  baseEnv,
  type FixtureDirs,
  killQuiet,
  launchFromDyingParent,
  makeFixtureDirs,
  MODELHOST_PARENT,
  MODELRUN_PARENT,
  parentPids,
  waitFor,
} from "../fixtures/engine-survival-helpers.js";

let scratch = "";
let scriptPath = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "llamactl-result-handoff-"));
  scriptPath = join(scratch, "torn-writer-parent.ts");
  writeFileSync(
    scriptPath,
    `import { existsSync, writeFileSync } from "node:fs";

const cfg = JSON.parse(process.argv[2]) as {
  readonly name: string;
  readonly resultPath: string;
};

const initial: Record<string, string> = { never: '{"ok":tr', "no-ok": '{"pid":1}' };
writeFileSync(cfg.resultPath, initial[cfg.name] ?? '{"ok":true,"pi');

const completionCheck = setInterval(() => {
  if (!existsSync(cfg.resultPath + ".release")) {
    return;
  }
  if (cfg.name === "torn") {
    writeFileSync(cfg.resultPath, JSON.stringify({ ok: true, pid: 4242, error: null }));
  }
  clearInterval(completionCheck);
}, 20);

setInterval(() => undefined, 1 << 30);
`,
  );
});

afterEach(() => {
  for (const pid of parentPids) {
    killQuiet(pid);
  }
  parentPids.clear();
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("reader waits for a complete launch result instead of parsing a torn write", async () => {
  const resultPath = join(scratch, "r1.json");
  const settled = launchFromDyingParent(scriptPath, {
    name: "torn",
    env: {},
    resultPath,
  }).then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e: String(e) }),
  );

  await waitFor(() => existsSync(resultPath), "partial write", 10_000);
  await new Promise((resolve) => {
    setTimeout(resolve, 300);
  });
  writeFileSync(resultPath + ".release", "");

  expect(await settled).toEqual({
    ok: true,
    v: { ok: true, pid: 4242, error: null },
  });
}, 20_000);

test("a result that never completes fails with a bounded labelled timeout, not a parse error", async () => {
  const resultPath = join(scratch, "r2.json");
  const settled = launchFromDyingParent(
    scriptPath,
    {
      name: "never",
      env: {},
      resultPath,
    },
    { resultBudgetMs: 500 },
  ).then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e: String(e) }),
  );

  const r = await settled;
  expect(r.ok).toBe(false);
  if (r.ok) {
    throw new Error("launch unexpectedly settled successfully");
  }
  expect(r.e).toMatch(/timed out waiting for launch result/);
  expect(r.e).toContain("raw=");
  expect(r.e).toContain(JSON.stringify('{"ok":tr'));
}, 20_000);

test("a complete result without a boolean ok fails fast as a launch failure, not a timeout", async () => {
  const resultPath = join(scratch, "r3.json");
  const startedAt = Date.now();
  const settled = launchFromDyingParent(
    scriptPath,
    {
      name: "no-ok",
      env: {},
      resultPath,
    },
    { resultBudgetMs: 10_000 },
  ).then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e: String(e) }),
  );

  const r = await settled;
  const elapsedMs = Date.now() - startedAt;
  expect(r.ok).toBe(false);
  if (r.ok) {
    throw new Error("launch unexpectedly settled successfully");
  }
  expect(r.e).toMatch(/launch failed raw=/);
  expect(r.e).toContain(JSON.stringify('{"pid":1}'));
  expect(r.e).not.toMatch(/timed out/);
  expect(elapsedMs).toBeLessThan(5_000);
}, 20_000);

// The real parents must publish the result by tmp+rename, so the reader never
// observes the target mid-write: the target is replaced by a new inode (an
// in-place writeFileSync truncates and rewrites the same inode) and no sibling
// tmp file is left behind.
interface WriterCase {
  readonly label: string;
  readonly script: string;
  readonly extra: (dirs: FixtureDirs) => Record<string, unknown>;
}

const writerCases: readonly WriterCase[] = [
  {
    label: "modelhost",
    script: MODELHOST_PARENT,
    extra: (dirs) => ({
      manifest: { apiVersion: "llamactl/v1", kind: "ModelHost", metadata: { name: "w" } },
      workloadsDir: dirs.workloadsDir,
      runtimeDir: dirs.runtimeDir,
    }),
  },
  {
    label: "modelrun",
    script: MODELRUN_PARENT,
    extra: () => ({
      target: "missing/not-a-model.gguf",
      endpoint: { host: "127.0.0.1", port: 1 },
      timeoutSeconds: 1,
    }),
  },
];

for (const { label, script, extra } of writerCases) {
  test(`${label} parent replaces the launch result atomically via a sibling tmp file`, async () => {
    const dirs = makeFixtureDirs(scratch);
    const resultPath = join(dirs.tmp, "result.json");
    writeFileSync(resultPath, "PRIOR");
    const priorIno = statSync(resultPath).ino;

    const proc = Bun.spawn(
      [
        process.execPath,
        script,
        JSON.stringify({
          name: "w",
          env: baseEnv(dirs, 1),
          resultPath,
          ...extra(dirs),
        }),
      ],
      { env: { ...process.env }, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    parentPids.add(proc.pid);

    let raw = "";
    await waitFor(
      () => {
        raw = readFileSync(resultPath, "utf8");
        try {
          JSON.parse(raw);
          return true;
        } catch {
          return false;
        }
      },
      `${label} result`,
      15_000,
    );

    expect(JSON.parse(raw)).toMatchObject({ ok: false, pid: null });
    expect(statSync(resultPath).ino).not.toBe(priorIno);
    expect(readdirSync(dirs.tmp).filter((n) => n.startsWith("result.json."))).toEqual([]);
  }, 30_000);
}
