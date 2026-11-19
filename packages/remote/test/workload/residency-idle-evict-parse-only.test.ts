// #519: inventory test. `idleEvictSeconds` is operator-enforced: it is
// validated by the NodeRun schema, defaulted by the core policy resolver,
// reported by the residency status idleEviction advisory section, displayed
// by the CLI status renderer, and read only by the residencyEvictIdle
// procedure — never by the reconciler snapshot path, which stays parse-only
// and never evicts on its own. This pins that claim so a future change that
// lets the knob leak into an automatic enforcement path has to update this
// test instead of silently turning idle eviction on.
import { expect, test } from "bun:test";
import { dirname, join } from "node:path";

const IDLE_EVICT = "idleEvictSeconds";

// The only source files allowed to name the knob: the schema that parses
// it, the core policy type/default/resolver, the status read-out that
// reports it, and the CLI status renderer that displays it.
// packages/mcp/src/tools/residency.ts may surface the
// `idleEviction` section but must not name the knob itself.
const ALLOWED_SRC_FILES = [
  "packages/core/src/residency/admission.ts",
  "packages/remote/src/residency/procedures.ts",
  "packages/remote/src/workload/noderun-schema.ts",
  // Part of #519 (residency status Idle evict: block): display-only read inside pushIdleEvictionLines
  "packages/cli/src/commands/residency.ts",
];

// `.idleEvictSeconds` member reads are allowed only in the status
// read-out; everywhere else the knob may only be declared, defaulted or
// copied. The CLI renderer is the display exception: it may read the knob,
// but only inside pushIdleEvictionLines.
const MEMBER_READ_FILE = "packages/remote/src/residency/procedures.ts";
const CLI_RENDER_FILE = "packages/cli/src/commands/residency.ts";

// The span of `function pushIdleEvictionLines(` in `text`: from the
// signature through the first later line that is exactly "}", as offsets
// into `text`. Null when the function is absent, so every knob occurrence
// then counts as outside it.
function idleEvictLinesSpan(text: string): { start: number; end: number } | null {
  const signature = "function pushIdleEvictionLines(";
  const start = text.indexOf(signature);
  if (start === -1) return null;
  const lines = text.slice(start).split("\n");
  const close = lines.findIndex((line, i) => i > 0 && line === "}");
  const end = close === -1 ? text.length : start + lines.slice(0, close + 1).join("\n").length;
  return { start, end };
}

// How many occurrences of the knob in `text` fall outside the
// pushIdleEvictionLines span (all of them when the function is absent).
function countOutsideIdleEvictLines(text: string): number {
  const span = idleEvictLinesSpan(text);
  let outside = 0;
  for (
    let at = text.indexOf(IDLE_EVICT);
    at !== -1;
    at = text.indexOf(IDLE_EVICT, at + IDLE_EVICT.length)
  ) {
    if (span === null || at < span.start || at >= span.end) outside++;
  }
  return outside;
}

// The scan currently covers several hundred source files; a much smaller
// count means the glob is not looking where it should.
const MIN_SCANNED_FILES = 300;

const SOURCE_GLOB = new Bun.Glob("packages/*/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}");

// Walk up to the workspace root (the package.json that declares workspaces)
// so the scan cannot silently point outside the repo.
async function findRepoRoot(start: string): Promise<string> {
  let dir = start;
  for (;;) {
    const pkg = Bun.file(join(dir, "package.json"));
    if (await pkg.exists()) {
      const json = (await pkg.json()) as { workspaces?: unknown };
      if (json.workspaces !== undefined) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no workspace root above ${start}`);
    dir = parent;
  }
}

function sourceFiles(repoRoot: string): string[] {
  return [...SOURCE_GLOB.scanSync({ cwd: repoRoot, onlyFiles: true })]
    .map((rel) => rel.split("\\").join("/"))
    .filter((rel) => !rel.includes("/node_modules/") && !rel.includes(".test."))
    .sort();
}

test("inventory: idleEvictSeconds appears only in the allowed source files", async () => {
  const repoRoot = await findRepoRoot(import.meta.dir);
  const files = sourceFiles(repoRoot);
  const violations: string[] = [];

  for (const rel of files) {
    const text = await Bun.file(join(repoRoot, rel)).text();
    if (!text.includes(IDLE_EVICT)) continue;
    if (!ALLOWED_SRC_FILES.includes(rel)) {
      violations.push(rel);
    } else if (rel === CLI_RENDER_FILE) {
      // The CLI status renderer may name the knob only inside
      // pushIdleEvictionLines; every occurrence outside it is a violation.
      for (let i = 0; i < countOutsideIdleEvictLines(text); i++) {
        violations.push(`${rel} (outside pushIdleEvictionLines)`);
      }
    } else if (rel !== MEMBER_READ_FILE && text.includes(`.${IDLE_EVICT}`)) {
      // Even the allowed files only declare, default and copy the knob:
      // no member read such as `policy.idleEvictSeconds` outside the
      // status read-out.
      violations.push(`${rel} (member read)`);
    }
  }

  const proceduresText = await Bun.file(join(repoRoot, MEMBER_READ_FILE)).text();
  const cliText = await Bun.file(join(repoRoot, CLI_RENDER_FILE)).text();
  const cliSpan = idleEvictLinesSpan(cliText);
  const cliBody = cliSpan === null ? "" : cliText.slice(cliSpan.start, cliSpan.end);

  expect(files.length).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
  expect(ALLOWED_SRC_FILES.filter((rel) => !files.includes(rel))).toEqual([]);
  expect(violations).toEqual([]);
  expect(proceduresText).toContain(`.${IDLE_EVICT}`);
  expect(cliBody).toContain(`.${IDLE_EVICT}`);
});

// The pure evaluator `runIdleEviction` may only be defined in the residency
// procedures module and wired into the router — the reconciler snapshot and
// the CLI must never name it, so idle eviction stays operator-invoked.
const RUN_IDLE_EVICTION_ALLOWED = [
  "packages/remote/src/residency/procedures.ts",
  "packages/remote/src/router.ts",
];

test("inventory: runIdleEviction lives only in the procedure module and router", async () => {
  const repoRoot = await findRepoRoot(import.meta.dir);
  const files = sourceFiles(repoRoot);
  const carriers: string[] = [];
  for (const rel of files) {
    const text = await Bun.file(join(repoRoot, rel)).text();
    if (text.includes("runIdleEviction")) carriers.push(rel);
  }
  carriers.sort();

  const routerText = await Bun.file(join(repoRoot, "packages/remote/src/router.ts")).text();

  expect(carriers).toEqual([...RUN_IDLE_EVICTION_ALLOWED].sort());
  expect(routerText).toContain("runIdleEviction(");
});
