# Strata engine adapter — host a GGUF through Strata

Status: design, implemented
Date: 2026-10-18
Predecessor: MLX Sub A spec (`docs/superpowers/specs/2026-05-18-mlx-engine-sub-a-design.md`),
which introduced the `EngineAdapter` registry + `kind: ModelHost`.

## 1. Goal and scope

llamactl gains a third engine adapter, `strata`, alongside `llamacpp`
and `omlx` (`packages/core/src/engines/strata.ts`). It hosts one GGUF
model through a Strata deployment so AMD/HIP hosts can serve GGUF via a
Strata build with an MTP head, reusing the `kind: ModelHost` lifecycle
already built for oMLX (apply / reconcile / status / teardown, the same
route table, the same `/v1/models` proxy surface).

Out of scope: multi-model hosting, remote-node placement beyond `local`,
and any Strata-internal tuning — those stay in Strata's own run config.

## 2. What the engine runs

A single ModelHost process is the Strata HTTP server: the `strata-server`
symlink (a Python interpreter) launching `serve/server.py` with
`--engine strata --config <file>`. That server in turn forks a **native
engine child** — the actual inference worker — into its own session.
llamactl only ever signals the server pid; the adapter is responsible for
reaching the detached child.

## 3. ModelHost contract

The adapter's `validateSpec` + `prepareLaunch` enforce:

- `spec.binary` is required (no PATH fallback) and its basename must be
  `strata-server`. llamactl identifies a running host by argv0 basename,
  so the symlink name is the only stable process handle.
- `endpoint.host` must be loopback or `0.0.0.0`. The run config's `host`,
  if present, must also be loopback. Strata is loopback-only here.
- Exactly one `hostedModels` entry.
- `extraArgs[0]` must end in `serve/server.py`; `extraArgs` must contain
  the pair `--engine strata` and a `--config <file>` whose target exists.
- `extraArgs` must NOT contain `--host` or `--port` — the adapter owns
  them and appends `{endpoint.host}` / `{endpoint.port}` after extraArgs.
- The `--config` file must parse as a JSON object. Within it:
  - `args[--native]` must resolve to the models dir — `LLAMACTL_MODELS_DIR`,
    falling back to `LLAMA_CPP_MODELS` — joined with `<hostedModel.rel>`
    (the rel must not escape the models dir) and that file must exist.
  - `model_name` or `aliases[]` must contain the hostedModel rel's
    basename, so the host advertises the model llamactl expects.

## 4. Readiness

`probeReady` delegates to `pollUntilModelIds`, which reports ready as soon
as `GET /v1/models` returns any model id, bounded by `spec.timeoutSeconds`
(same poll as oMLX). It does not match the id against the hosted model —
that check lives in the ModelHost adoption path
(`packages/remote/src/server/modelhost.ts`), which adopts a live host only
when its advertised ids include the hosted model's rel or basename.

## 5. Teardown

The native engine child runs in its own session, so a process-group
signal never reaches it. The adapter collects engine children — matched
by a standalone `--serve` argv token — while the server is still alive to
parent them, then:

1. Identity gate: if the recorded pid's identity cannot be verified
   (recycled pid, or its command no longer matches the expectation),
   teardown returns without signalling anything, mirroring
   `gracefulShutdown`'s refusal. A mismatched server must not take an
   unrelated process tree down with it.
2. Graceful SIGTERM to the server with a 60 s grace window.
3. Poll up to 180 s for each collected engine child to exit.
4. Guarded SIGKILL on any child still alive — only after re-confirming
   `--serve` is still in its command line, so a recycled pid is never
   killed.

## 6. Child-env note (HIP / ROCm)

The ModelHost child env is built from an allowlist
(`CHILD_ENV_ALLOWLIST` in `packages/remote/src/server/modelhost.ts`):
only a fixed set of variables is inherited, and HIP / ROCm variables
(`HIP_VISIBLE_DEVICES`, `ROCR_*`, the AMD runtime paths, etc.) are not on
it — they get dropped even when present in the host environment. So the
Strata run config must carry them itself: the run config's `exe` wrapper
and its `env` block are where HIP / ROCm are set, since the adapter's
child env will not supply them.

## 7. Pilot template

`templates/workloads/strata-host-local.yaml` is a single-model `local`
pilot: `kind: ModelHost`, `spec.engine: strata`, `strata-server` binary,
loopback `:8080`, and the required `--config` extraArg. The manifest
comments restate the argv0-symlink, `serve/server.py`, and
`--native`/`aliases` requirements that prepareLaunch rejects on.
