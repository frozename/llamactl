---
description: Ship a vertical slice with the standard cross-repo verification.
argument-hint: <slice-name> [scope-notes...]
---

You're about to ship a slice of work. Follow the discipline locked
in `AGENTS.md`:

1. **Verify the plan.** If `~/.claude/plans/` has a doc for this
   slice's parent phase, re-read it before implementing. If not —
   write one before coding (unless the slice is trivial).

2. **Implement the slice.** Keep scope tight:
   - Core logic goes in the layer it belongs in (core → remote →
     cli → mcp → agents). Never shortcut the DAG.
   - Don't bundle unrelated refactors.

3. **Test locally:**
   ```bash
   bun test
   bun run typecheck
   bun run --cwd packages/remote tsc --noEmit
   bun run --cwd packages/app tsc --noEmit
   ```
   All green before you move on.

4. **Cross-repo sweep.** If the slice touches `@nova/*`, bump the
   Nova package first, then in llamactl + sirius-gateway +
   embersynth:
   ```bash
   (cd ../sirius-gateway && bun install && bun test)
   (cd ../embersynth && bun install && bun test)
   (cd ../nova && bun test)
   bun test
   ```
   Four repos green = slice shippable.

5. **Commit.** One focused commit:
   - Title: `feat(<phase-id>): <short verb phrase>`
   - Body: what shipped, why, test deltas, follow-ups.
   - Never add tool-attribution lines (Co-Authored-By, etc.).
   - Never `--no-verify`.

6. **Report back to the user** with commit SHA + test counts per
   repo + what's newly unblocked downstream.

Args: $ARGUMENTS
