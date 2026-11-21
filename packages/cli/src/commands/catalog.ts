import type { ModelClass, schemas } from "@llamactl/core";

import {
  catalog,
  catalogWriter,
  env as envMod,
  hf,
  presets,
  profile as profileMod,
  quant,
  target as targetMod,
} from "@llamactl/core";

import {
  fanOut,
  type FanOutResult,
  getGlobals,
  getNodeClient,
  isFanOut,
  isLocalDispatch,
} from "../dispatcher.js";
type CuratedModel = schemas.CuratedModel;

type Format = "tsv" | "json";
type Scope = catalog.CatalogScope;

interface ParsedListFlags {
  scope: Scope;
  format: Format;
}

const SCOPES: readonly Scope[] = ["all", "builtin", "custom"];

function parseList(args: string[]): ParsedListFlags | { error: string } {
  let scope: Scope = "all";
  let format: Format = "tsv";
  let gotPositional = false;

  for (const arg of args) {
    switch (arg) {
      case "--json":
        format = "json";
        break;
      case "--tsv":
        format = "tsv";
        break;
      default:
        if (arg.startsWith("--")) {
          return { error: `Unknown flag for catalog list: ${arg}` };
        }
        if (gotPositional) {
          return { error: `Unexpected extra argument: ${arg}` };
        }
        if (!(SCOPES as readonly string[]).includes(arg)) {
          return {
            error: `Unknown scope: ${arg} (expected ${SCOPES.join(" | ")})`,
          };
        }
        scope = arg as Scope;
        gotPositional = true;
        break;
    }
  }

  return { scope, format };
}

function printFanOutCatalogRows(r: FanOutResult<unknown>): void {
  if (!r.ok) {
    process.stderr.write(`[${r.node}] error: ${String(r.error)}\n`);
    return;
  }
  const rows = r.data as CuratedModel[];
  if (rows.length === 0) return;
  // Prefix each TSV row with the node name so output stays grep-able.
  for (const line of catalog.formatCatalogTsv(rows).split("\n")) {
    if (line) process.stdout.write(`${r.node}\t${line}\n`);
  }
}

// `-n all` fans out across every node in the current context.
async function runListFanOut(parsed: ParsedListFlags): Promise<number> {
  const results = await fanOut((client) => client.catalogList.query(parsed.scope));
  if (parsed.format === "json") {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return results.some((r) => !r.ok) ? 2 : 0;
  }
  for (const r of results) {
    printFanOutCatalogRows(r);
  }
  return results.some((r) => !r.ok) ? 2 : 0;
}

async function fetchCatalogEntries(scope: Scope): Promise<CuratedModel[] | null> {
  if (isLocalDispatch()) {
    return catalog.listCatalog(scope);
  }
  try {
    return await getNodeClient().catalogList.query(scope);
  } catch (err) {
    process.stderr.write(
      `catalog list: remote call to '${getGlobals().nodeName ?? ""}' failed: ${(err as Error).message}\n`,
    );
    return null;
  }
}

async function runList(args: string[]): Promise<number> {
  const parsed = parseList(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }

  if (isFanOut()) {
    return await runListFanOut(parsed);
  }

  const entries = await fetchCatalogEntries(parsed.scope);
  if (entries === null) return 1;

  if (parsed.format === "json") {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return 0;
  }

  // Historical shell output was raw TSV with a trailing newline per row
  // and no final blank line at the end of the block. Match that shape.
  if (entries.length === 0) return 0;
  process.stdout.write(`${catalog.formatCatalogTsv(entries)}\n`);
  return 0;
}

const USAGE = `Usage: llamactl catalog <subcommand>

Subcommands:
  list [all|builtin|custom] [--json|--tsv]
      Print catalog rows. Default scope: all. Default format: tsv.

  status <rel> [--json]
      Inspect a rel: catalog membership, layered class resolution
      (catalog -> HF pipeline -> path pattern), quant, scope, family,
      and whether the file is installed on disk.

  add <hf-repo> <gguf-file-or-relpath> [label] [family] [class] [scope] [--meta <json>]
      Append an entry to the custom catalog. Missing fields are
      derived: label from the GGUF basename, family from the repo
      substring, class from the HF pipeline_tag (falls back to
      path-pattern classifier), scope defaults to 'candidate'.
      Refuses to add a rel that's already in any catalog.
      --meta takes a JSON object of candidate keys (availability,
      qualification, runtime, contextMax, params, memory,
      residencyGroup, license), validated strictly and written as
      catalog column 9.
      A bare -- ends flag parsing.

  promote <profile> <best|vision|balanced|fast> <rel-or-alias>
      Write a preset override so <profile>:<preset> resolves to the
      given rel. Updates in place when a row for (profile, preset)
      already exists.

  promotions
      Print the active preset-override rows.
`;

