# exec-primitives test consumer

This directory is a standalone test consumer for decision 2031. It exact-pins
`@novaproto/exec-primitives@0.1.0` from the public registry and runs the
llamactl L3 parity cases through the public remote entrypoint. It is not runtime
adoption: no package under `packages/` depends on the library, and the root
manifest and lockfile remain unchanged.

The consumer lives outside the workspace package glob on purpose. Its local
`package.json` and `bun.lock` prove registry resolution by name without adding a
runtime import path to the application packages.

## Run

```sh
cd test/consumers/exec-primitives
bun install --frozen-lockfile
bun run typecheck
bun run test
```

The origin default-arm comparison remains in the remote package:

```sh
bun run --cwd packages/remote test ./test/cli-adapter-context.test.ts
```

## Adaptations

The streaming shim lets the library's supervisor be the only reader of child
stdout and stderr. Supervisor callbacks eagerly push stdout into an in-memory
line queue and stderr into an in-memory byte buffer; this is intentionally
unbounded and does not provide pipe backpressure. The adapter then drains the
queue at its own pace without delaying the library's exit promise.

The library resolves `exit` after child stdio ends and the process group is
gone. The default adapter resolves on the leader exit. A lazy reader of the
library's stdout can therefore delay exit, so the shim records output through
the supervisor callbacks instead of iterating the supervisor's `stdout` stream
directly.

The `takeLinesUntilExit` helper exists only to keep mutation m7 a one-line
patch: that mutant stops yielding buffered lines after exit and is caught by
the post-exit drain test.

## Coupling

The parity tests intentionally follow the real
`packages/remote/src/index.ts` export and exercise
`createCliSubprocessProvider`. Slices #134 and #135, plus the later
P2.2/llamactl-adoption slice, can legitimately need edits under
`test/consumers/exec-primitives/**` when they change the remote CLI adapter
contract. Those edits should be declared as scope changes before modifying this
consumer.
