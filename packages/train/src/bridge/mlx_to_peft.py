#!/usr/bin/env python3
"""Convert an MLX-LM LoRA adapter directory to PEFT format.

Reads:  <input>/adapters.safetensors + <input>/adapter_config.json (MLX schema)
Writes: <output>/adapter_model.safetensors + <output>/adapter_config.json (PEFT)

Reference: https://github.com/ml-explore/mlx/discussions/1507
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from safetensors import safe_open
from safetensors.numpy import save_file


def rename(mlx_key: str) -> str | None:
    if mlx_key.endswith(".lora_a"):
        return f"base_model.model.{mlx_key.replace('.lora_a', '.lora_A.weight')}"
    if mlx_key.endswith(".lora_b"):
        return f"base_model.model.{mlx_key.replace('.lora_b', '.lora_B.weight')}"
    return None


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("input", type=Path, help="MLX adapter dir")
    p.add_argument("output", type=Path, help="PEFT output dir")
    args = p.parse_args()

    mlx_adapter = args.input / "adapters.safetensors"
    mlx_config = args.input / "adapter_config.json"
    if not mlx_adapter.exists() or not mlx_config.exists():
        print(f"missing inputs in {args.input}")
        return 2

    args.output.mkdir(parents=True, exist_ok=True)
    config = json.loads(mlx_config.read_text())
    lora_params = config.get("lora_parameters", {})

    new_tensors: dict[str, np.ndarray] = {}
    rename_table: list[tuple[str, tuple[int, ...], str, tuple[int, ...]]] = []
    with safe_open(mlx_adapter, framework="np") as f:
        for mlx_key in f.keys():
            peft_key = rename(mlx_key)
            if peft_key is None:
                continue
            t = f.get_tensor(mlx_key)
            # PEFT convention: lora_A is [r, in_features], lora_B is [out_features, r].
            # MLX stores them transposed; flip to match.
            converted = t.T.copy()
            new_tensors[peft_key] = converted
            rename_table.append((mlx_key, t.shape, peft_key, converted.shape))

    save_file(new_tensors, str(args.output / "adapter_model.safetensors"))

    target_modules = lora_params.get("keys") or lora_params.get("target_modules") or ["q_proj", "v_proj"]
    if isinstance(target_modules, list):
        target_modules = sorted({m.split(".")[-1] for m in target_modules})

    peft_config = {
        "base_model_name_or_path": config.get("base_model") or config.get("model") or "",
        "bias": "none",
        "fan_in_fan_out": False,
        "inference_mode": True,
        "lora_alpha": float(lora_params.get("scale", lora_params.get("alpha", 16.0))),
        "peft_type": "LORA",
        "r": int(lora_params.get("rank", lora_params.get("r", 8))),
        "task_type": "CAUSAL_LM",
        "target_modules": target_modules,
    }
    (args.output / "adapter_config.json").write_text(json.dumps(peft_config, indent=2))

    print(f"converted {len(new_tensors)} tensors → {args.output}")
    for mlx_key, mlx_shape, peft_key, peft_shape in rename_table[:4]:
        print(f"  {mlx_key}  {mlx_shape}  →  {peft_key}  {peft_shape}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
