// Part of #518: the operator surface for the pin/freeze/applied overrides,
// node-local, the same file routing reads. `qualificationOverridesFileFor`
// resolves the shared `qualification-overrides.tsv` that
// `catalogQualificationStages` and the `/v1/models` cache signature read; this
// command writes it through `writeQualificationOverride` /
// `deleteQualificationOverride` / `writeAppliedStage` and reports the catalog
// stage, the overrides, `effectiveStage` and the routing stage. The read-only
// `propose` consumer runs `evaluateQualification` over an evidence file
// (`parsePromotionEvidence`) and a policy file, then `applyQualification`
// without a writer, so it never writes the overrides file or the catalog.
// `apply` is the same runner with `writeAppliedStage` injected: the policy's
// `autoApply` gates the write, `unapply` removes the applied row. Because
// the file is node-local, every subcommand refuses a non-local `--node` target.

import {
  catalog,
  env as envMod,
  qualificationDemotion,
  qualificationOverrides,
  qualificationPromotion,
  qualificationStages,
  schemas,
  workloadRuntime,
} from "@llamactl/core";
import { userInfo } from "node:os";

import { isLocalDispatch, resolveEffectiveNodeName } from "../dispatcher.js";
import { readFileSync } from "../safe-fs.js";

type Stage = qualificationStages.QualificationStage;
type QualificationOverride = qualificationOverrides.QualificationOverride;
type NewOverride = Omit<QualificationOverride, "updated_at">;
type EffectiveStage = qualificationStages.EffectiveStage;
type QualificationDecision = qualificationDemotion.QualificationDecision;
type ApplyQualificationResult = qualificationDemotion.ApplyQualificationResult;
type AnyProposal =
  | qualificationPromotion.PromotionProposal
  | qualificationDemotion.DemotionProposal;

const USAGE = `Usage: llamactl qualification <subcommand>

Node-local qualification pin/freeze/applied overrides. The overrides file is
resolved by qualificationOverridesFileFor (LOCAL_AI_QUALIFICATION_OVERRIDES_FILE,
else qualification-overrides.tsv under the runtime dir) — the same file routing
reads.

Subcommands:
  list [--json]                       Catalog stage, pin, freeze, effective stage and routing stage per rel.
  status <rel> [--json]               One rel's catalog stage, pin, freeze, effective stage and routing stage.
  pin <rel> <stage> --reason <text> [--author <name>]   Pin a rel at a stage (blocks promotion, sets the stage).
  unpin <rel>                         Remove a rel's pin override.
  freeze <rel> --reason <text> [--author <name>]        Block promotion for a rel (no stage).
  unfreeze <rel>                      Remove a rel's freeze override.
  propose <rel> --evidence <file.json> --policy <file.json> [--json]   Read-only promotion/demotion proposal.
  apply <rel> --evidence <file.json> --policy <file.json> [--author <name>] [--json]   Record the applied stage when the policy's autoApply is on.
  unapply <rel>                       Remove a rel's applied override row.

Example:
  llamactl qualification pin <rel> production --reason "w4 bench passed"
  llamactl qualification status <rel> --json
  llamactl qualification propose <rel> --evidence evidence.json --policy policy.json
  llamactl qualification apply <rel> --evidence evidence.json --policy policy.json
`;

const VALUE_FLAGS = new Set(["--reason", "--author", "--evidence", "--policy"]);

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string>;
  json: boolean;
}

interface ConsumedFlag {
  key: string;
  value: string;
  steps: number;
  valued: boolean;
}

