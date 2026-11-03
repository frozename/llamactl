from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import ModuleType

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


def _bridge_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("mlx_to_peft", BRIDGE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _lora_pair() -> dict[str, np.ndarray]:
    return {
        "layer0.q_proj.lora_a": np.zeros((2, 3), dtype=np.float32),
        "layer0.q_proj.lora_b": np.ones((3, 2), dtype=np.float32),
    }


def _write(input_dir: Path, tensors: dict[str, np.ndarray], config: dict[str, object]) -> None:
    # Writes the RAW config as given. The helper in test_mlx_to_peft.py always
    # injects rank/scale/base_model, which would hide the bridge's fallbacks.
    input_dir.mkdir(parents=True, exist_ok=True)
    save_file(tensors, str(input_dir / "adapters.safetensors"))
    (input_dir / "adapter_config.json").write_text(json.dumps(config))


def _convert_config(tmp_path: Path, config: dict[str, object]) -> dict[str, object]:
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    _write(input_dir, _lora_pair(), config)

    result = _run_bridge(input_dir, output_dir)
    assert result.returncode == 0
    return json.loads((output_dir / "adapter_config.json").read_text())


def test_missing_adapter_file_exits_2(tmp_path: Path) -> None:
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    input_dir.mkdir(parents=True)
    (input_dir / "adapter_config.json").write_text(json.dumps({}))

    result = _run_bridge(input_dir, output_dir)

    assert result.returncode == 2
    assert "missing required input files" in result.stdout
    assert "adapters.safetensors" in result.stdout
    assert "adapter_config.json" not in result.stdout
    assert not output_dir.exists()


def test_missing_both_inputs_lists_both_in_order(tmp_path: Path) -> None:
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    input_dir.mkdir(parents=True)

    result = _run_bridge(input_dir, output_dir)

    assert result.returncode == 2
    assert "adapters.safetensors, adapter_config.json" in result.stdout
    assert not output_dir.exists()


def test_non_lora_keys_are_dropped(tmp_path: Path) -> None:
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    tensors = _lora_pair()
    tensors["layer0.q_proj.weight"] = np.full((3, 3), 7.0, dtype=np.float32)
    _write(input_dir, tensors, {"lora_parameters": {"keys": ["m.q_proj"]}})

    result = _run_bridge(input_dir, output_dir)
    assert result.returncode == 0

    produced = load_file(str(output_dir / "adapter_model.safetensors"))
    assert set(produced) == {
        "base_model.model.layer0.q_proj.lora_A.weight",
        "base_model.model.layer0.q_proj.lora_B.weight",
    }


def test_rename_unit() -> None:
    bridge = _bridge_module()
    assert bridge.rename("a.lora_a") == "base_model.model.a.lora_A.weight"
    assert bridge.rename("a.lora_b") == "base_model.model.a.lora_B.weight"
    assert bridge.rename("a.lora_a.bias") is None
    assert bridge.rename("a.weight") is None


def test_normalize_dedups_suffixes_first_seen_order() -> None:
    bridge = _bridge_module()
    assert bridge.normalize_target_modules(["x.0.q_proj", "x.0.v_proj", "x.1.q_proj"]) == ["q_proj", "v_proj"]


def test_target_modules_falls_back_to_target_modules_key(tmp_path: Path) -> None:
    config = _convert_config(tmp_path, {"lora_parameters": {"target_modules": ["m.k_proj"]}})
    assert config["target_modules"] == ["k_proj"]


def test_empty_keys_list_falls_through(tmp_path: Path) -> None:
    config = _convert_config(tmp_path, {"lora_parameters": {"keys": [], "target_modules": ["m.o_proj"]}})
    assert config["target_modules"] == ["o_proj"]


def test_target_modules_default(tmp_path: Path) -> None:
    config = _convert_config(tmp_path, {"lora_parameters": {}})
    assert config["target_modules"] == ["q_proj", "v_proj"]


def test_alpha_used_when_scale_absent(tmp_path: Path) -> None:
    config = _convert_config(tmp_path, {"lora_parameters": {"alpha": 8}})
    assert config["lora_alpha"] == 8.0
    assert isinstance(config["lora_alpha"], float)


def test_alpha_default(tmp_path: Path) -> None:
    config = _convert_config(tmp_path, {"lora_parameters": {}})
    assert config["lora_alpha"] == 16.0


def test_r_key_used_when_rank_absent(tmp_path: Path) -> None:
    config = _convert_config(tmp_path, {"lora_parameters": {"r": 2}})
    assert config["r"] == 2


def test_r_default(tmp_path: Path) -> None:
    config = _convert_config(tmp_path, {"lora_parameters": {}})
    assert config["r"] == 8


def test_base_model_falls_back_to_model(tmp_path: Path) -> None:
    config = _convert_config(tmp_path, {"model": "m"})
    assert config["base_model_name_or_path"] == "m"


def test_base_model_default_empty(tmp_path: Path) -> None:
    config = _convert_config(tmp_path, {})
    assert config["base_model_name_or_path"] == ""


def test_no_lora_parameters_block_uses_all_defaults(tmp_path: Path) -> None:
    config = _convert_config(tmp_path, {})
    assert config["target_modules"] == ["q_proj", "v_proj"]
    assert config["r"] == 8
    assert config["lora_alpha"] == 16.0


def test_fixed_peft_fields(tmp_path: Path) -> None:
    config = _convert_config(tmp_path, {})
    assert config["bias"] == "none"
    assert config["fan_in_fan_out"] is False
    assert config["inference_mode"] is True
    assert config["peft_type"] == "LORA"
