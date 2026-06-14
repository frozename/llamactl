/**
 * @llamactl/policy — leaf policy primitives.
 *
 * Houses the cost-guardian decision/config/journal primitives so the
 * dispatch path in `@llamactl/remote` can read budget config + journal
 * spend WITHOUT importing `@llamactl/agents` — which is what closed the
 * `remote → agents → mcp → remote` package cycle. A dedicated leaf (rather
 * than `@llamactl/core`) keeps these decoupled from core's bun-runtime
 * modules. The autonomic loop that consumes them (`runCostGuardianTick`)
 * stays in `@llamactl/agents`.
 */
export * from "./config.js";
export * from "./journal.js";
export * from "./state.js";
