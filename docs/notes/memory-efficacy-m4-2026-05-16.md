# Memory-efficacy 4-way LoRA re-eval on expanded test set

`git log -1 --oneline`: `5d1bf03 fix(train): restore kill_port arg + wait_port_bindable in eval scripts`

## Prior baseline (n=49)
- macro-F1: `0.4918`
- missed_registration F1: `0.0000`
- recall_miss F1: `1.0000`
- memory_ignored F1: `0.0000`
- not_memory_related F1: `0.9778`

## New run (n=60)
- Status: blocked before metrics were produced.
- The eval script failed on both server cycles with the same port bind error on `127.0.0.1:18099`.
- No valid base or adapter precision/recall/F1 values were emitted in `EVAL_REPORT.md`.

## Deltas
- adapter vs base on the new set: unavailable because the run did not complete.
- new adapter vs prior adapter: unavailable because the run did not complete.

## Log evidence
### server-base.log head/tail
```text
load_backend: loaded BLAS backend from /opt/homebrew/Cellar/ggml/0.9.11/libexec/libggml-blas.so
load_backend: loaded MTL backend from /opt/homebrew/Cellar/ggml/0.9.11/libexec/libggml-metal.so
load_backend: loaded CPU backend from /opt/homebrew/Cellar/ggml/0.9.11/libexec/libggml-cpu-apple_m4.so
main: n_parallel is set to auto, using n_parallel = 4 and kv_unified = true
build_info: b8680-15f786e65
system_info: n_threads = 10 (n_threads_batch = 10) / 14 | MTL : EMBED_LIBRARY = 1 | CPU : NEON = 1 | ARM_FMA = 1 | FP16_VA = 1 | MATMUL_INT8 = 1 | DOTPROD = 1 | SME = 1 | ACCELERATE = 1 | OPENMP = 1 | REPACK = 1 |
Running without SSL
init: using 13 threads for HTTP server
start: binding port with default address family
start: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 18099
srv    operator(): operator(): cleaning up before exit...
main: exiting due to HTTP server error
```

### server-adapter.log head/tail
```text
load_backend: loaded BLAS backend from /opt/homebrew/Cellar/ggml/0.9.11/libexec/libggml-blas.so
load_backend: loaded MTL backend from /opt/homebrew/Cellar/ggml/0.9.11/libexec/libggml-metal.so
load_backend: loaded CPU backend from /opt/homebrew/Cellar/ggml/0.9.11/libexec/libggml-cpu-apple_m4.so
main: n_parallel is set to auto, using n_parallel = 4 and kv_unified = true
build_info: b8680-15f786e65
system_info: n_threads = 10 (n_threads_batch = 10) / 14 | MTL : EMBED_LIBRARY = 1 | CPU : NEON = 1 | ARM_FMA = 1 | FP16_VA = 1 | MATMUL_INT8 = 1 | DOTPROD = 1 | SME = 1 | ACCELERATE = 1 | OPENMP = 1 | REPACK = 1 |
Running without SSL
init: using 13 threads for HTTP server
start: binding port with default address family
start: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 18099
srv    operator(): operator(): cleaning up before exit...
main: exiting due to HTTP server error
```

## Verdict
Blocked by a bind failure before the expanded-set eval could produce a comparable macro-F1 result or test whether the minority signal was recoverable.
