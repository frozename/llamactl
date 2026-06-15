/**
 * Project-scoped routing resolution. Takes an incoming chat node
 * name shaped `project:<name>/<taskKind>` and rewrites it to the
 * real node name the operator declared for that task kind in the
 * project manifest. Every resolution writes a decision entry to a
 * JSONL journal so the UI's "where did my AI go" feed has a source
 * of truth.
 *
 * v1 scope:
 *   - Parse the project-node-name grammar.
 *   - Walk the project's `spec.routing[taskKind]` with
 *     `private-first` fallback.
 *   - Budget check is PLUGGABLE but the default is a no-op
 *     "within-budget" answer. Wiring daily USD spend against
 *     cost-guardian's snapshot is a follow-up that needs the
 *     nova.ops.cost.snapshot MCP roundtrip (or, once shipped,
 *     the per-project UsageRecord attribution this module's
 *     decisions start populating today).
 *   - Unknown project / malformed name → a fallback decision
 *     that points at `private-first` so a stale operator URL
 *     still yields a safe local route rather than an error.
 *
 * Decision journal:
 *   $LLAMACTL_PROJECT_ROUTING_JOURNAL || ~/.llamactl/project-routing.jsonl
 * JSONL, append-only, small-volume (one line per chat request).
 */

import { estimateCostUsd, loadPricing, readUsage } from "@nova/mcp-shared";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { llamactlHome, nonEmpty } from "./env.js";
import {
  defaultProjectsPath,
  loadProjects,
  type Project,
  resolveProjectRouting,
} from "./projects.js";

export interface ProjectRoutingDecision {
  ts: string;
  project: string;
  taskKind: string;
  /** The rewritten node name the dispatch continues against. */
  target: string;
  /** True when `spec.routing[taskKind]` matched; false when the
   *  default was used. Distinct from reason so callers can tell
   *  "operator intentionally picked this target" apart from
   *  "we fell back because the project didn't declare it". */
  matched: boolean;
  reason: "matched" | "fallback-default" | "project-not-found" | "over-budget";
  /** Populated when reason === 'over-budget'. */
  budget?: {
    usdToday?: number;
    limit?: number;
  };
}

export interface ProjectRouteEnvelope {
  /** The rewritten node name to hand to resolveNode. When the
   *  incoming node wasn't a project-scoped one, this is
   *  unchanged. */
  node: string;
  /** Non-null only when the incoming node WAS a project-scoped
   *  one (shape `project:<name>/<taskKind>`). The caller writes
   *  it to the decision journal + enriches UsageRecord.route. */
  decision: ProjectRoutingDecision | null;
}

export interface BudgetSnapshot {
  usdToday: number;
  usdLimit: number;
}