interface StatusReport {
  rel: string;
  installed: boolean;
  quant: string;
  catalog: {
    hit: "builtin" | "custom" | "none";
    label: string | null;
    family: string | null;
    scope: string | null;
    repo: string | null;
  };
  class: {
    value: ModelClass;
    source: "catalog" | "hf" | "pattern";
  };
  hf: {
    enabled: boolean;
    repo: string | null;
    pipeline_tag: string | null;
  };
}

function classifyFromPattern(rel: string): ModelClass {
  if (rel.startsWith("gemma-4-") || rel.startsWith("Qwen3.6-35B-A3B-GGUF/")) return "multimodal";
  if (
    rel.startsWith("Qwen3.5-") ||
    rel.startsWith("DeepSeek-") ||
    rel.startsWith("deepseek-") ||
    rel.includes("R1")
  ) {
    return "reasoning";
  }
  return "general";
}

async function resolveLayeredClass(rel: string): Promise<{
  value: ModelClass;
  source: StatusReport["class"]["source"];
  repo: string | null;
  pipeline: string | null;
  hfEnabled: boolean;
}> {
  const fromCatalog = catalog.findByRel(rel);
  if (fromCatalog) {
    return {
      value: fromCatalog.class,
      source: "catalog",
      repo: fromCatalog.repo,
      pipeline: null,
      hfEnabled: hf.hfEnabled(),
    };
  }

  const resolved = envMod.resolveEnv();
  const hfOn = hf.hfEnabled();
  let repo: string | null = null;
  const slash = rel.indexOf("/");
  if (slash > 0) {
    repo = `${resolved.LOCAL_AI_DISCOVERY_AUTHOR}/${rel.slice(0, slash)}`;
  }

  let pipeline: string | null = null;
  if (hfOn && repo) {
    const info = await hf.fetchModelInfo(repo);
    if (info) {
      pipeline = info.pipeline_tag ?? info.pipelineTag ?? null;
      if (
        pipeline === "image-text-to-text" ||
        pipeline === "visual-question-answering" ||
        pipeline === "image-to-text"
      ) {
        return { value: "multimodal", source: "hf", repo, pipeline, hfEnabled: hfOn };
      }
    }
  }

  return { value: classifyFromPattern(rel), source: "pattern", repo, pipeline, hfEnabled: hfOn };
}

