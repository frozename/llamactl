# llamactl

Local-first toolkit for running [llama.cpp](https://github.com/ggerganov/llama.cpp) on macOS. Discover GGUF candidates on Hugging Face, evaluate them on your machine with both text and vision benchmarks, promote winners into named presets, and drive the server from a shell or (soon) an Electron dashboard.

This project grew out of a set of personal shell helpers and is now being split out as a standalone repository so the surface can expand beyond `zsh` without bloating a dotfiles tree.

## Status

- **Shell library** (this repo) — stable enough for daily use. Supports llama.cpp and LM Studio as backends.
- **Electron app** — planned, lives alongside the shell library and shares the same on-disk state files (TSV records) so both surfaces see the same world.

## Layout

- `shell/env.zsh` — environment variables, machine-profile detection, and default-model resolution. Source this before `llamactl.zsh`.
- `shell/llamactl.zsh` — all the helper functions (`llama-*`, `local-ai-*`, `lmstudio-*`, `ollama-*`). Loads into your shell via `source`.
- `app/` — Electron application (coming soon).
- `docs/` — longer-form notes.

## Quick start

Add to your shell config (e.g. `~/.zshrc` or a module loaded from it):

```zsh
# Point at your local clone, or use the install path if you use install.sh.
export LLAMACTL_HOME="${LLAMACTL_HOME:-$HOME/src/llamactl}"

# Optional: where llamactl should store model weights and state.
# Defaults to $HOME/.llamactl when unset.
export DEV_STORAGE="${DEV_STORAGE:-$HOME/.llamactl}"

if [ -f "$LLAMACTL_HOME/shell/env.zsh" ]; then
  source "$LLAMACTL_HOME/shell/env.zsh"
  source "$LLAMACTL_HOME/shell/llamactl.zsh"
fi
```

Then, in a new shell:

```zsh
llama-discover-models                     # see fresh GGUF candidates from HF
llama-candidate-test unsloth/<repo>       # pull + text bench + vision bench + compare
llama-bench-compare multimodal            # compare recorded benches by class
llama-uninstall <rel>                     # clean up a candidate model
```

Named presets such as `best`, `vision`, `balanced`, and `fast` auto-pull missing assets before loading:

```zsh
local-ai-use llama.cpp
local-ai-load best
```

## Dependencies

- `llama.cpp` built locally (the toolkit expects `llama-server`, `llama-bench`, `llama-mtmd-cli` under `$LLAMA_CPP_BIN`)
- `jq`
- `hf` (Hugging Face CLI) for model pulls
- Optional: [LM Studio](https://lmstudio.ai) for the LM Studio backend, with `lms` on `$PATH`

## On-disk state

All runtime state lives under `$LOCAL_AI_RUNTIME_DIR` (default `$DEV_STORAGE/ai-models/local-ai`). The Electron app will read and write the same files:

- `curated-models.tsv` — custom catalog entries added via `llama-curated-add` or `llama-candidate-test`
- `preset-overrides.tsv` — per-profile promotions from `llama-curated-promote`
- `bench-profiles.tsv` — best tuned launch profiles per (machine, model, mode, context, build)
- `bench-history.tsv` — append-only history of every benchmark run
- `bench-vision.tsv` — real vision-path benchmarks (`llama-bench-vision`)
- `bench-assets/` — reference image used by the vision bench

## History

The shell library was extracted from [frozename/dotfiles](https://github.com/frozename/dotfiles) at `zsh/llm.zsh`. For commits prior to the split, see the history there.
