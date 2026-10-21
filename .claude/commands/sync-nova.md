---
description: Move llamactl to newly released @novaproto/* versions + verify the cross-repo fleet.
---

Use after Nova releases a `@novaproto/*` package to npm. llamactl
consumes Nova only through exact npm pins; sirius-gateway and
embersynth still consume it through `file:../nova/packages/*`.

Sequence:

1. **Confirm the release is live.** Every version you are about to
   pin must be on npm, and `@novaproto/mcp` / `@novaproto/mcp-shared`
   must pin the same `@novaproto/contracts` version llamactl will:

   ```bash
   npm view @novaproto/contracts versions
   npm view @novaproto/mcp@<version> dependencies
   npm view @novaproto/mcp-shared@<version> dependencies
   ```

2. **Bump the pins.** Exact versions, no `^`/`~`, in every package
   that declares them:

   ```bash
   grep -n '"@novaproto/' packages/*/package.json
   ```

3. **Refresh and verify llamactl:**

   ```bash
   bun install
   bun run typecheck
   bun test
   ```

4. **Refresh the file:-dep consumers** (sirius-gateway, embersynth)
   when the Nova change also matters to them:

   ```bash
   (cd ../<consumer> && bun install && bun test)
   ```

5. **Report** per-repo test counts and any drift (failing tests,
   type errors, unexpected schema breaks). If anything's red, STOP
   and surface it — don't auto-fix consumer bugs under a nova sync.

6. **Commit per repo.** In llamactl: the pins, `bun.lock` and any
   adaptation in one commit.
