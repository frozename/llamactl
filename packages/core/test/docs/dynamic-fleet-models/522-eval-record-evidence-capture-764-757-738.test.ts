import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { PROMOTION_METRICS } from "../../../src/qualification/promotion.js";
import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #522: eval perf evidence capture slice (#764 command surface,
// #757 perf.sqlite store, #738 provenance + host readers). Source pins run
// before doc pins so a source mutant surfaces its own needle; every source
// pin is already true at base, so only the missing doc subsection fails.
describe("#522 eval record evidence capture (#764, #757, #738)", () => {
  const evalPerfSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/eval-perf.ts"));
  const evalSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/eval.ts"));
  const benchScheduleSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/bench-schedule.ts"));
  const readersSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/readers.ts"));
  const metricsSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/metrics.ts"));
  const provenanceSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/provenance.ts"));
  const typesSrc = readOrEmpty(join(REPO, "packages/eval/src/matrix/types.ts"));
  const lifecycleSrc = readOrEmpty(join(REPO, "packages/eval/src/matrix/lifecycle.ts"));

  const sec = flat(sectionBody(/^### Capturing evidence for an arm/) ?? "");

  // The quoted names inside `export const <exportName> = [ ... ] as const`;
  // [] when the opener or its first `] as const` closer is missing.
  const quotedConstNames = (src: string, exportName: string): string[] => {
    const opener = `export const ${exportName} = [`;
    const start = src.indexOf(opener);
    if (start === -1) return [];
    const bodyStart = start + opener.length;
    const end = src.indexOf("] as const", bodyStart);
    if (end === -1) return [];
    const block = src.slice(bodyStart, end);
    return [...block.matchAll(/"([^"]+)"/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
  };

  // Kills: dropping or rewording the paragraph; changing the default engine
  // or suite in source; removing the not-serving refusal.
  test("eval perf command and refusals", () => {
    const resolveBody = enclosingBody(evalPerfSrc, "function resolveRunInput(");
    for (const needle of [
      'values["--engine"] ?? "llamacpp"',
      'values["--suite"] ?? "perf-quick"',
    ]) {
      expect(resolveBody, needle).toContain(needle);
    }
    expect(evalPerfSrc).toContain('"--hf-revision"');
    const runBody = enclosingBody(evalPerfSrc, "export async function runEvalPerf(");
    for (const needle of ["is not serving '", "servedModelIds("]) {
      expect(runBody, needle).toContain(needle);
    }
    expect(evalSrc).toContain(
      "perf --url <http://...> --engine <llamacpp|omlx|gufo|kapitsa> --model <id>",
    );
    // Kills: dropping `[--hf-revision <rev>]` from the eval.ts USAGE line, or
    // the doc synopsis drifting from that line (it claims a verbatim copy).
    const usageOptionalFlags =
      "[--suite perf-quick|perf-full] [--pid <n>] [--binary <path>] [--gguf <path>] [--hf-revision <rev>] [--quant <q>] [--ctx <n>] [--slots <n>] [--flags=<args>] [--db <path>] [--run-id <id>]";
    expect(evalSrc).toContain(`--model <id> ${usageOptionalFlags}\n`);
    expect(sec).toContain(`\`${usageOptionalFlags}\``);
    expect(sec).toContain("copied verbatim from the USAGE text");
    expect(sec).not.toContain("omits it");
    for (const needle of [
      "`llamactl eval perf --url <http://...> --engine <llamacpp|omlx|gufo|kapitsa> --model <id>`",
      "already serving",
      "never starts or stops the engine",
      "`perf-quick`",
      "`perf-full`",
      "`--engine` defaults to `llamacpp`",
      "is not serving '<model>'",
      "`--hf-revision`",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: a moved db path; a changed output header; a changed run_id line.
  test("perf.sqlite location, run id and output", () => {
    const dbBody = enclosingBody(benchScheduleSrc, "export function defaultPerfDbPath(");
    for (const needle of ['"perf.sqlite"', '"eval"']) {
      expect(dbBody, needle).toContain(needle);
    }
    const runBody = enclosingBody(evalPerfSrc, "export async function runEvalPerf(");
    expect(runBody, "run_id: ${runId}").toContain("run_id: ${runId}");
    const tableBody = enclosingBody(evalPerfSrc, "function printPerfTable(");
    expect(tableBody).toContain("| metric | status | value | reason |");
    for (const needle of [
      "`perf.sqlite`",
      "`eval/`",
      "`$DEV_STORAGE`",
      "`~/.llamactl`",
      "`--db`",
      "`run_id: <id>`",
      "`| metric | status | value | reason |`",
      "the same `perf.sqlite` as `bench schedule` suites",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: allowing --pid off loopback; dropping the Linux gate; rewording
  // the doc.
  test("host readers: loopback, Linux-only counters, remote reasons", () => {
    const resolveBody = enclosingBody(evalPerfSrc, "function resolveRunInput(");
    for (const needle of [
      "--pid needs a loopback --url (got ",
      "host counters are read on this machine",
    ]) {
      expect(resolveBody, needle).toContain(needle);
    }
    for (const needle of [
      "/proc/${String(pid)}/io",
      "/proc/${String(pid)}/status",
      "is Linux-only",
    ]) {
      expect(readersSrc, needle).toContain(needle);
    }
    const remoteBody = enclosingBody(evalPerfSrc, "function remoteReasons(");
    expect(remoteBody).toContain("is not on this host");
    // Kills: gating the GTT reader on --pid, or dropping the non-Linux GTT
    // reason, while the doc says GTT is read with or without --pid.
    const hostBody = enclosingBody(evalPerfSrc, "function hostReaders(");
    expect(hostBody).toContain('if (platform === "linux") {\n    readers.gtt = linuxGttReader();');
    expect(hostBody).toContain("are Linux-only; no GTT reader on ${platform}");
    expect(sec).toContain(
      "GTT comes from the GTT probe on any loopback Linux run, with or without `--pid`",
    );
    for (const needle of [
      "`--pid` needs a loopback `--url`",
      "host counters are read on this machine",
      "`/proc/<pid>/io`",
      "VmHWM",
      "Linux-only",
      "macOS",
      "`unavailable`",
      "non-loopback",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: a metric added to or renamed in PERF_METRIC_NAMES without a doc
  // update; the doc claiming perf fills the promotion cells.
  test("perf metrics are not promotion metrics", () => {
    const perfMetricNames = quotedConstNames(metricsSrc, "PERF_METRIC_NAMES");
    expect(perfMetricNames.length).toBe(16);
    const promotionNames = new Set<string>(PROMOTION_METRICS);
    expect(perfMetricNames.filter((name) => promotionNames.has(name))).toEqual([]);
    expect(sec).toContain(
      "`eval perf` records perf metrics, not promotion metrics, so it does not fill the table above",
    );
    for (const name of perfMetricNames) {
      expect(sec, `\`${name}\``).toContain(`\`${name}\``);
    }
  });

  // Kills: a renamed or added provenance field; a broken anchor; a dropped
  // manual-shard caveat.
  test("provenance fields and unavailable reasons", () => {
    const fields = quotedConstNames(typesSrc, "PROVENANCE_UNAVAILABLE_FIELDS");
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(sec, `\`${field}\``).toContain(`\`${field}\``);
    }
    expect(provenanceSrc).toContain("HF_SNAPSHOT_RE");
    expect(provenanceSrc).toContain("\\/snapshots\\/");
    expect(provenanceSrc).toContain("gguf path is not under an HF snapshots/<rev>/ directory");
    for (const needle of [
      "`provenance.unavailable`",
      "`snapshots/<rev>/`",
      "`--hf-revision`",
      "`gguf_sha256`",
      "[Download, checksum and rollback](#download-checksum-and-rollback)",
    ]) {
      expect(sec, needle).toContain(needle);
    }
    const anchors = doc
      .split("\n")
      .filter((line) => /^#{1,6} /.test(line))
      .map((line) =>
        line
          .replace(/^#+ /, "")
          .trim()
          .toLowerCase()
          .replaceAll(/[^a-z0-9 -]/g, "")
          .replaceAll(" ", "-"),
      );
    expect(anchors).toContain("download-checksum-and-rollback");
  });

  // Kills: widening or narrowing the external-only set; doc drift.
  test("external-only engines", () => {
    const engineBody = enclosingBody(typesSrc, "export function isExternalOnlyEngine(");
    expect(engineBody, 'engine === "gufo" || engine === "kapitsa"').toContain(
      'engine === "gufo" || engine === "kapitsa"',
    );
    expect(lifecycleSrc).toContain("run the server externally");
    expect(sec).not.toContain("`gufo-glm53-exp` runs on the `gufo` engine");
    for (const needle of [
      "`gufo` and `kapitsa` are external-only",
      "never boots",
      "run the server externally",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // The flag names inside `const VALUED_FLAGS: ReadonlySet<string> = new Set([ ... ]);`.
  const valuedFlags = (): string[] => {
    const opener = "const VALUED_FLAGS: ReadonlySet<string> = new Set([";
    const start = evalPerfSrc.indexOf(opener);
    if (start === -1) return [];
    const bodyStart = start + opener.length;
    const end = evalPerfSrc.indexOf("]);", bodyStart);
    if (end === -1) return [];
    const block = evalPerfSrc.slice(bodyStart, end);
    return [...block.matchAll(/"([^"]+)"/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
  };
  const usagePerfLine =
    evalSrc.split("\n").find((line) => line.startsWith("  perf --url <http://...>")) ?? "";

  // A flag the doc cites must be parsed (VALUED_FLAGS) and listed in the
  // eval.ts USAGE perf line, so a rename on either side fails.
  const expectFlagInSource = (flag: string): void => {
    expect(valuedFlags(), `VALUED_FLAGS has ${flag}`).toContain(flag);
    const listed = [`${flag} <`, `${flag}=<`, `[${flag} `].some((form) =>
      usagePerfLine.includes(form),
    );
    expect(listed, `USAGE perf line lists ${flag}`).toBe(true);
  };

  // Kills: rewording the default-suite sentence; renaming --suite in
  // VALUED_FLAGS or USAGE; changing the suite choices in USAGE.
  test("default suite claim is pinned as one phrase", () => {
    expectFlagInSource("--suite");
    expect(usagePerfLine).toContain("[--suite perf-quick|perf-full]");
    expect(sec).toContain("`--suite` defaults to `perf-quick`; the other choice is `perf-full`.");
  });

  // Kills: rewording the no-PID sentence; dropping the unknown-PID reason
  // from createPerfHostReaders; renaming --pid.
  test("no --pid records per-process counters unavailable with the unknown-PID reason", () => {
    expectFlagInSource("--pid");
    const readersBody = enclosingBody(readersSrc, "export function createPerfHostReaders(");
    expect(readersBody).toContain("opts.pid === null");
    expect(readersBody).toContain("engine PID unknown");
    expect(sec).toContain(
      "Without `--pid`, those counters are recorded `unavailable` with a reason naming the unknown engine PID",
    );
  });

  // Kills: rewording any provenance sentence; renaming --binary, --gguf,
  // --quant, --ctx or --flags; buildProvenance dropping one of them; moving
  // the snapshots/<rev> reason out of collectHfRevision.
  test("provenance flag sentences", () => {
    for (const flag of ["--binary", "--gguf", "--quant", "--ctx", "--flags", "--hf-revision"]) {
      expectFlagInSource(flag);
    }
    const provBody = enclosingBody(evalPerfSrc, "function buildProvenance(");
    for (const needle of [
      'binary_path: values["--binary"]',
      'gguf_path: values["--gguf"]',
      'quant: values["--quant"]',
      "ctx: input.ctx",
      "flags: input.flags",
      'values["--hf-revision"]',
    ]) {
      expect(provBody, needle).toContain(needle);
    }
    const hfBody = enclosingBody(provenanceSrc, "function collectHfRevision(");
    expect(hfBody).toContain("gguf path is not under an HF snapshots/<rev>/ directory");
    for (const needle of [
      "`--binary` gives the engine version, the engine commit and the `binary_sha256`.",
      "`--gguf` gives `gguf_sha256`.",
      "`--quant`, `--ctx` and `--flags` fill their fields.",
      'For example, "gguf path is not under an HF snapshots/<rev>/ directory" (`collectHfRevision`, `packages/eval/src/perf/provenance.ts`).',
      "`gguf_sha256` hashes only the file passed as `--gguf`.",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Kills: rewording the run-id sentence; renaming --run-id; changing the
  // generated id away from model + timestamp.
  test("--run-id override and generated id", () => {
    expectFlagInSource("--run-id");
    const runBody = enclosingBody(evalPerfSrc, "export async function runEvalPerf(");
    expect(runBody).toContain(
      'values["--run-id"] ?? `perf-${resolved.model}-${new Date().toISOString()}`',
    );
    expect(sec).toContain(
      "`--run-id <id>` overrides the id; otherwise it is generated from the model and the run timestamp.",
    );
  });

  // Kills: rewording the gufo-glm53-exp sentence; the template changing
  // kind or engine.
  test("gufo-glm53-exp is a llamacpp ModelHost", () => {
    const template = readOrEmpty(join(REPO, "templates/workloads/gufo-glm53-exp-z13.yaml"));
    expect(template).toContain("kind: ModelHost\nmetadata:\n  name: gufo-glm53-exp\n");
    expect(template).toContain("\nspec:\n  engine: llamacpp\n");
    expect(sec).toContain(
      "The `gufo-glm53-exp` template is a `ModelHost` with `engine: llamacpp`, not the `gufo` engine.",
    );
  });

  // Kills: rewording or dropping the promotion-cells sentence.
  test("promotion cells stay unavailable", () => {
    expect(sec).toContain(
      "The promotion cells stay `unavailable` until promotion evidence is committed.",
    );
  });

  // Kills: reintroducing a file:line citation; renaming or moving a cited
  // symbol out of the file the doc names; a cited symbol losing the
  // behaviour the doc attributes to it.
  test("source citations name symbols that exist in the cited files", () => {
    expect(/\.ts:\d/.test(sec), "no file:line citation").toBe(false);
    const citations: [symbol: string, path: string, src: string, declaration: string][] = [
      ["USAGE", "packages/cli/src/commands/eval.ts", evalSrc, "const USAGE = `"],
      ["VALUED_FLAGS", "packages/cli/src/commands/eval-perf.ts", evalPerfSrc, "const VALUED_FLAGS"],
      [
        "runEvalPerf",
        "packages/cli/src/commands/eval-perf.ts",
        evalPerfSrc,
        "export async function runEvalPerf(",
      ],
      [
        "defaultPerfDbPath",
        "packages/cli/src/commands/bench-schedule.ts",
        benchScheduleSrc,
        "export function defaultPerfDbPath(",
      ],
      [
        "printPerfTable",
        "packages/cli/src/commands/eval-perf.ts",
        evalPerfSrc,
        "function printPerfTable(",
      ],
      [
        "resolveRunInput",
        "packages/cli/src/commands/eval-perf.ts",
        evalPerfSrc,
        "function resolveRunInput(",
      ],
      [
        "createPerfHostReaders",
        "packages/eval/src/perf/readers.ts",
        readersSrc,
        "export function createPerfHostReaders(",
      ],
      [
        "hostReaders",
        "packages/cli/src/commands/eval-perf.ts",
        evalPerfSrc,
        "function hostReaders(",
      ],
      [
        "remoteReasons",
        "packages/cli/src/commands/eval-perf.ts",
        evalPerfSrc,
        "function remoteReasons(",
      ],
      [
        "collectHfRevision",
        "packages/eval/src/perf/provenance.ts",
        provenanceSrc,
        "function collectHfRevision(",
      ],
      [
        "isExternalOnlyEngine",
        "packages/eval/src/matrix/types.ts",
        typesSrc,
        "export function isExternalOnlyEngine(",
      ],
      [
        "buildBootCommandForModelSpec",
        "packages/eval/src/matrix/lifecycle.ts",
        lifecycleSrc,
        "export function buildBootCommandForModelSpec(",
      ],
      [
        "ensureModelServing",
        "packages/eval/src/matrix/lifecycle.ts",
        lifecycleSrc,
        "export async function ensureModelServing(",
      ],
    ];
    for (const [symbol, path, src, declaration] of citations) {
      expect(sec, `cites \`${symbol}\``).toContain(`\`${symbol}\``);
      expect(sec, `cites \`${path}\``).toContain(`\`${path}\``);
      expect(src, `${path} declares ${symbol}`).toContain(declaration);
    }
    // What each cited function is credited with lives in that function.
    const credited: [signature: string, src: string, needle: string][] = [
      ["export function createPerfHostReaders(", readersSrc, "is Linux-only"],
      ["export function buildBootCommandForModelSpec(", lifecycleSrc, "run the server externally"],
      ["export async function ensureModelServing(", lifecycleSrc, "run the server externally"],
      ["function resolveRunInput(", evalPerfSrc, "--pid needs a loopback --url"],
      ["export async function runEvalPerf(", evalPerfSrc, "is not serving '"],
    ];
    for (const [signature, src, needle] of credited) {
      expect(enclosingBody(src, signature), `${signature} ${needle}`).toContain(needle);
    }
    for (const needle of [
      "(`USAGE`, `packages/cli/src/commands/eval.ts`)",
      "`VALUED_FLAGS` (`packages/cli/src/commands/eval-perf.ts`)",
      "(`createPerfHostReaders`, `packages/eval/src/perf/readers.ts`)",
      "(`hostReaders`, `packages/cli/src/commands/eval-perf.ts`)",
      "(`buildBootCommandForModelSpec` and `ensureModelServing`, `packages/eval/src/matrix/lifecycle.ts`)",
    ]) {
      expect(sec, needle).toContain(needle);
    }
  });

  // Every citation in the subsection, pinned as one phrase: the claim it
  // supports, the cited symbol(s) and the cited path together. Each cited
  // symbol must be declared in the cited file, and where the citation credits
  // a function with a behaviour, that behaviour must live in its body.
  // Kills: moving a citation to another file (e.g. `defaultPerfDbPath` to
  // `packages/eval/src/perf/diff.ts`, which also declares one); swapping two
  // citations between claims (e.g. `hostReaders` <-> `remoteReasons`);
  // renaming or moving a cited symbol out of the cited file; moving the
  // credited behaviour out of the cited function.
  test("every evidence citation pins claim, symbol and path together", () => {
    const sources = new Map<string, string>([
      ["packages/cli/src/commands/eval.ts", evalSrc],
      ["packages/cli/src/commands/eval-perf.ts", evalPerfSrc],
      ["packages/cli/src/commands/bench-schedule.ts", benchScheduleSrc],
      ["packages/eval/src/perf/readers.ts", readersSrc],
      ["packages/eval/src/perf/metrics.ts", metricsSrc],
      ["packages/eval/src/perf/provenance.ts", provenanceSrc],
      ["packages/eval/src/matrix/types.ts", typesSrc],
      ["packages/eval/src/matrix/lifecycle.ts", lifecycleSrc],
    ]);
    type Cited = { symbol: string; path: string; declaration: string; credits?: string[] };
    const rows: { phrase: string; cited: Cited[] }[] = [
      {
        phrase:
          "Both are copied verbatim from the USAGE text (`USAGE`, `packages/cli/src/commands/eval.ts`)",
        cited: [
          {
            symbol: "USAGE",
            path: "packages/cli/src/commands/eval.ts",
            declaration: "const USAGE = `Usage: llamactl eval <subcommand>",
          },
        ],
      },
      {
        phrase:
          "every valued flag in it is in `VALUED_FLAGS` (`packages/cli/src/commands/eval-perf.ts`).",
        cited: [
          {
            symbol: "VALUED_FLAGS",
            path: "packages/cli/src/commands/eval-perf.ts",
            declaration: "const VALUED_FLAGS: ReadonlySet<string> = new Set([",
          },
        ],
      },
      {
        phrase:
          "exits 1 with `engine at <url> is not serving '<model>' (serving: ...)` (`runEvalPerf`, `packages/cli/src/commands/eval-perf.ts`).",
        cited: [
          {
            symbol: "runEvalPerf",
            path: "packages/cli/src/commands/eval-perf.ts",
            declaration: "export async function runEvalPerf(",
            credits: ["is not serving '"],
          },
        ],
      },
      {
        phrase:
          "`$DEV_STORAGE` or `~/.llamactl` (`defaultPerfDbPath`, `packages/cli/src/commands/bench-schedule.ts`), or to `--db`.",
        cited: [
          {
            symbol: "defaultPerfDbPath",
            path: "packages/cli/src/commands/bench-schedule.ts",
            declaration: "export function defaultPerfDbPath(",
            credits: ['join(llamactlHome(), "eval")', '"perf.sqlite"'],
          },
        ],
      },
      {
        phrase:
          "`run_id: <id>` and then a `| metric | status | value | reason |` table (`runEvalPerf` and `printPerfTable`, `packages/cli/src/commands/eval-perf.ts`).",
        cited: [
          {
            symbol: "runEvalPerf",
            path: "packages/cli/src/commands/eval-perf.ts",
            declaration: "export async function runEvalPerf(",
            credits: ["run_id: "],
          },
          {
            symbol: "printPerfTable",
            path: "packages/cli/src/commands/eval-perf.ts",
            declaration: "function printPerfTable(",
            credits: ["| metric | status | value | reason |"],
          },
        ],
      },
      {
        phrase:
          "`--pid` needs a loopback `--url` (`resolveRunInput`, `packages/cli/src/commands/eval-perf.ts`).",
        cited: [
          {
            symbol: "resolveRunInput",
            path: "packages/cli/src/commands/eval-perf.ts",
            declaration: "function resolveRunInput(",
            credits: ["--pid needs a loopback --url"],
          },
        ],
      },
      {
        phrase:
          "with a reason naming the unknown engine PID (`createPerfHostReaders`, `packages/eval/src/perf/readers.ts`).",
        cited: [
          {
            symbol: "createPerfHostReaders",
            path: "packages/eval/src/perf/readers.ts",
            declaration: "export function createPerfHostReaders(",
            credits: ["engine PID unknown"],
          },
        ],
      },
      {
        phrase:
          "GTT comes from the GTT probe on any loopback Linux run, with or without `--pid` (`hostReaders`, `packages/cli/src/commands/eval-perf.ts`).",
        cited: [
          {
            symbol: "hostReaders",
            path: "packages/cli/src/commands/eval-perf.ts",
            declaration: "function hostReaders(",
            credits: ["readers.gtt = linuxGttReader();"],
          },
        ],
      },
      {
        phrase:
          "on macOS each is recorded `unavailable` with a named reason (`createPerfHostReaders`, `packages/eval/src/perf/readers.ts`, and `hostReaders`, `packages/cli/src/commands/eval-perf.ts`).",
        cited: [
          {
            symbol: "createPerfHostReaders",
            path: "packages/eval/src/perf/readers.ts",
            declaration: "export function createPerfHostReaders(",
            credits: ["is Linux-only"],
          },
          {
            symbol: "hostReaders",
            path: "packages/cli/src/commands/eval-perf.ts",
            declaration: "function hostReaders(",
            credits: ["are Linux-only"],
          },
        ],
      },
      {
        phrase:
          "every host counter is recorded `unavailable`, with a reason naming the remote engine (`remoteReasons`, `packages/cli/src/commands/eval-perf.ts`).",
        cited: [
          {
            symbol: "remoteReasons",
            path: "packages/cli/src/commands/eval-perf.ts",
            declaration: "function remoteReasons(",
            credits: ["is not on this host; per-process counters need a local engine PID"],
          },
        ],
      },
      {
        phrase: "The 16 `PERF_METRIC_NAMES` (`packages/eval/src/perf/metrics.ts`) are",
        cited: [
          {
            symbol: "PERF_METRIC_NAMES",
            path: "packages/eval/src/perf/metrics.ts",
            declaration: "export const PERF_METRIC_NAMES = [",
          },
        ],
      },
      {
        phrase:
          "Each `PROVENANCE_UNAVAILABLE_FIELDS` field (`packages/eval/src/matrix/types.ts`) —",
        cited: [
          {
            symbol: "PROVENANCE_UNAVAILABLE_FIELDS",
            path: "packages/eval/src/matrix/types.ts",
            declaration: "export const PROVENANCE_UNAVAILABLE_FIELDS = [",
          },
        ],
      },
      {
        phrase:
          'For example, "gguf path is not under an HF snapshots/<rev>/ directory" (`collectHfRevision`, `packages/eval/src/perf/provenance.ts`).',
        cited: [
          {
            symbol: "collectHfRevision",
            path: "packages/eval/src/perf/provenance.ts",
            declaration: "function collectHfRevision(",
            credits: ["gguf path is not under an HF snapshots/<rev>/ directory"],
          },
        ],
      },
      {
        phrase:
          "`gufo` and `kapitsa` are external-only eval engines (`isExternalOnlyEngine`, `packages/eval/src/matrix/types.ts`).",
        cited: [
          {
            symbol: "isExternalOnlyEngine",
            path: "packages/eval/src/matrix/types.ts",
            declaration: "export function isExternalOnlyEngine(",
            credits: ['engine === "gufo" || engine === "kapitsa"'],
          },
        ],
      },
      {
        phrase:
          'the matrix lifecycle refuses with "... run the server externally" (`buildBootCommandForModelSpec` and `ensureModelServing`, `packages/eval/src/matrix/lifecycle.ts`).',
        cited: [
          {
            symbol: "buildBootCommandForModelSpec",
            path: "packages/eval/src/matrix/lifecycle.ts",
            declaration: "export function buildBootCommandForModelSpec(",
            credits: ["run the server externally"],
          },
          {
            symbol: "ensureModelServing",
            path: "packages/eval/src/matrix/lifecycle.ts",
            declaration: "export async function ensureModelServing(",
            credits: ["run the server externally"],
          },
        ],
      },
    ];
    for (const { phrase, cited } of rows) {
      expect(sec, `claim + citation: ${phrase}`).toContain(phrase);
      for (const { symbol, path, declaration, credits } of cited) {
        expect(phrase, `row names \`${symbol}\``).toContain(`\`${symbol}\``);
        expect(phrase, `row names \`${path}\``).toContain(`\`${path}\``);
        expect(declaration, `declaration names ${symbol}`).toContain(symbol);
        const src = sources.get(path) ?? "";
        expect(src, `${path} declares ${symbol}`).toContain(declaration);
        for (const needle of credits ?? []) {
          expect(enclosingBody(src, declaration), `${symbol} in ${path}: ${needle}`).toContain(
            needle,
          );
        }
      }
    }
    // The table covers every parenthesised or inline citation in the section.
    const citedPaths = [...sec.matchAll(/`(packages\/[^`]+\.ts)`/g)].map((m) => m[1]);
    const tabled = rows.flatMap(({ phrase }) =>
      [...phrase.matchAll(/`(packages\/[^`]+\.ts)`/g)].map((m) => m[1]),
    );
    expect(tabled, "every cited path in the section is a pinned row").toEqual(citedPaths);
  });
});
