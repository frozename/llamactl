import type { InstalledInfra } from '../infra/layout.js';
import type { InstallResult } from '../infra/install.js';
import type { NodeRun, NodeRunInfraItem, NodeRunStatus } from './noderun-schema.js';

/**
 * Diff + converge a NodeRun manifest against the live infra state
 * on its target node. The network / tRPC wiring is injectable so
 * this module stays unit-testable; the CLI + reconciler supply a
 * real node-scoped client, tests hand in a mock.
 *
 * Diff semantics:
 *   * desired entry missing from live          → install + activate
 *   * desired entry present but active != ver  → install(new) + activate(new)
 *   * desired entry matches live.active        → skip
 *   * live pkg not in desired                  → uninstall (mode: 'package')
 *
 * Multi-version-retain is out of scope for v1 — the reconciler
 * narrows to exactly one active version per pkg, pruning everything
 * else via `infraUninstall({pkg, version: old})`. Side-by-side
 * coexistence for rollback is a follow-up flag on NodeRunInfraItem.
 */

export interface NodeRunInfraClient {
  infraList: {
    query(): Promise<InstalledInfra[]>;
  };
  infraInstall: {
    mutate(input: {
      pkg: string;
      version: string;
      tarballUrl: string;
      sha256: string;
      activate?: boolean;
      skipIfPresent?: boolean;
    }): Promise<InstallResult>;
  };
  infraActivate: {
    mutate(input: { pkg: string; version: string }): Promise<{ ok: true }>;
  };
  infraUninstall: {
    mutate(input: { pkg: string; version?: string }): Promise<{
      ok: true;
      mode: 'package' | 'version';
      removed: boolean;
    }>;
  };
}

export type ArtifactResolver = (opts: {
  pkg: string;
  version: string;
}) => Promise<{ tarballUrl: string; sha256: string }>;

export type NodeRunAction =
  | { type: 'install'; pkg: string; version: string; reason: 'missing' | 'version-mismatch' }
  | { type: 'activate'; pkg: string; version: string }
  | { type: 'uninstall-pkg'; pkg: string; reason: 'unwanted' }
  | { type: 'uninstall-version'; pkg: string; version: string; reason: 'superseded' }
  | { type: 'skip'; pkg: string; version: string; reason: 'already-current' };

export interface NodeRunActionOutcome {
  action: NodeRunAction;
  ok: boolean;
  detail?: unknown;
  error?: string;
}

export interface NodeRunApplyResult {
  actions: NodeRunAction[];
  outcomes: NodeRunActionOutcome[];
  status: NodeRunStatus;
  error?: string;
}

/**
 * Pure diff — what actions would close the gap between desired and
 * observed? No network. Useful for `apply --dry-run` and the
 * reconciler's "drift" report.
 */
export function planNodeRun(
  spec: NodeRun['spec'],
  live: InstalledInfra[],
): NodeRunAction[] {
  const actions: NodeRunAction[] = [];
  const desiredByPkg = new Map<string, NodeRunInfraItem>();
  for (const item of spec.infra) desiredByPkg.set(item.pkg, item);

  for (const item of spec.infra) {
    const observed = live.find((r) => r.pkg === item.pkg);
    if (!observed) {
      actions.push({
        type: 'install',
        pkg: item.pkg,
        version: item.version,
        reason: 'missing',
      });
      continue;
    }
    if (observed.active === item.version) {
      actions.push({
        type: 'skip',
        pkg: item.pkg,
        version: item.version,
        reason: 'already-current',
      });
    } else if (observed.versions.includes(item.version)) {
      // Version is installed but not active — flip the symlink.
      actions.push({
        type: 'activate',
        pkg: item.pkg,
        version: item.version,
      });
    } else {
      actions.push({
        type: 'install',
        pkg: item.pkg,
        version: item.version,
        reason: 'version-mismatch',
      });
    }
    // Prune superseded versions on the same pkg. v1 keeps only the
    // desired active version; side-by-side retention is a future
    // `keepVersions: []` flag.
    for (const v of observed.versions) {
      if (v !== item.version) {
        actions.push({
          type: 'uninstall-version',
          pkg: item.pkg,
          version: v,
          reason: 'superseded',
        });
      }
    }
  }

  // Any live pkg that isn't in the desired set → uninstall entirely.
  for (const row of live) {
    if (!desiredByPkg.has(row.pkg)) {
      actions.push({
        type: 'uninstall-pkg',
        pkg: row.pkg,
        reason: 'unwanted',
      });
    }
  }

  return actions;
}