function consumeFlagToken(token: string, next: string | undefined): ConsumedFlag | null {
  if (!token.startsWith("--")) return null;
  const eq = token.indexOf("=");
  const key = eq >= 0 ? token.slice(0, eq) : token;
  const valued = VALUE_FLAGS.has(key);
  if (!valued) return { key, value: "", steps: 1, valued };
  if (eq >= 0) return { key, value: token.slice(eq + 1), steps: 1, valued };
  return { key, value: next ?? "", steps: next === undefined ? 1 : 2, valued };
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  let json = false;
  let i = 0;
  while (i < args.length) {
    const token = args[i] ?? "";
    if (token === "--json") {
      json = true;
      i += 1;
      continue;
    }
    const flag = consumeFlagToken(token, args[i + 1]);
    if (flag === null) {
      positional.push(token);
      i += 1;
    } else {
      if (flag.valued) flags.set(flag.key, flag.value);
      i += flag.steps;
    }
  }
  return { positional, flags, json };
}

function defaultAuthor(): string {
  try {
    return userInfo().username || "operator";
  } catch {
    return "operator";
  }
}

function asStage(value: string): Stage | undefined {
  return (schemas.QUALIFICATION_STAGES as readonly string[]).includes(value)
    ? (value as Stage)
    : undefined;
}

