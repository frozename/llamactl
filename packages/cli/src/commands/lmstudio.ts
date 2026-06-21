import { hf, lmstudio } from "@llamactl/core";

import { getGlobals, getNodeClient, isLocalDispatch } from "../dispatcher.js";

const USAGE = `Usage: llamactl lmstudio <subcommand>

Subcommands:
  scan [--root=<dir>] [--json]
      Walk $LMSTUDIO_MODELS_DIR (or ~/.lmstudio/models) for .gguf
      files and print one row per model. No state changes.

  import [--root=<dir>] [--apply] [--no-link] [--json]
      Preview (default) or materialize an import of LM Studio models
      into the llamactl custom catalog. By default \`--apply\` also
      symlinks each model into $LLAMA_CPP_MODELS/<rel> so existing
      bench / pull commands find it. \`--no-link\` registers the
      catalog row but leaves the file in place.
`;

type ScanResult = ReturnType<typeof lmstudio.scanLMStudio>;
type ImportPlan = ReturnType<typeof lmstudio.planImport>;
type ImportResult = Awaited<ReturnType<typeof lmstudio.applyImport>>;

function parseImportFlags(
  args: string[],
): { root?: string; apply: boolean; link: boolean; json: boolean } | { error: string } {
  let root: string | undefined;
  let apply = false;
  let link = true;
  let json = false;
  for (const arg of args) {
    if (arg === "--apply") apply = true;
    else if (arg === "--no-link") link = false;
    else if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") return { error: "help" };
    else if (arg.startsWith("--root=")) root = arg.slice("--root=".length);
    else if (arg.startsWith("--")) return { error: `Unknown flag: ${arg}` };
    else return { error: `Unexpected positional: ${arg}` };
  }
  return { ...(root !== undefined ? { root } : {}), apply, link, json };
}

type ScanFlags =
  | { kind: "ok"; root: string | undefined; json: boolean }
  | { kind: "help" }
  | { kind: "error"; message: string };

function parseScanFlags(args: string[]): ScanFlags {
  let root: string | undefined;
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") return { kind: "help" };
    else if (arg.startsWith("--root=")) root = arg.slice("--root=".length);
    else if (arg.startsWith("--")) return { kind: "error", message: `Unknown flag: ${arg}` };
  }
  return { kind: "ok", root, json };
}

async function fetchScan(root: string | undefined): Promise<ScanResult | null> {
  if (isLocalDispatch()) {
    return lmstudio.scanLMStudio(root !== undefined ? { root } : {});
  }
  try {
    return await getNodeClient().lmstudioScan.query(root ? { root } : undefined);
  } catch (err) {
    process.stderr.write(
      `lmstudio scan: remote call to '${getGlobals().nodeName ?? ""}' failed: ${(err as Error).message}\n`,
    );
    return null;
  }
}

