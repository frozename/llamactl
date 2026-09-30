# @novaproto/exec-primitives 0.1.0 test consumer

Run date: 2026-09-30.

This record covers the standalone llamactl test consumer at
`test/consumers/exec-primitives`. It exact-pins
`@novaproto/exec-primitives@0.1.0` as a registry dev dependency and exercises
the real llamactl CLI adapter surface through `packages/remote/src/index.ts`.
It does not perform runtime adoption.

## L2 registry install

The consumer manifest pins `"@novaproto/exec-primitives": "0.1.0"` in
`devDependencies`. The consumer lockfile contains the registry integrity entry
for `0.1.0`, and the installed package content digest measured
`0d3b6d9adb16a22de6e3cae3c482fd4c3c6e874b730c46e771f8d042646c9f98`.

The registry packument returned HTTP 200 during the evidence run, and the
package resolves inside `test/consumers/exec-primitives/node_modules`.

## L3 parity

The consumer suite reported 28 pass and 0 fail: 15 ported real-subprocess
cases, 9 differential default-vs-library cases, and 4 registry pin cases. The
origin default-arm adapter test reported 18 pass and 0 fail.

Three usage-observation cases from the origin file are recorded as not portable
because they use a canned fake spawner and do not exercise a subprocess spawner.

## Adaptations

The shim adapts env, cwd, cancel grace, watchdog, stdin, exit-code mapping, and
spawn-error behavior. The exact adaptation list is in the JSON record.

## Divergences

The library signals a process group while the current default adapter signals
the direct child. The parity cases observe only the exec child. The library arm
also carries a watchdog backstop because the library API requires one.

## Coupling

This consumer intentionally follows the real remote adapter export. Slices
#134, #135, and P2.2/llamactl-adoption can require updates under
`test/consumers/exec-primitives/**` if they change the CLI adapter contract.
Those slices should declare that scope before editing this consumer.

## Claims not made

This record does not claim runtime adoption by llamactl, does not claim 1830 is
closed, and does not claim ACP fixture parity in the llamactl consumer.

## Reproduce

```sh
bun install --frozen-lockfile
bun run --cwd packages/remote typecheck
cd test/consumers/exec-primitives
bun install --frozen-lockfile
bun run typecheck
bun run test
cd ../../..
bun run --cwd packages/remote test ./test/cli-adapter-context.test.ts
bun run typecheck
bun run lint
bun run format:check
bun run --cwd packages/remote test
bun test
zsh test/run-all.zsh
```