function zodIssueMessages(err: unknown): string[] | null {
  if (typeof err !== "object" || err === null) return null;
  const issues = (err as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return null;
  return issues
    .map((issue): string => {
      if (typeof issue !== "object" || issue === null) return "";
      const message = (issue as { message?: unknown }).message;
      return typeof message === "string" ? message : "";
    })
    .filter((message) => message !== "");
}

/**
 * Like zodIssueMessages, but prefixes each message with its issue path
 * (e.g. `toolCallCorrectness: Too big ...`) so an operator can find the
 * offending key in an evidence or policy file.
 */
function zodIssueMessagesWithPath(err: unknown): string[] | null {
  if (typeof err !== "object" || err === null) return null;
  const issues = (err as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return null;
  return issues
    .map((issue): string => {
      if (typeof issue !== "object" || issue === null) return "";
      const { message, path } = issue as { message?: unknown; path?: unknown };
      if (typeof message !== "string") return "";
      const keys = Array.isArray(path)
        ? path.filter((key) => typeof key === "string" || typeof key === "number")
        : [];
      return keys.length > 0 ? `${keys.join(".")}: ${message}` : message;
    })
    .filter((message) => message !== "");
}

interface OverrideView {
  stage: string;
  author: string;
  reason: string;
  updated_at: string;
}

interface StatusView {
  rel: string;
  catalogStage: string | null;
  pin: OverrideView | null;
  freeze: OverrideView | null;
  effective: EffectiveStage | null;
  routingStage: string | null;
  applied: OverrideView | null;
}

interface GroupedOverrides {
  pin?: QualificationOverride;
  freeze?: QualificationOverride;
  applied?: QualificationOverride;
}

interface QualContext {
  file: string;
  catalogStageByRel: Map<string, Stage>;
  routingStages: Map<string, Stage>;
  overrideRows: QualificationOverride[];
}

function buildContext(): QualContext {
  const resolved = envMod.resolveEnv(process.env);
  const file = qualificationOverrides.qualificationOverridesFileFor(resolved);
  const catalogStageByRel = new Map<string, Stage>();
  const rows = catalog.listCatalog("all", {
    customCatalogFile: workloadRuntime.customCatalogFileFor(resolved),
  });
  for (const row of rows) {
    const stage = row.qualification?.stage;
    if (stage === undefined) catalogStageByRel.delete(row.rel);
    else catalogStageByRel.set(row.rel, stage);
  }
  return {
    file,
    catalogStageByRel,
    routingStages: workloadRuntime.catalogQualificationStages(resolved),
    overrideRows: qualificationOverrides.readQualificationOverrides(file),
  };
}

function overrideView(row: QualificationOverride): OverrideView {
  return {
    stage: row.stage,
    author: row.author,
    reason: row.reason,
    updated_at: row.updated_at,
  };
}

/**
 * The declared stage shared by propose, apply and status: the applied
 * row's stage first (a completed apply re-baselines the rel), then the
 * catalog stage, then the pin stage (#518). Empty stages read as absent.
 */
function declaredFor(ctx: QualContext, rel: string, grouped: GroupedOverrides): Stage | undefined {
  const appliedStage = grouped.applied?.stage;
  const pinStage = grouped.pin?.stage;
  return (
    (appliedStage !== undefined && appliedStage !== "" ? appliedStage : undefined) ??
    ctx.catalogStageByRel.get(rel) ??
    (pinStage !== undefined && pinStage !== "" ? pinStage : undefined)
  );
}

function computeEffective(
  declared: Stage | undefined,
  pin: QualificationOverride | undefined,
): EffectiveStage | null {
  if (declared === undefined) return null;
  const pinStage = pin !== undefined && pin.stage !== "" ? pin.stage : undefined;
  return qualificationStages.effectiveStage({
    declared,
    ...(pinStage === undefined ? {} : { pin: { stage: pinStage } }),
  });
}

function statusFor(ctx: QualContext, rel: string): StatusView {
  const catalogStage = ctx.catalogStageByRel.get(rel) ?? null;
  const grouped = qualificationOverrides.overridesFor(ctx.overrideRows, rel);
  return {
    rel,
    catalogStage,
    pin: grouped.pin === undefined ? null : overrideView(grouped.pin),
    freeze: grouped.freeze === undefined ? null : overrideView(grouped.freeze),
    effective: computeEffective(declaredFor(ctx, rel, grouped), grouped.pin),
    routingStage: ctx.routingStages.get(rel) ?? null,
    applied: grouped.applied === undefined ? null : overrideView(grouped.applied),
  };
}

function listCommand(rest: string[]): number {
  const { json } = parseArgs(rest);
  const ctx = buildContext();
  const rels = new Set<string>(ctx.catalogStageByRel.keys());
  for (const row of ctx.overrideRows) rels.add(row.rel);
  const statuses = [...rels].sort().map((rel) => statusFor(ctx, rel));
  if (json) {
    process.stdout.write(`${JSON.stringify(statuses)}\n`);
    return 0;
  }
  for (const status of statuses) {
    const pin = status.pin?.stage ?? "-";
    const frozen = status.freeze === null ? "-" : "frozen";
    const effective = status.effective?.stage ?? "unstaged";
    process.stdout.write(
      `${status.rel}\t${status.catalogStage ?? "-"}\t${pin}\t${frozen}\t${effective}\n`,
    );
  }
  return 0;
}

function statusCommand(rest: string[]): number {
  const { positional, json } = parseArgs(rest);
  const rel = positional[0];
  if (rel === undefined) {
    process.stderr.write(`qualification status: <rel> is required\n\n${USAGE}`);
    return 1;
  }
  const status = statusFor(buildContext(), rel);
  if (json) {
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return 0;
  }
  const pin =
    status.pin === null ? "-" : `${status.pin.stage} (${status.pin.author}): ${status.pin.reason}`;
  const freeze = status.freeze === null ? "-" : `${status.freeze.author}: ${status.freeze.reason}`;
  const applied =
    status.applied === null
      ? "-"
      : `${status.applied.stage} (${status.applied.author}): ${status.applied.reason}`;
  process.stdout.write(`${rel}\t${status.effective?.stage ?? "unstaged"}\n`);
  process.stdout.write(`catalog\t${status.catalogStage ?? "-"}\n`);
  process.stdout.write(`pin\t${pin}\n`);
  process.stdout.write(`freeze\t${freeze}\n`);
  process.stdout.write(`applied\t${applied}\n`);
  return 0;
}

type BuildResult = { row: NewOverride } | { error: string };

function buildOverrideRow(
  action: QualificationOverride["action"],
  rel: string,
  positional: string[],
  flags: Map<string, string>,
): BuildResult {
  let stage: Stage | "" = "";
  if (action === "pin") {
    const declared = positional[1];
    if (declared === undefined) return { error: "<stage> is required" };
    const validated = asStage(declared);
    if (validated === undefined) {
      return {
        error: `unknown stage '${declared}' (expected ${schemas.QUALIFICATION_STAGES.join(" | ")})`,
      };
    }
    stage = validated;
  }
  const reason = flags.get("--reason");
  if (reason === undefined || reason === "") return { error: "--reason is required" };
  const author = flags.get("--author") ?? defaultAuthor();
  return { row: { rel, action, stage, author, reason } };
}

function mutationCommand(action: QualificationOverride["action"], rest: string[]): number {
  const { positional, flags } = parseArgs(rest);
  const rel = positional[0];
  if (rel === undefined) {
    process.stderr.write(`qualification ${action}: <rel> is required\n\n${USAGE}`);
    return 1;
  }
  const built = buildOverrideRow(action, rel, positional, flags);
  if ("error" in built) {
    process.stderr.write(`qualification ${action}: ${built.error}\n`);
    return 1;
  }
  const ctx = buildContext();
  try {
    qualificationOverrides.writeQualificationOverride(ctx.file, built.row);
  } catch (err) {
    const messages = zodIssueMessages(err);
    if (messages === null) throw err;
    process.stderr.write(`qualification ${action}: ${messages.join("; ")}\n`);
    return 1;
  }
  const line = action === "pin" ? `pinned ${rel} at ${built.row.stage}` : `froze ${rel}`;
  process.stdout.write(`${line}\noverrides: ${ctx.file}\n`);
  return 0;
}

function removalCommand(verb: "unpin" | "unfreeze" | "unapply", rest: string[]): number {
  const { positional } = parseArgs(rest);
  const rel = positional[0];
  if (rel === undefined) {
    process.stderr.write(`qualification ${verb}: <rel> is required\n\n${USAGE}`);
    return 1;
  }
  const action: QualificationOverride["action"] =
    verb === "unpin" ? "pin" : verb === "unfreeze" ? "freeze" : "applied";
  const ctx = buildContext();
  if (!qualificationOverrides.deleteQualificationOverride(ctx.file, rel, action)) {
    const missing =
      verb === "unapply" ? `no applied stage for '${rel}'` : `no ${action} override for '${rel}'`;
    process.stderr.write(`qualification ${verb}: ${missing}\n`);
    return 1;
  }
  const line =
    verb === "unpin"
      ? `unpinned ${rel}`
      : verb === "unfreeze"
        ? `unfroze ${rel}`
        : `unapplied ${rel}`;
  process.stdout.write(`${line}\noverrides: ${ctx.file}\n`);
  return 0;
}

type ReadResult = { ok: true; json: unknown } | { ok: false; message: string };

function readJsonFile(label: "evidence" | "policy", path: string): ReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, message: `cannot read ${label} file '${path}'` };
  }
  try {
    return { ok: true, json: JSON.parse(raw) };
  } catch {
    return { ok: false, message: `invalid JSON in ${label} file '${path}'` };
  }
}

