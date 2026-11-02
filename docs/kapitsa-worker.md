# Kapitsa inference workers

`ModelHost` supports the native Kapitsa server through the same process lifecycle,
readiness checks, route registry, HTTPS agent, and proxy used by the other engines.
Kapitsa runs on Apple Silicon; its model files can use MLX quantization layouts,
but the inference engine itself uses native Metal kernels.

Install and pin Kapitsa separately, and download and verify the model before
applying a workload. The native command contract was checked against Kapitsa
0.2.24 (`b46d9e5`); qualify another version before deploying it. The executable
must be an absolute path named `kapitsa` so persisted process
identity can corroborate it during status and teardown. The adapter passes an
absolute model folder, disables automatic binary updates, and keeps Kapitsa state
under the workload runtime directory.

The hosted path must be an existing model directory. Import GGUF files separately
before applying a workload; the adapter rejects a file path rather than triggering
conversion while starting a worker. `KAPITSA_HOME` and `KAPITSA_NO_AUTO_UPDATE` are
adapter-owned and cannot be overridden in `spec.env`.

This experimental example assumes `experimental-qwen35b` is a model folder (or
verified cache symlink) under `LLAMACTL_MODELS_DIR` on the worker:

```yaml
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: experimental-kapitsa
spec:
  engine: kapitsa
  node: local
  binary: /opt/local-inference/bin/kapitsa
  resources:
    expectedMemoryGiB: 28
  endpoint:
    host: 127.0.0.1
    port: 18200
  hostedModels:
    - rel: experimental-qwen35b
  extraArgs:
    - --mem-budget
    - "26"
    - --context
    - "32768"
    - --slots
    - "1"
    - --prefill-chunk
    - "2048"
    - --private
  readiness:
    path: /health
    expectStatus: 200
  useProxy: true
  restartPolicy: Never
  timeoutSeconds: 180
```

`expectedMemoryGiB` describes the total inference reservation. Kapitsa's
`--mem-budget` is a native GPU-memory budget in decimal GB. They are different
units and different envelopes: reserve headroom for runtime allocations, draft
weights, KV growth, prefill buffers, and macOS. A model fitting in memory at a
short context does not qualify a larger context or concurrent requests. Measure
pressure, new swap, and whole-process footprint before increasing either budget.

Use native drafting arguments such as `--dflash <verified-drafter-folder>` or
`--dflash none` in `extraArgs`. The adapter does not translate oMLX-specific
`hostedModels[].dflash` settings or hosted LoRA settings. Model selection,
model identity, host, port, backend selection, and model switching are owned by
the manifest and cannot be overridden in `extraArgs`. The adapter adds `--local`
and refuses `--split`, so the model runs on this worker instead of delegating or
splitting inference across other Macs. Fleet routing remains on the controller.

The control-plane CLI and worker must include the Kapitsa engine schema before
applying this manifest through the CLI. Use a separate experimental workload and
alias while qualifying it. Keep the engine on loopback and expose it through the
existing authenticated agent path. Starting or stopping the ModelHost performs
whole-process load or unload; native model switching remains disabled.

No permanent service installation or production routing change is required to
test this adapter. System-wide Metal limits and memory-protection settings are
independent of the adapter and are not changed by it.
