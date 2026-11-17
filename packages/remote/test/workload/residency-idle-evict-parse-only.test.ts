// #519: inventory test. `idleEvictSeconds` is status-only: it is validated
// by the NodeRun schema, defaulted by the core policy resolver, and read by
// the residency status idleEviction advisory section — never by an
// enforcement path. This pins that claim so a future idle-eviction enforcer
// has to update the doc comments in admission.ts, noderun-schema.ts and
// procedures.ts (and this test) instead of silently turning the knob on.
import { expect, test } from "bun:test";
import { dirname, join } from "node:path";

const IDLE_EVICT = "idleEvictSeconds";

// The only source files allowed to name the knob: the schema that parses
// it, the core policy type/default/resolver, and the status read-out that
// reports it. packages/mcp/src/tools/residency.ts may surface the
// `idleEviction` section but must not name the knob itself.
const ALLOWED_SRC_FILES = [
  "packages/core/src/residency/admission.ts",
  "packages/remote/src/residency/procedures.ts",
  "packages/remote/src/workload/noderun-schema.ts",
];

// `.idleEvictSeconds` member reads are allowed only in the status
// read-out; everywhere else the knob may only be declared, defaulted or
// copied.
const MEMBER_READ_FILE = "packages/remote/src/residency/procedures.ts";

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
    } else if (rel !== MEMBER_READ_FILE && text.includes(`.${IDLE_EVICT}`)) {
      // Even the allowed files only declare, default and copy the knob:
      // no member read such as `policy.idleEvictSeconds` outside the
      // status read-out.
      violations.push(`${rel} (member read)`);
    }
  }

  const proceduresText = await Bun.file(join(repoRoot, MEMBER_READ_FILE)).text();

  expect(files.length).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
  expect(ALLOWED_SRC_FILES.filter((rel) => !files.includes(rel))).toEqual([]);
  expect(violations).toEqual([]);
  expect(proceduresText).toContain(`.${IDLE_EVICT}`);
});