function decisionLine(rel: string, decision: QualificationDecision): string {
  switch (decision.kind) {
    case "proposal":
      return `proposal ${rel} ${decision.proposal.from} -> ${decision.proposal.to}`;
    case "demotion":
      return `demotion ${rel} ${decision.proposal.from} -> ${decision.proposal.to} (breached: ${decision.proposal.breached.join(", ")})`;
    case "none": {
      const base = `none ${rel}: ${decision.reason}`;
      if (decision.reason === "below-threshold") {
        return `${base} (failed: ${decision.failed.join(", ")})`;
      }
      return base;
    }
  }
}

type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Read and validate one propose input file. Every failure — unreadable,
 * malformed JSON or a schema refusal — comes back as a clean message, so
 * a bad input never escapes as a stack trace.
 */
function parseProposeFile<T>(
  label: "evidence" | "policy",
  path: string,
  parse: (json: unknown) => T,
): Outcome<T> {
  const read = readJsonFile(label, path);
  if (!read.ok) return read;
  try {
    return { ok: true, value: parse(read.json) };
  } catch (err) {
    const messages = zodIssueMessagesWithPath(err);
    if (messages === null) throw err;
    return { ok: false, message: `invalid ${label} file '${path}': ${messages.join("; ")}` };
  }
}

