## Integration planner — review of oMLX slot API spec

### Top 5 integration risks (highest impact first)
1. Two-repo contract drift between oMLX slot API and llamactl `UpstreamSlotClient`
   - Affected components: `frozename/omlx` (new `/slots` API), [packages/core/src/kvstore/upstreamSlots.ts](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/43abf5ec-26ff-4204-bfc4-ddb0c336c834/packages/core/src/kvstore/upstreamSlots.ts), workload manifests that switch to oMLX slot mode.
   - Coordination needed: the win only exists when both sides land together. llamactl expects `POST /slots/{id}?action=save|restore` with JSON `{filename}` and numeric `n_saved`/`n_restored`; `supportsSlots()` probes `/props`. If oMLX ships a different shape/status mapping, llamactl silently falls back to KV-degraded behavior or emits `invalid_response/http_error` branches.
   - Mitigation: ship with an explicit compatibility matrix and version gate. In practice: pin a minimum oMLX commit/tag in llamactl docs, add a startup capability check (`/props` + one no-op slot probe), and fail fast with an operator-facing message when contract mismatch is detected instead of soft degradation.

2. Deployment sequencing risk on `gains-host` (binary rebuild + manifest mutation + reconcile timing)
   - Affected components: [templates/workloads/gains-host-35b-local.yaml](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/43abf5ec-26ff-4204-bfc4-ddb0c336c834/templates/workloads/gains-host-35b-local.yaml), oMLX virtualenv binary at `/Volumes/WorkSSD/src/omlx/.venv/bin/omlx`, ModelHost reconcile path in [packages/remote/src/workload/reconciler.ts](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/43abf5ec-26ff-4204-bfc4-ddb0c336c834/packages/remote/src/workload/reconciler.ts).
   - Coordination needed: enabling slots is a multi-step rollout: upgrade/build oMLX with slot endpoints, then update ModelHost args (`--slot-save-path`), then re-apply or allow controller reconcile to restart. Partial rollout yields no benefit and can look healthy because readiness is still `/v1/models`.
   - Mitigation: treat this as a cutover runbook, not a patch. Enforce step order: build/verify oMLX slot endpoint first, patch manifest second, `llamactl apply -f` third, then validate by exercising save/restore and checking slot files on disk.

3. Environment propagation and directory-ownership ambiguity for `--slot-save-path`
   - Affected components: ModelHost spawn env filter in [packages/remote/src/server/modelhost.ts](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/43abf5ec-26ff-4204-bfc4-ddb0c336c834/packages/remote/src/server/modelhost.ts), launchd-based agent service env, operator filesystem layout.
   - Coordination needed: if operators try to set `OMLX_SLOT_SAVE_PATH` only at launchd service level, that variable is not currently in the parent allowlist and won’t flow to child processes unless set through `spec.env` or replaced with explicit CLI args. Also, directory creation/ownership semantics are unspecified between oMLX startup vs manual pre-create.
   - Mitigation: declare one canonical path strategy. Prefer explicit manifest args (`--slot-save-path`) plus pre-created directory ownership in deployment docs. If env-based config is required, either allowlist the variable in spawn logic or mandate `spec.env` usage per ModelHost manifest.

4. Testability and CI realism gap for Phase 6 parity checks
   - Affected components: oMLX repo integration tests, llamactl e2e harnesses, machine resources (real model, GPU, running proxy/agent).
   - Coordination needed: the spec’s parity validation requires a live oMLX server, real model artifacts, and a running llamactl path; this is expensive and not naturally hermetic in standard CI. Without a stable test profile, regressions will be discovered late during manual machine tests.
   - Mitigation: split testing tiers. Keep unit/contract tests synthetic in both repos, then add an opt-in hardware-backed smoke profile (nightly or gated manual workflow) that validates end-to-end save/restore semantics against a fixed model fixture.

5. Product-surface split: `useProxy` is `ModelRun`-only while slot intent targets `ModelHost` oMLX path
   - Affected components: [packages/remote/src/workload/schema.ts](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/43abf5ec-26ff-4204-bfc4-ddb0c336c834/packages/remote/src/workload/schema.ts), [packages/remote/src/workload/modelhost-schema.ts](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/43abf5ec-26ff-4204-bfc4-ddb0c336c834/packages/remote/src/workload/modelhost-schema.ts), proxy KV gating in [packages/core/src/openaiProxy.ts](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/43abf5ec-26ff-4204-bfc4-ddb0c336c834/packages/core/src/openaiProxy.ts).
   - Coordination needed: Slice X currently models proxy routing as a `ModelRun` field (`spec.useProxy`) and KV metadata path explicitly gates to `ModelRun + llamacpp`. Slot API value for oMLX is strategically tied to ModelHost, so rollout spans a schema/control-plane follow-up that is outside this slot endpoint patch.
   - Mitigation: explicitly stage this as two slices: (A) oMLX slot API + client compatibility, (B) ModelHost proxy-routing/schema extension and KV metadata path widening. Do not market slot support as complete until both slices are shipped.

### Cross-repo coordination story (one paragraph: how do we ship oMLX patch + llamactl consumer in sync?)
Ship with a compatibility-first train: cut an oMLX branch/tag containing `/slots` + `--slot-save-path`, then update llamactl on a paired branch that adds capability detection and operator-visible failure mode when slot contract is absent. Merge sequence should be: publish oMLX artifact/commit reference -> update llamactl manifests and docs to pin that artifact -> run paired smoke in a real model host (`gains-host`) -> only then promote to default guidance. The key is explicit version pinning and a hard “known-good tuple” (oMLX commit/tag + llamactl commit) so operators do not mix old/new halves.

### What new artifacts need to ship besides the spec'd code?
- Updated `gains-host` manifest adding `--slot-save-path` (and any companion path policy).
- Deployment/runbook doc for slot storage path provisioning, ownership, cleanup, and backup/retention policy.
- Operator upgrade doc that pins the required oMLX commit/tag and matching llamactl commit.
- Capability smoke script (or checklist) validating `/props`, `/slots save`, `/slots restore`, and slot file existence.
- Schema/control-plane follow-up artifact for Slice X parity (`useProxy` behavior for `ModelHost`, not only `ModelRun`).
- Community-facing compatibility note for existing oMLX users clarifying that slot endpoints are additive, gated by `--slot-save-path`, and safe when unset.
- Upstream-maintenance note describing how to carry/rebase slot patches on top of `jundot/omlx` updates (patch queue or branch policy).
- Test plan artifact defining which checks are unit, which are machine-backed, and who owns periodic parity validation.
