/**
 * Canonical safety-tier vocabulary shared across the control plane.
 *
 * One source of truth for the string tiers that drive the ops-chat approval
 * flow — replacing the copies that had drifted across `remote/ops-chat`
 * (dispatch, the loop + journal schemas, the router tool descriptors), the
 * MCP operator tool, and the Electron app.
 *
 * Only the tier VOCABULARY is centralized here. The classifiers stay
 * separate by design — `agents/harness#inferTier` (planner allowlist),
 * `agents/healer#tierOf` (a stricter numeric gate, unknown→2),
 * `remote/ops-chat#toolTier` (an exhaustive whitelist), and
 * `fleet-supervisor#actionTier` (fleet action objects, not tool names) each
 * apply intentionally different policies; how a subsystem assigns a tier
 * remains its own decision. (The healer's numeric form is not unified here
 * because `@llamactl/agents` does not depend on `@llamactl/core`.)
 */

/** String safety tiers, ordered least → most privileged. */
export const SAFETY_TIERS = ["read", "mutation-dry-run-safe", "mutation-destructive"] as const;

/**
 * `read` → auto-runnable; `mutation-dry-run-safe` → dry-run preview before
 * the wet run; `mutation-destructive` → additionally confirm by name.
 */
export type SafetyTier = (typeof SAFETY_TIERS)[number];