interface ApplyInfraChangesOptions {
  client: NodeRunInfraClient;
  resolveArtifact: ArtifactResolver;
  /** When true, compute actions + return them without mutating. */
  dryRun?: boolean;
}

/**
 * Execute a NodeRun against a live agent. Loads current infra, plans
 * the diff, runs each action via the injected client. Each outcome
 * is captured so a failed step doesn't hide what did (or would
 * have) succeeded.
 */
export async function applyNodeRun(
  manifest: NodeRun,
  opts: ApplyInfraChangesOptions,
): Promise<NodeRunApplyResult> {
  const { client, resolveArtifact } = opts;
  const dryRun = opts.dryRun ?? false;

  const live = await client.infraList.query();
  const actions = planNodeRun(manifest.spec, live);
  const outcomes: NodeRunActionOutcome[] = [];
  const now = () => new Date().toISOString();

  if (dryRun) {
    return {
      actions,
      outcomes: actions.map((action) => ({ action, ok: true })),
      status: {
        phase: actions.every((a) => a.type === 'skip') ? 'Converged' : 'Drift',
        observedInfra: observedSummary(manifest, live),
        lastTransitionTime: now(),
        conditions: [
          {
            type: 'Planned',
            status: 'True',
            reason: 'dry-run',
            lastTransitionTime: now(),
          },
        ],
      },
    };
  }

  let firstError: string | undefined;

  for (const action of actions) {
    try {
      if (action.type === 'skip') {
        outcomes.push({ action, ok: true });
        continue;
      }
      if (action.type === 'install') {
        const artifact = await resolveArtifact({
          pkg: action.pkg,
          version: action.version,
        });
        const result = await client.infraInstall.mutate({
          pkg: action.pkg,
          version: action.version,
          tarballUrl: artifact.tarballUrl,
          sha256: artifact.sha256,
          activate: true,
          skipIfPresent: true,
        });
        outcomes.push({
          action,
          ok: result.ok,
          detail: result,
          ...(result.ok ? {} : { error: result.error }),
        });
        if (!result.ok && !firstError) firstError = result.error;
        continue;
      }
      if (action.type === 'activate') {
        const result = await client.infraActivate.mutate({
          pkg: action.pkg,
          version: action.version,
        });
        outcomes.push({ action, ok: result.ok, detail: result });
        continue;
      }
      if (action.type === 'uninstall-version') {
        const result = await client.infraUninstall.mutate({
          pkg: action.pkg,
          version: action.version,
        });
        outcomes.push({ action, ok: result.ok, detail: result });
        continue;
      }
      if (action.type === 'uninstall-pkg') {
        const result = await client.infraUninstall.mutate({ pkg: action.pkg });
        outcomes.push({ action, ok: result.ok, detail: result });
        continue;
      }
    } catch (err) {
      const message = (err as Error).message;
      outcomes.push({ action, ok: false, error: message });
      if (!firstError) firstError = message;
    }
  }

  // Re-fetch to record the post-apply state.
  const postLive = await client.infraList.query();
  const anyFailure = outcomes.some((o) => !o.ok);
  const phase: NodeRunStatus['phase'] = anyFailure
    ? 'Failed'
    : actions.every((a) => a.type === 'skip')
      ? 'Converged'
      : 'Converged';

  return {
    actions,
    outcomes,
    status: {
      phase,
      observedInfra: observedSummary(manifest, postLive),
      lastTransitionTime: now(),
      conditions: [
        {
          type: 'Applied',
          status: anyFailure ? 'False' : 'True',
          reason: anyFailure ? 'partial-failure' : 'converged',
          ...(firstError ? { message: firstError } : {}),
          lastTransitionTime: now(),
        },
      ],
    },
    ...(firstError ? { error: firstError } : {}),
  };
}

function observedSummary(
  manifest: NodeRun,
  live: InstalledInfra[],
): NodeRunStatus['observedInfra'] {
  const out: NodeRunStatus['observedInfra'] = [];
  const desired = new Set(manifest.spec.infra.map((i) => i.pkg));
  for (const row of live) {
    out.push({
      pkg: row.pkg,
      version: row.active ?? '',
      active: row.active !== null && desired.has(row.pkg),
    });
  }
  return out;
}
