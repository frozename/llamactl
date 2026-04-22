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

import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  defaultProjectsPath,
  loadProjects,
  resolveProjectRouting,
  type Project,
} from './projects.js';

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
  reason:
    | 'matched'
    | 'fallback-default'
    | 'project-not-found'
    | 'over-budget';
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
  checkBudget?: (args: {
    project: Project;
    limit: number;
  }) => Promise<BudgetSnapshot | null>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export function parseProjectNodeName(
  name: string,
): { project: string; taskKind: string } | null {
  if (!name.startsWith('project:')) return null;
  const rest = name.slice('project:'.length);
  const slash = rest.indexOf('/');
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
      node: 'private-first',
      decision: {
        ts,
        project: parsed.project,
        taskKind: parsed.taskKind,
        target: 'private-first',
        matched: false,
        reason: 'project-not-found',
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
          node: 'private-first',
          decision: {
            ts,
            project: parsed.project,
            taskKind: parsed.taskKind,
            target: 'private-first',
            matched,
            reason: 'over-budget',
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
      reason: matched ? 'matched' : 'fallback-default',
    },
  };
}

export function defaultProjectRoutingJournalPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.LLAMACTL_PROJECT_ROUTING_JOURNAL?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'project-routing.jsonl');
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
    await appendFile(path, `${JSON.stringify(decision)}\n`, 'utf8');
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