async function runScan(args: string[]): Promise<number> {
  const parsed = parseScanFlags(args);
  if (parsed.kind === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    process.stderr.write(`${parsed.message}\n`);
    return 1;
  }
  const scan = await fetchScan(parsed.root);
  if (!scan) return 1;
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(scan, null, 2)}\n`);
    return scan.models.length > 0 ? 0 : 1;
  }
  if (!scan.root) {
    process.stderr.write(
      "No LM Studio install detected. Pass --root or set LMSTUDIO_MODELS_DIR.\n",
    );
    return 1;
  }
  process.stdout.write(`root=${scan.root} (${String(scan.models.length)} models)\n`);
  for (const m of scan.models) {
    process.stdout.write(
      `  ${m.rel.padEnd(40)} size=${hf.humanSize(m.sizeBytes)} repo=${m.repo} path=${m.path}\n`,
    );
  }
  return scan.models.length > 0 ? 0 : 1;
}

function buildRemoteImportInput(
  root: string | undefined,
  link: boolean,
): { root?: string; link?: boolean } | undefined {
  const input: { root?: string; link?: boolean } = {};
  if (root !== undefined) input.root = root;
  if (!link) input.link = link;
  return Object.keys(input).length > 0 ? input : undefined;
}

async function fetchImportPlan(
  root: string | undefined,
  link: boolean,
): Promise<ImportPlan | null> {
  if (isLocalDispatch()) {
    return lmstudio.planImport({ ...(root !== undefined ? { root } : {}), link });
  }
  try {
    return await getNodeClient().lmstudioPlan.query(buildRemoteImportInput(root, link));
  } catch (err) {
    process.stderr.write(
      `lmstudio plan: remote call to '${getGlobals().nodeName ?? ""}' failed: ${(err as Error).message}\n`,
    );
    return null;
  }
}

function renderImportPlan(plan: ImportPlan): number {
  if (!plan.root) {
    process.stderr.write(
      "No LM Studio install detected. Pass --root or set LMSTUDIO_MODELS_DIR.\n",
    );
    return 1;
  }
  process.stdout.write(`root=${plan.root} (${String(plan.items.length)} candidates)\n`);
  for (const item of plan.items) {
    const suffix = item.reason ? ` — ${item.reason}` : "";
    process.stdout.write(
      `  ${item.action.padEnd(26)} rel=${item.rel.padEnd(40)} target=${item.targetPath}${suffix}\n`,
    );
  }
  process.stdout.write(`\nRe-run with --apply to make the above changes.\n`);
  return 0;
}

async function runImportPreview(
  root: string | undefined,
  link: boolean,
  json: boolean,
): Promise<number> {
  const plan = await fetchImportPlan(root, link);
  if (!plan) return 1;
  if (json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }
  return renderImportPlan(plan);
}

async function fetchImportResult(
  root: string | undefined,
  link: boolean,
): Promise<ImportResult | null> {
  if (isLocalDispatch()) {
    return await lmstudio.applyImport({
      ...(root !== undefined ? { root } : {}),
      apply: true,
      link,
    });
  }
  try {
    return await getNodeClient().lmstudioImport.mutate(buildRemoteImportInput(root, link) ?? {});
  } catch (err) {
    process.stderr.write(
      `lmstudio import: remote call to '${getGlobals().nodeName ?? ""}' failed: ${(err as Error).message}\n`,
    );
    return null;
  }
}

function renderImportResult(result: ImportResult): number {
  if (!result.root) {
    process.stderr.write("No LM Studio install detected.\n");
    return 1;
  }
  process.stdout.write(
    `root=${result.root} applied=${String(result.applied.length)} skipped=${String(result.skipped.length)} errors=${String(result.errors.length)}\n`,
  );
  for (const a of result.applied) {
    process.stdout.write(`  ${a.action.padEnd(16)} rel=${a.rel}\n`);
  }
  for (const s of result.skipped) {
    process.stdout.write(`  ${s.action.padEnd(24)} rel=${s.rel} — ${s.reason}\n`);
  }
  for (const err of result.errors) {
    process.stderr.write(`  error rel=${err.rel}: ${err.error}\n`);
  }
  return result.errors.length === 0 ? 0 : 1;
}

async function runImportApply(
  root: string | undefined,
  link: boolean,
  json: boolean,
): Promise<number> {
  const result = await fetchImportResult(root, link);
  if (!result) return 1;
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.errors.length === 0 ? 0 : 1;
  }
  return renderImportResult(result);
}

async function runImport(args: string[]): Promise<number> {
  const parsed = parseImportFlags(args);
  if ("error" in parsed) {
    if (parsed.error === "help") {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const { root, apply, link, json } = parsed;
  if (!apply) {
    return await runImportPreview(root, link, json);
  }
  return await runImportApply(root, link, json);
}

export async function runLMStudio(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "scan":
      return await runScan(rest);
    case "import":
      return await runImport(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(USAGE);
      return sub ? 0 : 1;
    default:
      process.stderr.write(`Unknown lmstudio subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}
