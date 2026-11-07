// scripts/measure-410.test.ts
// Issue frozename/llamactl#410 (P6) — contract for the footprint
// measurement script and the operator decision record. R1-R9 fixtures
// are pure in-memory: no process, no network, no clock. R10-R15 read
// the decision doc, the real packages/app/e2e specs and temp trees.
// The module type is imported with `import type` (erased at runtime)
// and loaded through an existsSync gate, so each case fails by
// assertion while scripts/measure-410.ts and
// docs/decisions/410-ui-runtime.md are absent.

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type * as Measure from "./measure-410.ts";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "./safe-fs.js";

const MEASURE = join(import.meta.dir, "measure-410.ts");
const DOC = join(import.meta.dir, "..", "docs", "decisions", "410-ui-runtime.md");

const REPORT_KEYS = [
  "setup",
  "dependencies",
  "lockfile",
  "renderer",
  "electron",
  "shims",
  "consoleUpkeep",
  "ci",
  "securityChecklist",
  "taskCoverage",
  "thresholds",
] as const;

const WORKFLOW_KEYS = ["ui-audit", "ui-tier-a", "ui-flows-nightly", "console-e2e"] as const;
const ELECTRON_WORKFLOWS = ["ui-audit", "ui-tier-a", "ui-flows-nightly"] as const;
const RUN_FIELDS = ["runs", "reruns", "rerunPasses", "failures", "wallClockMinutes"] as const;

async function load(): Promise<typeof Measure> {
  expect(existsSync(MEASURE)).toBe(true);
  return await import("./measure-410.ts");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) {
    return "";
  }
  const end = text.indexOf("\n## ", start + heading.length);
  return text.slice(start, end < 0 ? undefined : end);
}

