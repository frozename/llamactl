# @novaproto/exec-primitives 0.1.0 test consumer

Run date: 2026-09-30.

This record covers the standalone llamactl test consumer at `test/consumers/exec-primitives`. It exact-pins `@novaproto/exec-primitives@0.1.0` as a registry dev dependency and exercises the real llamactl CLI adapter surface through `packages/remote/src/index.ts`. It does not perform runtime adoption.

## L2 registry install

The consumer manifest pins `"@novaproto/exec-primitives": "0.1.0"` in `devDependencies`. The consumer lockfile contains the registry integrity entry for `0.1.0`, and the installed package content digest measured `0d3b6d9adb16a22de6e3cae3c482fd4c3c6e874b730c46e771f8d042646c9f98`.

The registry packument returned HTTP 200 on 2026-09-30. The package resolves inside `test/consumers/exec-primitives/node_modules`, and check L item L-22b independently repeats by-name resolution in a scratch project.

## L3 parity

The consumer suite reported 28 pass and 0 fail: 15 ported real-subprocess cases, 9 differential default-vs-library cases, and 4 registry pin cases. The origin default-arm adapter test reported 18 pass and 0 fail.

The post-exit drain case was measured in round 2 with 30 pass and 0 fail on the library arm, and 30 pass and 0 fail on the default arm. The round-1 logs also carry 30 pass and 0 fail per arm.

Broad repository gates exit non-zero in this sandbox, but the base and after failing-title sets are identical when extracted from the closing failed-list only:

| gate                   | base                                                                                                           | after                                           | identical |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------- |
| packages/remote        | 175 failures, 168 unique, 10 unnamed, hash `b588380f62d6127e5a59f18a7051ff1dcbfce535595a3132644f926f2d94faede` | 175 failures, 168 unique, 10 unnamed, same hash | yes       |
| root `bun test`        | 242 failures, 234 unique, 11 unnamed, hash `4e67f25f2879161001181fb53e9fbf5bd95de3fbcd7e2fbdb6be710894fbc24d`  | 242 failures, 234 unique, 11 unnamed, same hash | yes       |
| `zsh test/run-all.zsh` | 37 failures, 37 unique, 0 unnamed, hash `1cc4416b3b8117dca0aad7aa7382d3ceb23728a8e0378b2ab29ca660861a596b`     | 37 failures, 37 unique, 0 unnamed, same hash    | yes       |

The attribution is inferred from set identity and the measured constraint counts in the logs: packages/remote has 127 EADDRINUSE, 139 `Failed to start server`, and 42 EPERM in both logs; root `bun test` has 173, 185, and 42 in both logs; `zsh test/run-all.zsh` has 27, 27, and 0 in both logs. The run-all gate stopped after `[1/4] core unit + integration` with exit 1 at base and after, so stages 2 to 4 did not run.

## Adaptations

The shim adapts env, cwd, cancel grace, watchdog, stdin, exit-code mapping, and spawn-error behavior. For streaming, the library supervisor is the only stdout/stderr reader: stdout chunks are eagerly buffered into an unbounded in-memory line queue and stderr chunks into an unbounded in-memory byte buffer. The queue currently finishes when the library exit promise settles.

The caller signal is passed through an identity wrapper so the signal-drop mutation changes both spawners with one line.

## Divergences

The library signals a process group while the current default adapter signals the direct child. The parity cases observe only the exec child.

On the library arm, exit gates the end of stdout iteration because the queue finishes from the library exit promise. On the default arm, stdout ends at pipe close. An independent probe measured stdout iteration ending at 14 ms on the default arm and 1523 ms on the library arm for `echo hi; (sleep 1.5 >/dev/null 2>&1 &)`. A later adoption should finish the queue on stream end or close, with exit as the fallback.

The library arm also carries a watchdog backstop because the library API requires one.

## Coupling

This consumer intentionally follows the real remote adapter export. Slices #134, #135, and P2.2/llamactl-adoption can require updates under `test/consumers/exec-primitives/**` if they change the CLI adapter contract. Those slices should declare that scope before editing this consumer.

The mutation record lists target failing titles, while `red_count` records the total red tests observed for each patch. The red counts for m1 through m8 are 1, 1, 1, 1, 11, 3, 1, and 2.

## Claims not made

This record does not claim runtime adoption by llamactl, does not claim 1830 is closed, and does not claim ACP fixture parity in the llamactl consumer.

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
