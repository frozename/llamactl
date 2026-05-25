## Simplifier planner — review of oMLX slot API spec

### Top 3 things to cut for v1
1. Cut the four-guard restore matrix down to one or two guards.
   - Spec section: `Safety guards`
   - Why speculative: for a single-user, single-machine, opt-in feature, the full restore matrix looks like future-proofing rather than a current failure mode. The first real job is to prove that warm restore works at all on the same model, same host, same context budget. A full `model fingerprint + ctx size + quant + secondary tuple` gate is defensible only after you have evidence of an actual bad-restore class that one guard would not catch.
   - What you'd lose: you increase the chance of restoring into a semantically different but still superficially similar state. That is acceptable for a narrow v1 if the feature is clearly opt-in and only used in controlled runs.

2. Cut the `.npz + manifest.json` split and start with one self-describing artifact.
   - Spec section: `Disk format`
   - Why speculative: `.npz` already carries the payload structure. If the only consumer is the same fork, the manifest is mostly duplicated metadata plus an extra parse path. For v1, the simplest path is a single archive with the arrays and a minimal metadata blob, or even a single `.npz` plus a small sidecar only if the runtime cannot store the needed fields in-array.
   - What you'd lose: easier human inspection and a cleaner place for guard metadata. But those are convenience wins, not v1 blockers.

3. Cut the six-phase plan into fewer, larger slices.
   - Spec section: `Phased TDD plan`
   - Why speculative: Phase 1, 2, 3, 4, and 5 are all one feature in practice: add the setting, add the route, persist the snapshot, reload it, and verify failure modes. Splitting them this finely adds ceremony without reducing risk much because the behavior is tightly coupled.
   - What you'd lose: some intermediate green checkpoints. But you gain lower coordination overhead and a clearer implementation path.

### Phase decomposition critique (could it be 3-4 phases instead of 6?)
Yes. I would collapse it to 4 phases, or even 3 if the team is comfortable with a larger first patch.

- Phase A: settings + route skeleton.
  - Add `--slot-save-path`, env plumbing, the `/slots/{slot_id}` route, and disabled behavior.
  - This is one unit because the route cannot exist meaningfully without the config gate.

- Phase B: save path.
  - Implement snapshot extraction, file write, and the minimal artifact format.
  - This is the first real product behavior.

- Phase C: restore path + guards.
  - Load, validate, and inject state.
  - Keep only the guards that prevent catastrophic corruption on day one. I would start with model fingerprint and context size, then add quant/secondary-tuple only if restore bugs show up.

- Phase D: parity test.
  - One end-to-end test that exercises save, restore, and the client contract.
  - This should be a single validation phase, not a multi-phase gate.

If the team insists on six phases, the split is still too fine-grained for v1. Phase 4 and Phase 5 are the same implementation boundary from a code ownership perspective, and Phase 6 is mostly a regression check that should fall naturally out of the integration tests.

### What I would challenge directly
- `HTTP 503 when disabled`: I would seriously consider `404` instead.
  - `503` says "the service exists but is temporarily unavailable." Here the feature is optional and permanently absent unless configured. `404` is simpler, matches "route not present" semantics, and avoids implying the server is in a transient unhealthy state.
  - If the client needs a distinct "feature disabled" signal, that can be surfaced by a lightweight `/props` or capability probe later. For v1, `404` is cleaner.

- `Secondary tuple` symmetry with llamactl: defer it.
  - Exact symmetry with llamactl's matching policy is not required for a useful first release. The server-side restore contract should only protect against real on-disk mismatch. A client-side secondary tuple is an implementation detail of llamactl's lookup policy, not a necessary upstream API invariant.
  - If you keep it, you are encoding llamactl policy into oMLX upstream prematurely.

- `slot=0` abstraction: probably over-designed.
  - If v1 will always expose one slot, a slot namespace adds ceremony without value.
  - I would prefer explicit endpoints like `POST /kv/save` and `POST /kv/restore`, or at least keep `slot_id` internal and fixed at `0` until there is a second slot. The slot concept only earns its keep when there is actual multiplexing.

### What the absolute minimum viable slot API looks like (5-line outline)
1. Add one opt-in save directory setting.
2. Expose one save endpoint and one restore endpoint.
3. Persist one self-describing snapshot artifact for the active model only.
4. Restore with only the guards needed to prevent obvious same-run corruption.
5. Verify save/restore round-trip with one integration test and one client-contract test.

### Bottom line
The spec reads like a v2 design wrapped around a v1 feature. For the first ship, collapse the phases, drop the extra guard symmetry, and simplify the storage and HTTP shape until there is evidence that the extra machinery is paying rent.