interface ProposeResult {
  decision: QualificationDecision;
  apply: qualificationDemotion.ApplyQualificationResult;
}

/**
 * Evaluate and gate the decision. With a writer injected, the policy's
 * autoApply lets it record the applied stage; without one the result
 * stays `proposed`. applyQualification re-parses the policy, so its Zod
 * refusal is reported like any other input error.
 */
function evaluateProposal(
  input: qualificationPromotion.ProposePromotionInput & {
    policy: qualificationPromotion.PromotionPolicy;
  },
  writer?: (proposal: AnyProposal) => void,
): Outcome<ProposeResult> {
  try {
    const decision = qualificationDemotion.evaluateQualification(input);
    const apply = qualificationDemotion.applyQualification(decision, {
      policy: input.policy,
      ...(writer === undefined ? {} : { apply: writer }),
    });
    return { ok: true, value: { decision, apply } };
  } catch (err) {
    const messages = zodIssueMessagesWithPath(err);
    if (messages === null) throw err;
    return { ok: false, message: `invalid policy: ${messages.join("; ")}` };
  }
}

function requiredFlag(
  verb: ProposalVerb,
  flags: Map<string, string>,
  name: string,
): string | undefined {
  const value = flags.get(name);
  if (value === undefined || value === "") {
    process.stderr.write(`qualification ${verb}: ${name} is required\n`);
    return undefined;
  }
  return value;
}

type ProposalVerb = "propose" | "apply";

interface ApplyOutcome {
  decision: QualificationDecision;
  apply: ApplyQualificationResult;
  recordFailure: string[] | undefined;
}

/**
 * Detail for a non-Zod error escaping the writer: an IO failure on the
 * overrides path (ENOTDIR under a regular file, an unwritable dir), not
 * a validation refusal.
 */
function writeFailureDetail(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "unknown write failure";
}

/**
 * Run the evidence/policy evaluation for one verb. `apply` injects
 * `writeAppliedStage`, whose Zod refusal is recorded here rather than
 * escaping as (or being mistaken for) a policy error: the writer
 * validates before any IO, so a recorded failure means nothing was
 * written (#518). The rethrown non-Zod write errors are handled here
 * too: they become a clean `cannot record applied stage` message
 * instead of a stack trace, so an IO failure never reads as a
 * successful apply (#518 review).
 */
function runEvaluation(
  verb: ProposalVerb,
  input: qualificationPromotion.ProposePromotionInput & {
    policy: qualificationPromotion.PromotionPolicy;
  },
  file: string,
  author: string,
): Outcome<ApplyOutcome> {
  let recordFailure: string[] | undefined;
  const writer =
    verb === "apply"
      ? (proposal: AnyProposal): void => {
          try {
            qualificationOverrides.writeAppliedStage(file, proposal, author);
          } catch (err) {
            const messages = zodIssueMessages(err);
            if (messages === null) throw err;
            recordFailure = messages;
          }
        }
      : undefined;
  let result: Outcome<ProposeResult>;
  try {
    result = evaluateProposal(input, writer);
  } catch (err) {
    return { ok: false, message: `cannot record applied stage: ${writeFailureDetail(err)}` };
  }
  if (!result.ok) return result;
  return { ok: true, value: { ...result.value, recordFailure } };
}

function applyResultLine(
  verb: ProposalVerb,
  rel: string,
  decision: QualificationDecision,
  apply: ApplyQualificationResult,
  file: string,
): void {
  if (verb === "propose") {
    process.stdout.write(
      `apply: ${apply.status} (nothing written; autoApply has no writer here)\n`,
    );
    return;
  }
  if (apply.status === "applied" && decision.kind !== "none") {
    process.stdout.write(
      `apply: applied ${rel} ${decision.proposal.from} -> ${decision.proposal.to}\noverrides: ${file}\n`,
    );
    return;
  }
  if (apply.status === "proposed") {
    process.stdout.write("apply: proposed (nothing written; policy autoApply is off)\n");
    return;
  }
  process.stdout.write("apply: skipped (nothing written)\n");
}