export interface ResolveProjectNodeTargetOptions {
  /** Test seam — swap in a fixture project list without touching
   *  disk. */
  loadProjects?: () => Project[] | readonly Project[];
  /**
   * Budget check. When the project has a `spec.budget.usd_per_day`
   * limit, the resolver calls this with `{project, limit}` and
   * expects back a snapshot of today's attributed spend. Return
   * null to indicate "no USD tracking available today" (default
   * behavior — structurally ready but non-enforcing in v1).
   */
  checkBudget?: (args: { project: Project; limit: number }) => Promise<BudgetSnapshot | null>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export function parseProjectNodeName(name: string): { project: string; taskKind: string } | null {
  if (!name.startsWith("project:")) return null;
  const rest = name.slice("project:".length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  const project = rest.slice(0, slash);
  const taskKind = rest.slice(slash + 1);
  return { project, taskKind };
}

/**
 * Resolve a chat node name through the project routing policy.
 * Non-project names pass through untouched + `decision: null`.
 * Project-scoped names always return a decision record so the
 * caller can journal it + attribute usage.
 */
export async function resolveProjectNodeTarget(
  nodeName: string,
  opts: ResolveProjectNodeTargetOptions = {},
): Promise<ProjectRouteEnvelope> {
  const parsed = parseProjectNodeName(nodeName);
  if (!parsed) return { node: nodeName, decision: null };

  const now = opts.now ?? Date.now;
  const ts = new Date(now()).toISOString();
  const projects = opts.loadProjects
    ? opts.loadProjects()
    : loadProjects(defaultProjectsPath(opts.env));
  const project = projects.find((p) => p.metadata.name === parsed.project);

  if (!project) {
    return {
      // Stale / unknown project — fall back to private-first rather
      // than erroring. The decision journal + UI surface the bad
      // name so the operator notices.
      node: "private-first",
      decision: {
        ts,
        project: parsed.project,
        taskKind: parsed.taskKind,
        target: "private-first",
        matched: false,
        reason: "project-not-found",
      },
    };
  }

  const { target, matched } = resolveProjectRouting(project, parsed.taskKind);

  // Budget check. When the operator declared a USD ceiling, ask the
  // provided snapshotter for today's attributed spend. v1 ships
  // with no default snapshotter — cost-guardian integration is the
  // follow-up slice. Tests + future cost wiring inject via
  // `opts.checkBudget`.
  const limit = project.spec.budget?.usd_per_day;
  if (limit !== undefined && limit > 0 && opts.checkBudget) {
    try {
      const snap = await opts.checkBudget({ project, limit });
      if (snap && snap.usdToday >= snap.usdLimit) {
        return {
          node: "private-first",
          decision: {
            ts,
            project: parsed.project,
            taskKind: parsed.taskKind,
            target: "private-first",
            matched,
            reason: "over-budget",
            budget: { usdToday: snap.usdToday, limit: snap.usdLimit },
          },
        };
      }
    } catch {
      // Swallow — a broken snapshotter must never kill an in-flight
      // chat request. The decision just records the declared target
      // without budget annotation.
    }
  }

  return {
    node: target,
    decision: {
      ts,
      project: parsed.project,
      taskKind: parsed.taskKind,
      target,
      matched,
      reason: matched ? "matched" : "fallback-default",
    },
  };
}

export function defaultProjectRoutingJournalPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = nonEmpty(env.LLAMACTL_PROJECT_ROUTING_JOURNAL);
  if (override) return override;
  const base = llamactlHome(env);
  return join(base, "project-routing.jsonl");
}

/**
 * Append a decision to the JSONL routing journal. Non-throwing:
 * journal failures surface on stderr but never break the dispatch
 * path — routing decisions are observability, not correctness.
 */
export async function appendProjectRoutingJournal(
  decision: ProjectRoutingDecision,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const path = defaultProjectRoutingJournalPath(env);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(decision)}\n`, "utf8");
  } catch (err) {
    process.stderr.write(
      `project-routing: journal append failed (${(err as Error).message}) — continuing\n`,
    );
  }
}

/**
 * Pack a project decision into a `UsageRecord.route` string so
 * usage sinks downstream see which project + task-kind drove the
 * call. Grammar (documented for ecosystem consumers):
 *
 *   `project:<name>/<taskKind>/<target>`
 *
 * Where `<target>` is the concrete rewritten node. Consumers split
 * on `/` after `project:`; the `target` segment retains slashes
 * only when the node name itself has a slash (it doesn't today).
 */
export function packRouteForUsage(decision: ProjectRoutingDecision): string {
  return `project:${decision.project}/${decision.taskKind}/${decision.target}`;
}

export interface ProjectBudgetCheckerOptions {
  now?: () => number;
  /** Override the usage corpus dir (defaults to the nova usage dir). */
  usageDir?: string;
  /** Override the pricing catalog dir (defaults to the nova pricing dir). */
  pricingDir?: string;
}

/**
 * USD cost of a single usage record: its own `estimated_cost_usd` when
 * present, else the token counts priced via the catalog. Returns `null`
 * when token counts are usable but the catalog has no row for the
 * (provider, model) — the rollup treats that as $0 but warns once so an
 * operator notices spend is silently being under-counted.
 */
function usageRecordCostUsd(
  rec: Record<string, unknown>,
  catalog: ReturnType<typeof loadPricing>["catalog"],
): { cost: number; underCounted: boolean; provider?: string; model?: string } {
  if (typeof rec.estimated_cost_usd === "number") {
    return { cost: rec.estimated_cost_usd, underCounted: false };
  }
  const { provider, model, prompt_tokens: prompt, completion_tokens: completion } = rec;
  if (
    typeof provider !== "string" ||
    typeof model !== "string" ||
    typeof prompt !== "number" ||
    typeof completion !== "number"
  ) {
    return { cost: 0, underCounted: false };
  }
  const estimated = estimateCostUsd(
    { provider, model, kind: "chat", prompt_tokens: prompt, completion_tokens: completion },
    catalog,
  );
  if (estimated === undefined) {
    return { cost: 0, underCounted: true, provider, model };
  }
  return { cost: estimated, underCounted: false };
}

/** Projects already warned this process about an unpriceable budget, so
 *  the "can't enforce" notice fires once per project rather than per call. */
const budgetPricingWarned = new Set<string>();

/** (project, provider/model) pairs already warned about silent under-counts,
 *  so the per-record notice fires once per unpriced upstream rather than
 *  per call. */
const budgetUnderCountWarned = new Set<string>();

/**
 * Build the `checkBudget` snapshotter `resolveProjectNodeTarget` calls
 * when a project declares `budget.usd_per_day`. It attributes today's USD
 * spend to the project from the usage corpus the dispatch path now writes:
 * read every record since the start of the current UTC day, keep the ones
 * whose `route` was packed by `packRouteForUsage` for this project, and sum
 * their cost. Synchronous I/O wrapped in a resolved Promise to satisfy the
 * async snapshotter contract.
 *
 * Enforcement needs pricing: the dispatch writers record token counts, not
 * USD, so spend is priced from the catalog. With NO pricing catalog every
 * record prices to $0 and a budget would never trigger — so the first time
 * a budgeted project is evaluated against an empty catalog we warn, turning
 * silent non-enforcement into an operator-visible "seed pricing" signal.
 *
 * Cost note (first slice): the rollup re-reads + re-parses today's usage
 * file and reloads the pricing catalog on every budgeted request, so per-
 * request work grows with the day's request count. Fine at the modest
 * volumes a per-project daily cap implies; an in-memory running-spend
 * accumulator is the fast-follow if a hot budgeted project needs it.
 */
export function makeProjectBudgetChecker(
  opts: ProjectBudgetCheckerOptions = {},
): (args: { project: Project; limit: number }) => Promise<BudgetSnapshot | null> {
  const now = opts.now ?? Date.now;
  return ({ project, limit }) => {
    const dayStart = new Date(now());
    dayStart.setUTCHours(0, 0, 0, 0);
    const { records } = readUsage({
      since: dayStart.toISOString(),
      ...(opts.usageDir ? { dir: opts.usageDir } : {}),
    });
    const { catalog } = loadPricing(opts.pricingDir ? { dir: opts.pricingDir } : {});
    if (catalog.size === 0 && !budgetPricingWarned.has(project.metadata.name)) {
      budgetPricingWarned.add(project.metadata.name);
      process.stderr.write(
        `project-budget: pricing catalog is empty — usd_per_day for project ` +
          `'${project.metadata.name}' cannot be enforced until pricing is seeded\n`,
      );
    }
    const prefix = `project:${project.metadata.name}/`;
    let usdToday = 0;
    for (const rec of records) {
      if (typeof rec.route !== "string" || !rec.route.startsWith(prefix)) continue;
      const priced = usageRecordCostUsd(rec, catalog);
      if (priced.underCounted) {
        const key = `${project.metadata.name}:${priced.provider ?? ""}/${priced.model ?? ""}`;
        if (!budgetUnderCountWarned.has(key)) {
          budgetUnderCountWarned.add(key);
          process.stderr.write(
            `project-budget: pricing catalog has no entry for ` +
              `'${priced.provider ?? ""}/${priced.model ?? ""}' — spend for project ` +
              `'${project.metadata.name}' is being under-counted until that model's pricing is seeded\n`,
          );
        }
      }
      usdToday += priced.cost;
    }
    return Promise.resolve({ usdToday, usdLimit: limit });
  };
}
