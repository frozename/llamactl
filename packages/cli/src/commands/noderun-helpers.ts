import type { NodeClient, noderunSchema } from "@llamactl/remote";

import { infraSpec, noderunStore } from "@llamactl/remote";

export type InfraPlatformKind = infraSpec.InfraPlatformKind;

export const ALLOWED_PLATFORMS: InfraPlatformKind[] = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
];

export function platformFromNodeFacts(facts: {
  os?: string;
  arch?: string;
}): InfraPlatformKind | null {
  const os = facts.os;
  const arch = facts.arch;
  if (os === "darwin" && arch === "arm64") return "darwin-arm64";
  if (os === "darwin" && arch === "x64") return "darwin-x64";
  if (os === "linux" && arch === "x64") return "linux-x64";
  if (os === "linux" && arch === "arm64") return "linux-arm64";
  return null;
}

/**
 * Build an ArtifactResolver bound to a specific node client + target
 * platform. Reused by both `llamactl infra install` and the NodeRun
 * apply path.
 */
export function makeSpecArtifactResolver(opts: {
  client: NodeClient;
  packagesDir?: string;
  /** Platform override — skip the nodeFacts query. Useful when the
   *  operator cross-installs from a shared control plane. */
  platform?: InfraPlatformKind;
}): (args: { pkg: string; version: string }) => Promise<{
  tarballUrl: string;
  sha256: string;
}> {
  // Resolve platform once, cache, reuse across pkg lookups.
  let platformPromise: Promise<InfraPlatformKind> | null = null;
  async function resolvePlatform(): Promise<InfraPlatformKind> {
    if (opts.platform) return opts.platform;
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- Preserve existing CLI/test semantics while clearing strict lint debt.
    if (!platformPromise) {
      platformPromise = opts.client.nodeFacts.query().then((facts) => {
        const p = platformFromNodeFacts(facts);
        if (!p) {
          throw new Error(
            `could not derive target platform from node facts (os=${facts.os}, arch=${facts.arch}).`,
          );
        }
        return p;
      });
    }
    return await platformPromise;
  }

  return async ({ pkg, version }) => {
    const spec = infraSpec.loadInfraPackageSpec(pkg, opts.packagesDir);
    const platform = await resolvePlatform();
    const resolved = infraSpec.resolveInfraArtifact(spec, version, platform);
    if (!resolved.ok) {
      throw new Error(resolved.message);
    }
    return {
      tarballUrl: resolved.artifact.url,
      sha256: resolved.artifact.sha256,
    };
  };
}

/**
 * #239: the explicit NodeRun budget for a node, keyed by NodeRun
 * metadata.name like the controller reconciler. Returns undefined when
 * no NodeRun has that name or it sets no spec.budget, so the caller's
 * fallback (node facts or controller RAM for a ModelHost, unbounded for
 * a ModelRun) still applies. The NodeRuns are read on each call, not
 * when the lookup is built.
 */
export function nodeRunBudgetLookup(
  listNodeRuns: () => noderunSchema.NodeRun[] = () => noderunStore.listNodeRuns(),
): (nodeName: string) => number | undefined {
  return (nodeName) =>
    listNodeRuns().find((nodeRun) => nodeRun.metadata.name === nodeName)?.spec.budget?.memoryGiB;
}