/**
 * Shared runner behind `propose` (read-only) and `apply` (writes the
 * applied row through `writeAppliedStage` when the policy's autoApply
 * is on). Every error prefix is `qualification <verb>:`.
 */
function proposalCommand(verb: ProposalVerb, rest: string[]): number {
  const { positional, flags, json } = parseArgs(rest);
  const rel = positional[0];
  if (rel === undefined) {
    process.stderr.write(`qualification ${verb}: <rel> is required\n\n${USAGE}`);
    return 1;
  }
  const evidencePath = requiredFlag(verb, flags, "--evidence");
  if (evidencePath === undefined) return 1;
  const policyPath = requiredFlag(verb, flags, "--policy");
  if (policyPath === undefined) return 1;

  const evidence = parseProposeFile("evidence", evidencePath, (raw) =>
    qualificationPromotion.parsePromotionEvidence(raw),
  );
  if (!evidence.ok) {
    process.stderr.write(`qualification ${verb}: ${evidence.message}\n`);
    return 1;
  }
  const policy = parseProposeFile("policy", policyPath, (raw) =>
    qualificationPromotion.PromotionPolicySchema.parse(raw),
  );
  if (!policy.ok) {
    process.stderr.write(`qualification ${verb}: ${policy.message}\n`);
    return 1;
  }

  const ctx = buildContext();
  const grouped = qualificationOverrides.overridesFor(ctx.overrideRows, rel);
  const declared = declaredFor(ctx, rel, grouped);
  if (declared === undefined) {
    process.stderr.write(`qualification ${verb}: '${rel}' has no qualification stage\n`);
    return 1;
  }

  const author = flags.get("--author") ?? defaultAuthor();
  const result = runEvaluation(
    verb,
    { rel, declared, evidence: evidence.value, policy: policy.value, overrides: grouped },
    ctx.file,
    author,
  );
  if (!result.ok) {
    process.stderr.write(`qualification ${verb}: ${result.message}\n`);
    return 1;
  }
  const { decision, apply, recordFailure } = result.value;
  if (recordFailure !== undefined) {
    process.stderr.write(
      `qualification ${verb}: cannot record applied stage: ${recordFailure.join("; ")}\n`,
    );
    return 1;
  }

  if (json) {
    const view = { rel, declared, overridesFile: ctx.file, decision, apply };
    process.stdout.write(`${JSON.stringify(view)}\n`);
    return 0;
  }
  process.stdout.write(`${decisionLine(rel, decision)}\n`);
  applyResultLine(verb, rel, decision, apply, ctx.file);
  return 0;
}

function dispatchQualification(argv: string[]): number {
  if (!isLocalDispatch()) {
    const node = resolveEffectiveNodeName();
    process.stderr.write(
      `qualification: overrides are node-local; run this command on the target node (selected node '${node}' is not local)\n`,
    );
    return 1;
  }
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "list":
      return listCommand(rest);
    case "status":
      return statusCommand(rest);
    case "pin":
      return mutationCommand("pin", rest);
    case "freeze":
      return mutationCommand("freeze", rest);
    case "unpin":
      return removalCommand("unpin", rest);
    case "unfreeze":
      return removalCommand("unfreeze", rest);
    case "propose":
      return proposalCommand("propose", rest);
    case "apply":
      return proposalCommand("apply", rest);
    case "unapply":
      return removalCommand("unapply", rest);
    case undefined:
    case "help":
    case "--help":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown qualification subcommand: ${subcommand}\n\n${USAGE}`);
      return 1;
  }
}

export function runQualification(argv: string[]): Promise<number> {
  return Promise.resolve(dispatchQualification(argv));
}