describe("measure-410 contract (#410 P6)", () => {
  test("R1 exports the measurement API and the dependency sets", async () => {
    const m = await load();
    for (const name of [
      "countLines",
      "extractImportSpecifiers",
      "parseBunLock",
      "lockfileDelta",
      "diffDeps",
      "summarizeRuns",
      "collectCi",
      "evaluateThresholds",
    ] as const) {
      expect(typeof m[name]).toBe("function");
    }
    expect([...m.REMOVABLE_DEPS].sort()).toEqual([
      "bufferutil",
      "electron",
      "electron-builder",
      "electron-trpc",
      "electron-vite",
      "undici",
      "utf-8-validate",
    ]);
    expect(m.ADDED_DEPS).toEqual(["@playwright/test"]);
  });

  test("R2 countLines counts wc -l lines including an unterminated tail", async () => {
    const m = await load();
    const cases: readonly [string, number][] = [
      ["", 0],
      ["a", 1],
      ["a\n", 1],
      ["a\nb", 2],
      ["a\nb\n", 2],
      ["\n\n", 2],
    ];
    for (const [text, expected] of cases) {
      expect(m.countLines(text)).toBe(expected);
    }
  });

  test("R3 extractImportSpecifiers dedupes specifiers in first-appearance order", async () => {
    const m = await load();
    const source = [
      'import x from "./a";',
      'import type { T } from "@/lib/b";',
      'export { y } from "../c";',
      'export * from "./d";',
      'import "./index.css";',
      'const e = import("./e");',
      "import {",
      "  a,",
      "  b",
      '} from "./f";',
      '// from "./nope"',
      'import z from "./a";',
    ].join("\n");
    expect(m.extractImportSpecifiers(source)).toEqual([
      "./a",
      "@/lib/b",
      "../c",
      "./d",
      "./index.css",
      "./e",
      "./f",
    ]);
  });

  test("R4 parseBunLock reads JSONC with trailing commas and string punctuation", async () => {
    const m = await load();
    const lock = m.parseBunLock(
      '{ "lockfileVersion": 1, "workspaces": { "": { "name": "root", }, }, "packages": { "a": ["a@1.0.0", "", {}, "sha,}x"], }, }',
    );
    expect(Object.keys(lock.workspaces)).toEqual([""]);
    expect(Object.keys(lock.packages)).toEqual(["a"]);
    expect(lock.packages["a"]?.[3]).toBe("sha,}x");
  });

  test("R5 lockfileDelta drops only packages unreachable after dep removal", async () => {
    const m = await load();
    const lock = {
      workspaces: {
        "": { devDependencies: { react: "1" } },
        "packages/app": {
          dependencies: { "electron-trpc": "1", react: "1" },
          devDependencies: { electron: "1", "@playwright/test": "1" },
        },
      },
      packages: {
        electron: [
          "electron@1.0.0",
          "",
          { dependencies: { "@electron/get": "1", shared: "1" } },
          "sha-electron",
        ],
        "@electron/get": [
          "@electron/get@1.0.0",
          "",
          { dependencies: { minimatch: "9" } },
          "sha-eg",
        ],
        minimatch: ["minimatch@3.0.0", "", {}, "sha-minimatch3"],
        "@electron/get/minimatch": ["@electron/get/minimatch@9.0.0", "", {}, "sha-minimatch9"],
        shared: ["shared@1.0.0", "", {}, "sha-shared"],
        react: ["react@1.0.0", "", { dependencies: { shared: "1" } }, "sha-react"],
        "electron-trpc": ["electron-trpc@1.0.0", "", { dependencies: { debug: "4" } }, "sha-etrpc"],
        debug: ["debug@4.0.0", "", {}, "sha-debug"],
        "@playwright/test": [
          "@playwright/test@1.0.0",
          "",
          { dependencies: { playwright: "1" } },
          "sha-pw-test",
        ],
        playwright: ["playwright@1.0.0", "", {}, "sha-playwright"],
        orphan: ["orphan@1.0.0", "", {}, "sha-orphan"],
      },
    };
    const delta = m.lockfileDelta(lock, [
      { workspace: "packages/app", deps: ["electron", "electron-trpc"] },
    ]);
    expect(delta.totalEntries).toBe(11);
    expect(delta.before).toBe(9);
    expect(delta.after).toBe(4);
    expect(delta.removed).toBe(5);
    const removedList = [...delta.removedPackages].sort();
    expect(removedList).toEqual([
      "@electron/get",
      "@electron/get/minimatch",
      "debug",
      "electron",
      "electron-trpc",
    ]);
    for (const kept of [
      "shared",
      "react",
      "@playwright/test",
      "playwright",
      "minimatch",
      "orphan",
    ]) {
      expect(removedList).not.toContain(kept);
    }
  });

  test("R6 diffDeps reports present deps with field and version, absent names otherwise", async () => {
    const m = await load();
    const pkgJsons = [
      {
        path: "packages/app/package.json",
        json: {
          dependencies: {
            "electron-trpc": "1.0.0-alpha.0",
            undici: "7.30.1",
            react: "19.0.0",
          },
          devDependencies: {
            electron: "41.10.3",
            "electron-builder": "26.8.1",
            "electron-vite": "5.0.0",
            bufferutil: "^4.1.0",
            "utf-8-validate": "^6.0.6",
            "@playwright/test": "1.59.1",
          },
        },
      },
      {
        path: "package.json",
        json: { devDependencies: { typescript: "5" } },
      },
    ];
    const diff = m.diffDeps(pkgJsons, [...m.REMOVABLE_DEPS, "left-pad"]);
    expect(diff.present).toHaveLength(7);
    expect(diff.present.find((entry) => entry.name === "electron")).toEqual({
      name: "electron",
      path: "packages/app/package.json",
      field: "devDependencies",
      version: "41.10.3",
    });
    expect(diff.present.find((entry) => entry.name === "undici")).toEqual({
      name: "undici",
      path: "packages/app/package.json",
      field: "dependencies",
      version: "7.30.1",
    });
    expect(diff.absent).toEqual(["left-pad"]);
  });

  test("R7 summarizeRuns totals runs, reruns, passes, failures and wall clock", async () => {
    const m = await load();
    const runs = [
      {
        attempt: 1,
        conclusion: "success",
        status: "completed",
        createdAt: "2026-10-20T09:00:00Z",
        startedAt: "2026-10-20T10:00:00Z",
        updatedAt: "2026-10-20T10:10:00Z",
      },
      {
        attempt: 2,
        conclusion: "success",
        status: "completed",
        createdAt: "2026-10-20T09:00:00Z",
        startedAt: "2026-10-20T11:00:00Z",
        updatedAt: "2026-10-20T11:06:00Z",
      },
      {
        attempt: 3,
        conclusion: "failure",
        status: "completed",
        createdAt: "2026-10-20T09:00:00Z",
        startedAt: "2026-10-20T12:00:00Z",
        updatedAt: "2026-10-20T12:03:00Z",
      },
      {
        attempt: 1,
        conclusion: "",
        status: "in_progress",
        createdAt: "2026-10-20T13:00:00Z",
        startedAt: "2026-10-20T13:00:00Z",
        updatedAt: "2026-10-20T13:00:00Z",
      },
    ];
    const summary = m.summarizeRuns(runs);
    expect(summary.runs).toBe(4);
    expect(summary.reruns).toBe(3);
    expect(summary.rerunPasses).toBe(1);
    expect(summary.failures).toBe(1);
    expect(summary.wallClockMinutes).toBe(19);
    const empty = m.summarizeRuns([]);
    for (const field of RUN_FIELDS) {
      expect(empty[field]).toBe(0);
    }
  });

  test("R8 collectCi degrades on gh failures and summarizes workflow runs", async () => {
    const m = await load();

    const spawnFail = m.collectCi(() => {
      throw new Error("spawn gh ENOENT");
    }, {});
    expect(spawnFail.value).toBeNull();
    expect(spawnFail.reason).toContain("gh");

    let offlineCalls = 0;
    const offline = m.collectCi(
      () => {
        offlineCalls += 1;
        return { code: 0, stdout: "[]", stderr: "" };
      },
      { offline: true },
    );
    expect(offline.value).toBeNull();
    expect(offline.reason).toContain("offline");
    expect(offlineCalls).toBe(0);

    const httpFail = m.collectCi(() => ({ code: 1, stdout: "", stderr: "HTTP 401" }), {});
    expect(httpFail.value).toBeNull();
    expect(httpFail.reason).toContain("HTTP 401");

    const ghRuns = [
      {
        attempt: 1,
        conclusion: "success",
        status: "completed",
        createdAt: "2026-10-20T09:00:00Z",
        startedAt: "2026-10-20T10:00:00Z",
        updatedAt: "2026-10-20T10:05:00Z",
      },
      {
        attempt: 1,
        conclusion: "failure",
        status: "completed",
        createdAt: "2026-10-20T09:00:00Z",
        startedAt: "2026-10-20T11:00:00Z",
        updatedAt: "2026-10-20T11:02:00Z",
      },
    ];
    const recorded: string[][] = [];
    const ok = m.collectCi(
      (args) => {
        recorded.push([...args]);
        return { code: 0, stdout: JSON.stringify(ghRuns), stderr: "" };
      },
      { sinceDays: 30, now: new Date("2026-11-01T00:00:00Z") },
    );
    const value = ok.value;
    if (value === null) {
      throw new Error("collectCi returned a null value");
    }
    for (const key of WORKFLOW_KEYS) {
      const summary = value.workflows[key];
      expect(summary).toBeDefined();
      for (const field of RUN_FIELDS) {
        expect(typeof summary?.[field]).toBe("number");
      }
    }
    const electronRuns = ELECTRON_WORKFLOWS.reduce(
      (sum, key) => sum + (value.workflows[key]?.runs ?? 0),
      0,
    );
    expect(value.electronUiTotal.runs).toBe(electronRuns);
    expect(recorded.length).toBeGreaterThan(0);
    for (const args of recorded) {
      for (const flag of ["run", "list", "--workflow", "--json", "--created"]) {
        expect(args).toContain(flag);
      }
      expect(args[args.indexOf("--created") + 1]).toBe(">=2026-10-02");
    }
  });

  test("R9 evaluateThresholds emits the five verdicts and honors the flips", async () => {
    const m = await load();
    const base = {
      taskCoverage: [
        { id: "T1", covered: true },
        { id: "T2", covered: true },
        { id: "T3", covered: true },
        { id: "T4", covered: true },
        { id: "T5", covered: false },
        { id: "T6", covered: false },
      ],
      setup: {
        console: { commands: 3, launcherPresent: false, signingRequired: false },
      },
      dependencies: { removablePresent: 7, added: 1 },
      renderer: { ratio: 0.2 },
      electronMcp: { consolePathReferences: 0 },
    };
    const verdict = (
      input: Measure.ThresholdInput,
      id: string,
    ): Measure.ThresholdVerdict | undefined =>
      m.evaluateThresholds(input).find((entry) => entry.id === id)?.verdict;

    expect(verdict(base, "T1-T5-no-cli-fallback")).toBe("fail");
    expect(verdict(base, "setup-le-3-no-signing")).toBe("fail");
    expect(verdict(base, "net-deps-removed-gt-added")).toBe("pass");
    expect(verdict(base, "renderer-le-25pct")).toBe("pass");
    expect(verdict(base, "zero-electron-mcp")).toBe("pass");

    expect(verdict({ ...base, renderer: { ratio: 0.3 } }, "renderer-le-25pct")).toBe("fail");
    expect(verdict({ ...base, renderer: { ratio: null } }, "renderer-le-25pct")).toBe(
      "not-measured",
    );

    const covered = {
      ...base,
      taskCoverage: base.taskCoverage.map((entry) =>
        entry.id === "T5" ? { ...entry, covered: true } : entry,
      ),
      setup: { console: { ...base.setup.console, launcherPresent: true } },
    };
    expect(verdict(covered, "T1-T5-no-cli-fallback")).toBe("pass");
    expect(verdict(covered, "setup-le-3-no-signing")).toBe("pass");
  });

  test("R10 the decision doc carries measurements, coverage, thresholds and an open decision", () => {
    expect(existsSync(DOC)).toBe(true);
    const text = readFileSync(DOC, "utf8");

    for (const heading of [
      "## Measurements",
      "## Task coverage",
      "## Thresholds",
      "## Known gaps",
      "## Risks",
      "## Recommendation",
      "## Operator decision",
    ]) {
      expect(text).toContain(heading);
    }

    const measurements = section(text, "## Measurements");
    const fenceStart = measurements.indexOf("```json");
    const fenceEnd =
      fenceStart < 0 ? -1 : measurements.indexOf("```", fenceStart + "```json".length);
    const body =
      fenceStart < 0 || fenceEnd < 0
        ? ""
        : measurements.slice(fenceStart + "```json".length, fenceEnd);
    const report = asRecord(parseJsonSafe(body));
    expect(report?.["schema"]).toBe("measure-410/v1");
    const keys = report === null ? [] : Object.keys(report);
    for (const key of REPORT_KEYS) {
      expect(keys).toContain(key);
    }

    const lines = text.split("\n");
    const taskRow = (id: string): string => lines.find((line) => line.startsWith(`| ${id}`)) ?? "";
    for (const id of ["T1", "T2", "T3", "T4", "T5", "T6"]) {
      expect(taskRow(id)).not.toBe("");
    }
    expect(taskRow("T1")).toContain("find the unreachable node");
    expect(taskRow("T1")).toContain("packages/app/e2e/fleet.spec.ts");
    expect(taskRow("T1")).toContain("packages/app/e2e/nodes.spec.ts");
    expect(taskRow("T2")).toContain("find workload X's phase and endpoint");
    expect(taskRow("T2")).toContain("packages/app/e2e/fleet.spec.ts");
    expect(taskRow("T2")).toContain("packages/app/e2e/workloads.spec.ts");
    expect(taskRow("T3")).toContain("tail X's logs on a remote node");
    expect(taskRow("T3")).toContain("packages/app/e2e/logs.spec.ts");
    expect(taskRow("T4")).toContain("stop X with confirmation");
    expect(taskRow("T4")).toContain("packages/app/e2e/lifecycle.spec.ts");
    expect(taskRow("T5")).toContain("tail logs on two nodes in two tabs at once");
    expect(taskRow("T6")).toContain("recover after a console restart");
    for (const id of ["T1", "T3", "T4"]) {
      expect(taskRow(id)).toContain("covered");
      expect(taskRow(id)).not.toContain("not yet covered");
    }
    expect(taskRow("T2")).toContain("partial");
    expect(taskRow("T2")).not.toContain("not yet covered");
    expect(taskRow("T5")).toContain("not yet covered");
    expect(taskRow("T6")).toContain("not yet covered");
    expect(taskRow("T6")).not.toContain("usage study");
    for (const phantom of ["navigation.spec", "inspect.spec", "two-tabs.spec"]) {
      expect(text).not.toContain(phantom);
    }

    for (const needle of [
      "#489",
      "fixme",
      "bench scheduler",
      "P7-A",
      "P7-B",
      "no live usage study",
      "credentials.spec",
      "llamactl bench schedule",
      "scheduled benches stop",
    ]) {
      expect(text).toContain(needle);
    }
    for (const stale of [
      "usage parity",
      "standing in for a live human usage study",
      "not normalized against",
      "bench scheduler normalization",
      "per-runner normalization",
    ]) {
      expect(text).not.toContain(stale);
    }

    const recommendation = section(text, "## Recommendation").replaceAll(/\s+/g, " ");
    expect(recommendation).toMatch(/Option [AB]/);
    expect(recommendation).toMatch(/focused web conversion/i);
    expect(recommendation).toMatch(/retire the UI completely/i);
    expect(recommendation).toContain("P7-A");
    expect(recommendation).toContain("P7-B");
    expect(recommendation).not.toMatch(/thin launcher/);

    const decision = section(text, "## Operator decision");
    expect(decision).not.toMatch(/\bDecision:\s*[AB]\b/);
    expect(decision).not.toContain("Option A selected");
    expect(decision).not.toContain("Option B selected");
  });

  test("R11 coverage probes point at real specs and the real tree lands covered, partial and missing", async () => {
    const m = await load();
    expect(Object.keys(m.COVERAGE_PROBES).sort()).toEqual(["T1", "T2", "T3", "T4", "T5", "T6"]);
    const realSpecs = [
      "packages/app/e2e/fleet.spec.ts",
      "packages/app/e2e/lifecycle.spec.ts",
      "packages/app/e2e/logs.spec.ts",
      "packages/app/e2e/nodes.spec.ts",
      "packages/app/e2e/session.spec.ts",
      "packages/app/e2e/workloads.spec.ts",
    ];
    const mapped = new Set<string>();
    for (const probes of Object.values(m.COVERAGE_PROBES)) {
      for (const probe of probes) {
        expect(realSpecs).toContain(probe.spec);
        mapped.add(probe.spec);
      }
    }
    expect(m.COVERAGE_PROBES["T5"]).toEqual([]);
    expect(m.COVERAGE_PROBES["T6"]).toEqual([]);
    for (const phantom of [
      "navigation.spec.ts",
      "inspect.spec.ts",
      "credentials.spec.ts",
      "two-tabs.spec.ts",
    ]) {
      for (const spec of mapped) {
        expect(spec.endsWith(phantom)).toBe(false);
      }
    }

    const byId = new Map(m.measureTaskCoverage().rows.map((row) => [row.id, row]));
    expect(byId.get("T1")?.status).toBe("covered");
    expect(byId.get("T3")?.status).toBe("covered");
    expect(byId.get("T4")?.status).toBe("covered");
    expect(byId.get("T5")?.status).toBe("missing");
    expect(byId.get("T6")?.status).toBe("missing");
    const t2 = byId.get("T2");
    expect(t2?.status).toBe("partial");
    expect(t2?.covered).toBe(false);
    expect(t2?.missingNeedles).toEqual(["packages/app/e2e/workloads.spec.ts#Running"]);
    const t2probes = m.COVERAGE_PROBES["T2"] ?? [];
    expect(t2probes.map((probe) => probe.spec)).toEqual([
      "packages/app/e2e/fleet.spec.ts",
      "packages/app/e2e/workloads.spec.ts",
    ]);
    const fleet = readFileSync(
      join(import.meta.dir, "..", "packages/app/e2e/fleet.spec.ts"),
      "utf8",
    );
    for (const needle of t2probes[0]?.needles ?? []) {
      expect(fleet).toContain(needle);
    }
    const workloads = readFileSync(
      join(import.meta.dir, "..", "packages/app/e2e/workloads.spec.ts"),
      "utf8",
    );
    expect(workloads).not.toContain("Running");

    const probe = [{ needles: ["alpha"], spec: "a.spec.ts" }];
    expect(m.coverageStatus(probe, () => "alpha here")).toEqual({
      covered: true,
      missingNeedles: [],
      status: "covered",
    });
    expect(m.coverageStatus(probe, () => null)).toEqual({
      covered: false,
      missingNeedles: ["a.spec.ts (absent)"],
      status: "missing",
    });
    expect(m.coverageStatus(probe, () => "beta")).toEqual({
      covered: false,
      missingNeedles: ["a.spec.ts#alpha"],
      status: "missing",
    });
    expect(m.coverageStatus([], () => "alpha")).toEqual({
      covered: false,
      missingNeedles: [],
      status: "missing",
    });
    const pair = [
      { needles: ["alpha"], spec: "a.spec.ts" },
      { needles: ["beta"], spec: "b.spec.ts" },
    ];
    expect(m.coverageStatus(pair, (spec) => (spec === "a.spec.ts" ? "alpha" : null))).toEqual({
      covered: false,
      missingNeedles: ["b.spec.ts (absent)"],
      status: "partial",
    });
    expect(
      m.coverageStatus(pair, (spec) => (spec === "a.spec.ts" ? "alpha" : "beta here")),
    ).toEqual({ covered: true, missingNeedles: [], status: "covered" });
  });

  test("R12 measureTaskCoverage reads a temp fixture tree: covered, partial, missing", async () => {
    const m = await load();
    const root = mkdtempSync(join(tmpdir(), "measure-410-cov-"));
    const write = (spec: string, text: string): void => {
      const path = join(root, spec);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    };
    try {
      const empty = m.measureTaskCoverage(root);
      for (const row of empty.rows) {
        expect(row.status).toBe("missing");
        expect(row.covered).toBe(false);
      }
      for (const row of empty.rows) {
        for (const spec of row.specs) {
          expect(row.missingNeedles).toContain(`${spec} (absent)`);
        }
      }
      const bySpec = new Map<string, string[]>();
      for (const probes of Object.values(m.COVERAGE_PROBES)) {
        for (const probe of probes) {
          bySpec.set(probe.spec, [...(bySpec.get(probe.spec) ?? []), ...probe.needles]);
        }
      }
      for (const [spec, needles] of bySpec) {
        write(spec, needles.join("\n"));
      }
      const full = new Map(m.measureTaskCoverage(root).rows.map((row) => [row.id, row]));
      for (const id of ["T1", "T2", "T3", "T4"]) {
        expect(full.get(id)?.status).toBe("covered");
        expect(full.get(id)?.covered).toBe(true);
        expect(full.get(id)?.missingNeedles).toEqual([]);
      }
      for (const id of ["T5", "T6"]) {
        expect(full.get(id)?.status).toBe("missing");
      }
      write("packages/app/e2e/workloads.spec.ts", "a workload row without a phase assertion");
      const partial = new Map(m.measureTaskCoverage(root).rows.map((row) => [row.id, row]));
      expect(partial.get("T2")?.status).toBe("partial");
      expect(partial.get("T2")?.covered).toBe(false);
      expect(partial.get("T2")?.missingNeedles).toEqual([
        "packages/app/e2e/workloads.spec.ts#Running",
      ]);
      expect(partial.get("T1")?.status).toBe("covered");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("R13 thresholdInput forwards every measurement and evaluateThresholds reacts to it", async () => {
    const m = await load();
    const row = (id: string, covered: boolean): Measure.TaskCoverageRow => ({
      covered,
      id,
      missingNeedles: covered ? [] : ["spec#needle"],
      specs: ["packages/app/e2e/spec.ts"],
      status: covered ? "covered" : "missing",
      wallTime: null,
    });
    const setup: Measure.SetupMeasurement = {
      buildWebPresent: true,
      console: {
        buildWebPresent: true,
        commands: 3,
        launcherPresent: true,
        signingRequired: false,
      },
      signing: { adHoc: true, identity: "-" },
    };
    const dependencies: Measure.DependenciesMeasurement = {
      added: 1,
      addedDeclared: ["@playwright/test"],
      present: [],
      removablePresent: 7,
      removableTotal: 7,
      undiciRendererImportedByAnyFile: false,
    };
    const renderer: Measure.RendererMeasurement = {
      entry: "packages/app/src/main.web.tsx",
      ratio: 0.1097,
      retainedFiles: 23,
      retainedLines: 3196,
      totalFiles: 216,
      totalLines: 29136,
    };
    const electronMcp: Measure.ElectronMcpMeasurement = {
      consolePathReferences: 0,
      referencingWorkflows: [],
    };
    const coverage: Measure.TaskCoverageMeasurement = {
      rows: [
        row("T1", true),
        row("T2", true),
        row("T3", true),
        row("T4", true),
        row("T5", true),
        row("T6", false),
      ],
    };
    const input = m.thresholdInput(setup, dependencies, renderer, electronMcp, coverage);
    expect(input.taskCoverage).toEqual(coverage.rows);
    expect(input.setup.console).toEqual({
      commands: 3,
      launcherPresent: true,
      signingRequired: false,
    });
    expect(input.setup).not.toHaveProperty("buildWebPresent");
    expect(input.dependencies).toEqual({ added: 1, removablePresent: 7 });
    expect(input.renderer).toEqual({ ratio: 0.1097 });
    expect(input.electronMcp).toEqual({ consolePathReferences: 0 });
    const verdict = (entry: Measure.ThresholdInput, id: string): Measure.ThresholdVerdict =>
      m.evaluateThresholds(entry).find((result) => result.id === id)?.verdict ?? "not-measured";
    expect(verdict(input, "T1-T5-no-cli-fallback")).toBe("pass");
    expect(verdict({ ...input, taskCoverage: [] }, "T1-T5-no-cli-fallback")).toBe("fail");
    const partialRows = coverage.rows.map((entry) =>
      entry.id === "T2" ? { ...entry, covered: false, status: "partial" as const } : entry,
    );
    expect(
      verdict(
        m.thresholdInput(setup, dependencies, renderer, electronMcp, { rows: partialRows }),
        "T1-T5-no-cli-fallback",
      ),
    ).toBe("fail");
  });

  test("R14 the doc's committed taskCoverage and thresholds blocks equal the script's output", async () => {
    const m = await load();
    const text = readFileSync(DOC, "utf8");
    const measurements = section(text, "## Measurements");
    const fenceStart = measurements.indexOf("```json");
    const fenceEnd =
      fenceStart < 0 ? -1 : measurements.indexOf("```", fenceStart + "```json".length);
    expect(fenceStart).toBeGreaterThanOrEqual(0);
    expect(fenceEnd).toBeGreaterThanOrEqual(0);
    const report = asRecord(parseJsonSafe(measurements.slice(fenceStart + 7, fenceEnd)));
    expect(report).not.toBeNull();
    const fields = m.ciIndependentFields();
    expect(report?.["taskCoverage"]).toEqual(fields.taskCoverage);
    expect(report?.["thresholds"]).toEqual(fields.thresholds);
  });

  test("R15 shims and upkeep measurements survive the P7-A deletions", async () => {
    const m = await load();
    expect(m.measureShims().absent).toEqual([]);
    expect(m.measureConsoleUpkeep().absent).toEqual([]);
    const root = mkdtempSync(join(tmpdir(), "measure-410-absent-"));
    try {
      const shims = m.measureShims(root);
      expect(shims.absent).toEqual([
        "packages/app/electron.vite.config.ts",
        "packages/app/electron/trpc/dispatcher.ts",
      ]);
      expect(shims.bunShim).toBe(false);
      expect(shims.bunSqliteShim).toBe(false);
      expect(shims.cjsFormatUses).toBe(0);
      expect(shims.dispatcherLines).toBe(0);
      expect(shims.v10ShimSymbols).toBe(0);
      expect(shims.workspaceBundleEntries).toBe(0);
      const upkeep = m.measureConsoleUpkeep(root);
      expect(upkeep.absent).toEqual([
        "packages/app/e2e/harness/fixtures/seed.ts",
        "packages/remote/src/console/allowlist.ts",
      ]);
      expect(upkeep.allowlistKeys).toBe(0);
      expect(upkeep.mutationEntries).toBe(0);
      expect(upkeep.projectionEntries).toBe(0);
      expect(upkeep.sentinelCases).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
