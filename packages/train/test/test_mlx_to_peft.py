from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from safetensors.numpy import load_file, save_file


PYTHON = sys.executable
BRIDGE = Path(__file__).resolve().parents[1] / "src/bridge/mlx_to_peft.py"


def _run_bridge(input_dir: Path, output_dir: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [PYTHON, str(BRIDGE), str(input_dir), str(output_dir)],
        text=True,
        capture_output=True,
        check=False,
    )


def _write_adapter(input_dir: Path, tensors: dict[str, np.ndarray], lora_params: dict[str, object]) -> None:
    input_dir.mkdir(parents=True, exist_ok=True)
    save_file(tensors, str(input_dir / "adapters.safetensors"))
    config = {
        "base_model": "test-base-model",
        "lora_parameters": {
            "rank": 4,
            "scale": 16.0,
            **lora_params,
        },
    }
    (input_dir / "adapter_config.json").write_text(json.dumps(config))


def test_bridge_happy_path(tmp_path: Path) -> None:
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"

    source_tensors = {
        "layer0.qkv_proj.lora_a": np.arange(6, dtype=np.float32).reshape(2, 3),
        "layer0.qkv_proj.lora_b": np.arange(12, dtype=np.float32).reshape(3, 4),
        "layer1.out_proj.lora_a": np.arange(8, dtype=np.float32).reshape(2, 4),
        "layer1.out_proj.lora_b": np.arange(20, dtype=np.float32).reshape(5, 4),
    }
    _write_adapter(
        input_dir,
        source_tensors,
        {
            "keys": [
                "transformer.h.0.mlp.qkv_proj",
                "transformer.h.1.mlp.out_proj",
            ],
            "rank": 4,
            "scale": 32.0,
        },
    )

    result = _run_bridge(input_dir, output_dir)
    assert result.returncode == 0

    tensors = load_file(str(output_dir / "adapter_model.safetensors"))
    assert set(tensors) == {
        "base_model.model.layer0.qkv_proj.lora_A.weight",
        "base_model.model.layer0.qkv_proj.lora_B.weight",
        "base_model.model.layer1.out_proj.lora_A.weight",
        "base_model.model.layer1.out_proj.lora_B.weight",
    }
    assert np.array_equal(tensors["base_model.model.layer0.qkv_proj.lora_A.weight"], source_tensors["layer0.qkv_proj.lora_a"].T)
    assert np.array_equal(tensors["base_model.model.layer0.qkv_proj.lora_B.weight"], source_tensors["layer0.qkv_proj.lora_b"].T)
    assert np.array_equal(tensors["base_model.model.layer1.out_proj.lora_A.weight"], source_tensors["layer1.out_proj.lora_a"].T)
    assert np.array_equal(tensors["base_model.model.layer1.out_proj.lora_B.weight"], source_tensors["layer1.out_proj.lora_b"].T)

    config = json.loads((output_dir / "adapter_config.json").read_text())
    assert config["target_modules"] == ["qkv_proj", "out_proj"]
    assert config["lora_alpha"] == 32.0
    assert config["r"] == 4
    assert config["task_type"] == "CAUSAL_LM"


def test_bridge_no_match_returns_non_zero(tmp_path: Path) -> None:
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"

    _write_adapter(
        input_dir,
        {
            "layer0.qkv_proj.lora_up": np.zeros((1, 1), dtype=np.float32),
            "layer0.qkv_proj.lora_down": np.ones((1, 1), dtype=np.float32),
        },
        {"keys": ["layer0.qkv_proj"]},
    )

    result = _run_bridge(input_dir, output_dir)
    assert result.returncode == 3
    assert "no MLX LoRA tensors matched .lora_a/.lora_b in" in result.stdout


def test_bridge_target_modules_string_rejected(tmp_path: Path) -> None:
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"

    _write_adapter(
        input_dir,
        {
            "layer0.qkv_proj.lora_a": np.zeros((2, 1), dtype=np.float32),
            "layer0.qkv_proj.lora_b": np.ones((1, 2), dtype=np.float32),
            "layer1.out_proj.lora_a": np.full((3, 2), 3, dtype=np.float32),
            "layer1.out_proj.lora_b": np.full((2, 3), 5, dtype=np.float32),
        },
        {"keys": "qkv_proj"},
    )

    result = _run_bridge(input_dir, output_dir)
    assert result.returncode != 0
    assert "ValueError" in result.stderr
    assert "target_modules must be a list" in result.stderr
