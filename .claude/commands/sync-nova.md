---
description: Refresh @nova/* file: deps + verify the cross-repo fleet.
---

Use after a Nova schema or package bump. Walks every downstream
consumer, refreshes lockfiles, runs their test suites.

Sequence:

1. **Confirm Nova is green first.**
   ```bash
   (cd ../nova && bun test && bun run typecheck)
   ```
   If red, fix Nova before propagating.

2. **Refresh each consumer.** For every repo that depends on
   `@nova/*` via `file:` (llamactl, sirius-gateway, embersynth,
   plus any new consumer):
   ```bash
   (cd ../<consumer> && bun install && bun test)
   ```

3. **Llamactl last** since it's the most sensitive:
   ```bash
   bun install
   bun test
   bun run typecheck
   ```

4. **Report** per-repo test counts and any drift (failing tests,
   type errors, unexpected schema breaks). If anything's red, STOP
   and surface it — don't auto-fix consumer bugs under a nova sync.

5. **Commit the lockfile bumps per consumer**, not globally. One
   commit per repo, same slice title tying them together.
