import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import {
  killQuiet,
  launchFromDyingParent,
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

writeFileSync(cfg.resultPath, cfg.name === "never" ? '{"ok":tr' : '{"ok":true,"pi');

const completionCheck = setInterval(() => {
  if (!existsSync(cfg.resultPath + ".release")) {
    return;
  }
  if (cfg.name !== "never") {
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
