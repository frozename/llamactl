from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

_DIR = Path(__file__).resolve().parents[1] / "corpora" / "memory-efficacy"


def _prep_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("memeff_prep", _DIR / "prep.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _prep_chat_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("memeff_prep_chat", _DIR / "prep_chat.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _build_balanced_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("memeff_build_balanced", _DIR / "build_balanced.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _chat(prompt: str, cls: str) -> dict:
    return {
        "messages": [
            {"role": "user", "content": prompt},
            {"role": "assistant", "content": json.dumps({"classification": cls, "reason": ""})},
        ]
    }


class TestPrepHelpers:
    def test_split_name_maps_0_to_7_train_and_8_valid_9_test(self) -> None:
        module = _prep_module()
        assert [module._split_name(i) for i in range(10)] == ["train"] * 8 + ["valid", "test"]

    def test_append_prefix_none_no_brackets(self) -> None:
        module = _prep_module()
        assert module._append_prefix(None, "x") == "Finding: x"

    def test_append_prefix_0_with_brackets(self) -> None:
        module = _prep_module()
        assert module._append_prefix(0, "x") == "Finding: [0] x"

    def test_append_prefix_high_with_brackets(self) -> None:
        module = _prep_module()
        assert module._append_prefix("high", "x") == "Finding: [high] x"

    def test_build_record_format(self) -> None:
        module = _prep_module()
        result = module._build_record("P:", "t", "low", {"memory_related": True, "reason": "r"})
        assert result == {"prompt": "P:Finding: [low] t", "completion": " {\"memory_related\":true,\"reason\":\"r\"}"}

    def test_build_splits_binary_mode(self) -> None:
        module = _prep_module()
        rows_by_class = {
            "missed_registration": [{"findingId": "f-01", "severity": "low", "text": "a", "reason": "ra"}],
            "recall_miss": [{"findingId": "f-10", "severity": None, "text": "b", "reason": "rb"}],
            "not_memory_related": [{"findingId": "f-21", "severity": "high", "text": "c", "reason": "rc"}],
        }
        splits, counts = module._build_splits(rows_by_class, "B:", "memory_related")
        assert splits["train"] == [{"prompt": "B:Finding: [low] a", "completion": " {\"memory_related\":true,\"reason\":\"ra\"}"}]
        assert splits["valid"][0]["completion"] == " {\"memory_related\":true,\"reason\":\"rb\"}"
        assert splits["valid"][0]["prompt"] == "B:Finding: b"
        assert splits["test"][0]["completion"] == " {\"memory_related\":false,\"reason\":\"rc\"}"
        assert counts == {"train": {"memory_related": 1, "not_memory_related": 0}, "valid": {"memory_related": 1, "not_memory_related": 0}, "test": {"memory_related": 0, "not_memory_related": 1}}

    def test_build_splits_4way_mode(self) -> None:
        module = _prep_module()
        rows_by_class = {
            "missed_registration": [{"findingId": "f-01", "severity": "low", "text": "a", "reason": "ra"}],
            "recall_miss": [{"findingId": "f-10", "severity": None, "text": "b", "reason": "rb"}],
            "not_memory_related": [{"findingId": "f-21", "severity": "high", "text": "c", "reason": "rc"}],
        }
        splits, counts = module._build_splits(rows_by_class, "C:", "classification")
        assert splits["valid"][0]["completion"] == " {\"classification\":\"recall_miss\",\"reason\":\"rb\"}"
        assert counts["test"] == {"missed_registration": 0, "recall_miss": 0, "memory_ignored": 0, "not_memory_related": 1}

    def test_format_counts_binary(self) -> None:
        module = _prep_module()
        counts = {"train": {"memory_related": 1, "not_memory_related": 0}, "valid": {"memory_related": 1, "not_memory_related": 0}, "test": {"memory_related": 0, "not_memory_related": 1}}
        result = module._format_counts("T:", counts, ["memory_related", "not_memory_related"])
        assert result == "T:\ntrain: memory_related=1, not_memory_related=0\nvalid: memory_related=1, not_memory_related=0\ntest: memory_related=0, not_memory_related=1"


class TestPrepChat:
    def test_convert_row_strips_leading_spaces_keeps_tabs(self) -> None:
        module = _prep_chat_module()
        result = module._convert_row({"prompt": "abc \n", "completion": "  \t{\"a\":1}"})
        assert result == {"messages": [{"role": "user", "content": "abc"}, {"role": "assistant", "content": "\t{\"a\":1}"}]}

    def test_convert_row_missing_prompt_raises(self) -> None:
        module = _prep_chat_module()
        with pytest.raises(TypeError, match="missing string prompt"):
            module._convert_row({"prompt": 1, "completion": "x"})

    def test_convert_row_missing_completion_raises(self) -> None:
        module = _prep_chat_module()
        with pytest.raises(TypeError, match="missing string completion"):
            module._convert_row({"prompt": "p"})

    def test_read_jsonl_skips_blank_lines(self, tmp_path: Path) -> None:
        module = _prep_chat_module()
        path = tmp_path / "data.jsonl"
        path.write_text('{"a":1}\n\n   \n{"b":2}\n', encoding="utf-8")
        result = module._read_jsonl(path)
        assert result == [{"a": 1}, {"b": 2}]

    def test_read_jsonl_array_raises(self, tmp_path: Path) -> None:
        module = _prep_chat_module()
        path = tmp_path / "data.jsonl"
        path.write_text('[1]\n', encoding="utf-8")
        with pytest.raises(TypeError, match="Expected an object in"):
            module._read_jsonl(path)

    def test_main_4way_framing(self, tmp_path: Path, capsys: object) -> None:
        module = _prep_chat_module()
        monkeypatch = type("MP", (), {"setattr": lambda s, o, n, v: setattr(o, n, v)})()

        monkeypatch.setattr(module, "ROOT", tmp_path)
        monkeypatch.setattr(sys, "argv", ["prep_chat.py", "--framing", "4way"])

        data_dir = tmp_path / "4way"
        data_dir.mkdir()

        # train: 2 rows
        (data_dir / "train.jsonl").write_text(
            json.dumps({"prompt": "p ", "completion": " c"}) + "\n" + json.dumps({"prompt": "p ", "completion": " c"}) + "\n",
            encoding="utf-8",
        )
        # valid: 1 row
        (data_dir / "valid.jsonl").write_text(json.dumps({"prompt": "p ", "completion": " c"}) + "\n", encoding="utf-8")
        # test: 0 rows (empty file)
        (data_dir / "test.jsonl").write_text("", encoding="utf-8")

        module.main()

        output_dir = tmp_path / "4way-chat"
        train_text = (output_dir / "train.jsonl").read_text()
        train_lines = [json.loads(line) for line in train_text.strip().split("\n")]
        assert len(train_lines) == 2
        for line in train_lines:
            assert line == {"messages": [{"role": "user", "content": "p"}, {"role": "assistant", "content": "c"}]}

        test_text = (output_dir / "test.jsonl").read_text()
        assert test_text == ""

        captured = capsys.readouterr()
        assert captured.out == f"Wrote chat corpus to: {output_dir}\ntrain: 2 rows\nvalid: 1 rows\ntest: 0 rows\n"


class TestBuildBalanced:
    def test_target_not_memory_related_values(self) -> None:
        module = _build_balanced_module()
        assert module.TARGET_NOT_MEMORY_RELATED == {"train": 84, "valid": 15, "test": 12}

    def test_balanced_split_truncates_majority_and_orders(self) -> None:
        module = _build_balanced_module()
        rows = (
            [
                _chat("m1", "memory_ignored"),
                _chat("n0", "not_memory_related"),
                _chat("r1", "recall_miss"),
                _chat("x1", "missed_registration"),
            ]
            + [_chat(f"n{i}", "not_memory_related") for i in range(1, 14)]
        )
        output, counts = module._balanced_split(rows, "test")
        assert [row["messages"][0]["content"] for row in output] == ["x1", "r1", "m1", "n12", "n10", "n9", "n3", "n2", "n1", "n7", "n6", "n5", "n8", "n11", "n0"]
        assert counts == {"missed_registration": 1, "recall_miss": 1, "memory_ignored": 1, "not_memory_related": 12}

    def test_balanced_split_unexpected_classification_raises(self) -> None:
        module = _build_balanced_module()
        with pytest.raises(ValueError, match="Unexpected classification 'bogus'"):
            module._balanced_split([_chat("q", "bogus")], "train")

    def test_classification_error_ladder(self) -> None:
        module = _build_balanced_module()

        with pytest.raises(TypeError, match="Expected two chat messages per row"):
            module._classification({"messages": [{"content": "x"}]})

        with pytest.raises(TypeError, match="Expected assistant JSON object"):
            module._classification({"messages": [{"role": "user", "content": "x"}, {"role": "assistant", "content": "[]"}]})

        with pytest.raises(TypeError, match="Expected classification string"):
            module._classification({"messages": [{"role": "user", "content": "x"}, {"role": "assistant", "content": json.dumps({"classification": 3})}]})

    def test_user_prompt_non_string_content_raises(self) -> None:
        module = _build_balanced_module()
        with pytest.raises(TypeError, match="Expected user content string"):
            module._user_prompt({"messages": [{"content": 5}, {"role": "assistant", "content": "x"}]})