async function runStatus(args: string[]): Promise<number> {
  const flags = new Set<string>();
  let rel = "";
  for (const arg of args) {
    if (arg.startsWith("--")) flags.add(arg);
    else if (!rel) rel = arg;
    else {
      process.stderr.write(`Unexpected extra argument: ${arg}\n`);
      return 1;
    }
  }
  if (!rel) {
    process.stderr.write(`Usage: llamactl catalog status <rel> [--json]\n`);
    return 1;
  }

  const resolved = envMod.resolveEnv();
  const installed = await Bun.file(`${resolved.LLAMA_CPP_MODELS}/${rel}`).exists();
  const entry = catalog.findByRel(rel);
  const klass = await resolveLayeredClass(rel);

  const report: StatusReport = {
    rel,
    installed,
    quant: quant.quantFromRel(rel),
    catalog: entry
      ? {
          hit: catalog.findByRel(rel, { scope: "builtin" }) ? "builtin" : "custom",
          label: entry.label,
          family: entry.family,
          scope: entry.scope,
          repo: entry.repo,
        }
      : { hit: "none", label: null, family: null, scope: null, repo: null },
    class: { value: klass.value, source: klass.source },
    hf: { enabled: klass.hfEnabled, repo: klass.repo, pipeline_tag: klass.pipeline },
  };

  if (flags.has("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  printStatusReport(report);
  return 0;
}

function printStatusReport(report: StatusReport): void {
  const c = report.catalog;
  process.stdout.write(
    [
      `rel=${report.rel}`,
      `installed=${report.installed ? "yes" : "no"}`,
      `quant=${report.quant}`,
      `catalog=${c.hit}`,
      ...(c.hit !== "none"
        ? [
            `  label=${String(c.label)}`,
            `  family=${String(c.family)}`,
            `  scope=${String(c.scope)}`,
            `  repo=${String(c.repo)}`,
          ]
        : []),
      `class=${report.class.value}`,
      `class_source=${report.class.source}`,
      `hf_enabled=${String(report.hf.enabled)}`,
      ...(report.hf.repo ? [`hf_repo=${report.hf.repo}`] : []),
      ...(report.hf.pipeline_tag ? [`hf_pipeline=${report.hf.pipeline_tag}`] : []),
      "",
    ].join("\n"),
  );
}

async function runAdd(args: string[]): Promise<number> {
  const parsed = parseAddArgs(args);
  if (parsed.kind === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    process.stderr.write(parsed.message);
    return 1;
  }
  if (parsed.positionals.length < 2) {
    process.stdout.write(USAGE);
    return 1;
  }
  return await writeCuratedEntry(parsed);
}

async function writeCuratedEntry(parsed: Extract<ParsedAddArgs, { kind: "ok" }>): Promise<number> {
  const { positionals, meta: metaStr } = parsed;
  const [repo, fileOrRel, label, family, klass, scope] = positionals;

  let metaParsed: unknown = undefined;
  if (metaStr !== undefined) {
    try {
      metaParsed = JSON.parse(metaStr);
    } catch {
      process.stderr.write("catalog add: --meta is not valid JSON\n");
      return 1;
    }
  }

  const result = await catalogWriter.addCurated({
    repo: repo ?? "",
    fileOrRel: fileOrRel ?? "",
    ...(label !== undefined ? { label } : {}),
    ...(family !== undefined ? { family } : {}),
    ...(klass !== undefined ? { class: klass } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(metaParsed !== undefined ? { meta: metaParsed } : {}),
  });
  if (!result.ok) {
    process.stderr.write(`${result.error}\n`);
    return 1;
  }
  process.stdout.write(
    [
      `Added curated entry to ${result.file}`,
      `  id=${result.entry.id}`,
      `  model=${result.entry.rel}`,
      "",
    ].join("\n"),
  );
  return 0;
}

const META_VALUE_REQUIRED = "catalog add: --meta requires a JSON value\n";

export type ParsedAddArgs =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "ok"; positionals: string[]; meta: string | undefined };

type AddArgState = "flags" | "metaValue" | "positionals";

interface AddArgAcc {
  positionals: string[];
  meta: string | undefined;
  state: AddArgState;
}

/**
 * Parse `catalog add` argv with one explicit state:
 * - "flags": flags are recognised, other tokens are positionals;
 * - "metaValue": the previous token was `--meta`, so this token is its
 *   value (always, even `--` or `--help`) and never a positional;
 * - "positionals": a bare `--` was seen, so every later token is a
 *   positional.
 * The positional count is checked by the caller.
 */
export function parseAddArgs(args: readonly string[]): ParsedAddArgs {
  const acc: AddArgAcc = { positionals: [], meta: undefined, state: "flags" };
  for (const arg of args) {
    const stop = stepAddArg(acc, arg);
    if (stop !== undefined) return stop;
  }
  if (acc.state === "metaValue") {
    return { kind: "error", message: META_VALUE_REQUIRED };
  }
  return { kind: "ok", positionals: acc.positionals, meta: acc.meta };
}

/** Consume one token; returns a result only when parsing stops early. */
function stepAddArg(acc: AddArgAcc, arg: string): ParsedAddArgs | undefined {
  if (acc.state === "metaValue") {
    acc.meta = arg;
    acc.state = "flags";
    return undefined;
  }
  if (acc.state === "positionals") {
    acc.positionals.push(arg);
    return undefined;
  }
  return stepAddFlag(acc, arg);
}

/** One token in the "flags" state. */
function stepAddFlag(acc: AddArgAcc, arg: string): ParsedAddArgs | undefined {
  if (arg === "--") {
    acc.state = "positionals";
    return undefined;
  }
  if (arg === "-h" || arg === "--help") return { kind: "help" };
  if (arg === "--meta") {
    acc.state = "metaValue";
    return undefined;
  }
  if (arg.startsWith("--meta=")) {
    const value = arg.slice("--meta=".length);
    if (value.length === 0) return { kind: "error", message: META_VALUE_REQUIRED };
    acc.meta = value;
    return undefined;
  }
  if (arg.startsWith("--")) {
    return { kind: "error", message: `catalog add: unknown flag ${arg}\n` };
  }
  acc.positionals.push(arg);
  return undefined;
}

async function runPromote(args: string[]): Promise<number> {
  if (args.length < 3 || args.includes("-h") || args.includes("--help")) {
    process.stderr.write(
      "Usage: llamactl catalog promote <profile> <best|vision|balanced|fast> <rel-or-alias>\n",
    );
    return args.length < 3 ? 1 : 0;
  }
  const [profileArg, preset, targetArg] = args;
  const normalized = profileMod.normalizeProfile(profileArg);
  if (!normalized) {
    process.stderr.write(`Unknown profile: ${String(profileArg)}\n`);
    return 1;
  }
  if (preset !== "best" && preset !== "vision" && preset !== "balanced" && preset !== "fast") {
    process.stderr.write(
      `Unknown preset: ${String(preset)} (expected best|vision|balanced|fast)\n`,
    );
    return 1;
  }

  const rel = resolvePromoteRel(targetArg);
  if (typeof rel !== "string") {
    process.stderr.write(rel.error);
    return 1;
  }

  const ok = await executePromote(normalized, preset, rel);
  if (!ok) return 1;

  process.stdout.write(`Promoted ${rel}\n`);
  process.stdout.write(`profile=${normalized} preset=${preset}\n`);
  return 0;
}

function resolvePromoteRel(targetArg: string | undefined): string | { error: string } {
  if (targetArg && (targetArg.endsWith(".gguf") || targetArg.includes("/"))) {
    return targetArg;
  }
  const resolved = targetMod.resolveTarget(targetArg);
  if (!resolved) {
    return { error: `Unknown model target: ${String(targetArg)}\n` };
  }
  return resolved;
}

async function executePromote(
  normalized: NonNullable<ReturnType<typeof profileMod.normalizeProfile>>,
  preset: "balanced" | "best" | "fast" | "vision",
  rel: string,
): Promise<boolean> {
  if (isLocalDispatch()) {
    try {
      presets.writePresetOverride(normalized, preset, rel);
    } catch (err) {
      if (err instanceof presets.ExperimentalPresetPromotionError) {
        process.stderr.write(`catalog promote: ${err.message}\n`);
        return false;
      }
      throw err;
    }
    return true;
  }
  try {
    await getNodeClient().promote.mutate({ profile: normalized, preset, rel });
    return true;
  } catch (err) {
    process.stderr.write(
      `promote: remote call to '${getGlobals().nodeName ?? ""}' failed: ${(err as Error).message}\n`,
    );
    return false;
  }
}

async function runPromotions(args: string[]): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  let rows: ReturnType<typeof presets.readPresetOverrides>;
  if (isLocalDispatch()) {
    const resolved = envMod.resolveEnv();
    rows = presets.readPresetOverrides(resolved.LOCAL_AI_PRESET_OVERRIDES_FILE);
  } else {
    try {
      rows = await getNodeClient().promotions.query();
    } catch (err) {
      process.stderr.write(
        `promotions: remote call to '${getGlobals().nodeName ?? ""}' failed: ${(err as Error).message}\n`,
      );
      return 1;
    }
  }
  if (rows.length === 0) {
    process.stdout.write("No preset promotions recorded\n");
    return 1;
  }
  process.stdout.write(`${presets.formatPromotionsList(rows)}\n`);
  return 0;
}

export async function runCatalog(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return await runList(rest);
    case "status":
      return await runStatus(rest);
    case "add":
      return await runAdd(rest);
    case "promote":
      return await runPromote(rest);
    case "promotions":
      return await runPromotions(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown catalog subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}
