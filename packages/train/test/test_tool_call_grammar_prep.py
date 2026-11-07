from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType

import pytest

_PREP = Path(__file__).resolve().parents[1] / "corpora/tool-call-grammar/prep.py"


def _prep_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("tool_call_prep", _PREP)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _row(id: str, positive: bool = False) -> dict:
    row: dict = {
        "id": id,
        "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": id}],
        "tools": [],
        "tool_choice": "auto",
    }
    if positive:
        row["expected_tool_calls"] = [{"function": {"name": "f", "arguments": "{}"}}]
    else:
        row["expected_content"] = "no"
    return row


def _write_source(tmp_path: Path, rows: list[dict]) -> None:
    source = tmp_path / "gold-corpus.jsonl"
    with source.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        f.write("\n")


class TestBucket:
    def test_bucket_values(self) -> None:
        module = _prep_module()
        assert module.bucket("row-00") == 8
        assert module.bucket("row-02") == 9
        assert module.bucket("row-03") == 7
        assert module.bucket("row-04") == 1
        assert module.bucket("row-05") == 0
        assert module.bucket("") == 3


class TestSplitName:
    def test_split_name_sequence(self) -> None:
        module = _prep_module()
        assert [module._split_name(i) for i in range(10)] == ["train"] * 8 + ["valid", "test"]


class TestAssistantTurnPositive:
    def test_two_tool_calls(self) -> None:
        module = _prep_module()
        row: dict = {
            "id": "x",
            "expected_tool_calls": [
                {"function": {"name": "a", "arguments": '{"x":1}'}},
                {"function": {"name": "b", "arguments": "{}"}},
            ],
            "expected_content": "hi",
        }
        result = module._assistant_turn(row)
        expected: dict = {
            "role": "assistant",
            "content": "hi",
            "tool_calls": [
                {"type": "function", "id": "call_0", "function": {"name": "a", "arguments": '{"x":1}'}},
                {"type": "function", "id": "call_1", "function": {"name": "b", "arguments": "{}"}},
            ],
        }
        assert result == expected


class TestAssistantTurnNegativeAndCoercion:
    def test_empty_tool_calls_list(self) -> None:
        module = _prep_module()
        row: dict = {"id": "x", "expected_tool_calls": [], "expected_content": 5}
        result = module._assistant_turn(row)
        assert result == {"role": "assistant", "content": ""}

    def test_missing_expected_tool_calls(self) -> None:
        module = _prep_module()
        row: dict = {"id": "x", "expected_content": 5}
        result = module._assistant_turn(row)
        assert result == {"role": "assistant", "content": ""}


class TestAssistantTurnValidation:
    def _make_row(self, id: str, expected_tool_calls: object | None = None, expected_content: object = "no") -> dict:
        row: dict = {"id": id}
        if expected_tool_calls is not None:
            row["expected_tool_calls"] = expected_tool_calls
        row["expected_content"] = expected_content
        return row

    def test_expected_tool_calls_string(self) -> None:
        module = _prep_module()
        row = self._make_row("r", expected_tool_calls="x")
        with pytest.raises(TypeError, match="expected_tool_calls must be a list or null for r"):
            module._assistant_turn(row)

    def test_expected_tool_calls_list_of_int(self) -> None:
        module = _prep_module()
        row = self._make_row("r", expected_tool_calls=[1])
        with pytest.raises(TypeError, match="entry must be an object for r"):
            module._assistant_turn(row)

    def test_function_not_object(self) -> None:
        module = _prep_module()
        row = self._make_row("r", expected_tool_calls=[{"function": "x"}])
        with pytest.raises(TypeError, match="function must be an object for r"):
            module._assistant_turn(row)

    def test_missing_name_arguments(self) -> None:
        module = _prep_module()
        row = self._make_row("r", expected_tool_calls=[{"function": {"name": "a"}}])
        with pytest.raises(TypeError, match="missing name/arguments for r"):
            module._assistant_turn(row)


class TestMainSplitAndNegativeRebalancing:
    def test_split_and_negative_rebalancing(self, tmp_path: Path, capsys: object) -> None:
        module = _prep_module()
        monkeypatch = type("MP", (), {"setattr": lambda s, o, n, v: setattr(o, n, v)})()

        monkeypatch.setattr(module, "ROOT", tmp_path)
        monkeypatch.setattr(module, "SOURCE", tmp_path / "gold-corpus.jsonl")

        rows = [
            _row("row-05", positive=True),
            _row("row-02", positive=True),
            _row("row-00", positive=False),
            _row("row-03", positive=False),
            _row("row-04", positive=False),
        ]
        _write_source(tmp_path, rows)

        module.main()

        captured = capsys.readouterr()
        train_text = (tmp_path / "train.jsonl").read_text()
        valid_text = (tmp_path / "valid.jsonl").read_text()
        test_text = (tmp_path / "test.jsonl").read_text()

        train_lines = [json.loads(line) for line in train_text.strip().split("\n")]
        valid_lines = [json.loads(line) for line in valid_text.strip().split("\n")] if valid_text.strip() else []
        test_lines = [json.loads(line) for line in test_text.strip().split("\n")]

        train_contents = [line["messages"][1]["content"] for line in train_lines]
        valid_contents = [line["messages"][1]["content"] for line in valid_lines]
        test_contents = [line["messages"][1]["content"] for line in test_lines]

        assert train_contents == ["row-04", "row-05"]
        assert valid_contents == ["row-03"]
        assert test_contents == ["row-02", "row-00"]

        expected_test = '{"messages":[{"role":"system","content":"s"},{"role":"user","content":"row-02"},{"role":"assistant","content":"","tool_calls":[{"type":"function","id":"call_0","function":{"name":"f","arguments":"{}"}}]}],"tools":[],"tool_choice":"auto"}\n{"messages":[{"role":"system","content":"s"},{"role":"user","content":"row-00"},{"role":"assistant","content":"no"}],"tools":[],"tool_choice":"auto"}\n'
        assert test_text == expected_test

        stdout_lines = captured.out.strip().split("\n")
        assert "train: 2 rows (positive=1, negative=1)" in stdout_lines
        assert "valid: 1 rows (positive=0, negative=1)" in stdout_lines
        assert "test: 2 rows (positive=1, negative=1)" in stdout_lines


class TestMainSingleNegative:
    def test_single_negative(self, tmp_path: Path) -> None:
        module = _prep_module()
        monkeypatch = type("MP", (), {"setattr": lambda s, o, n, v: setattr(o, n, v)})()

        monkeypatch.setattr(module, "ROOT", tmp_path)
        monkeypatch.setattr(module, "SOURCE", tmp_path / "gold-corpus.jsonl")

        rows = [
            _row("row-02", positive=True),
            _row("row-05", positive=True),
            _row("row-04", positive=False),
        ]
        _write_source(tmp_path, rows)

        module.main()

        test_text = (tmp_path / "test.jsonl").read_text()
        valid_text = (tmp_path / "valid.jsonl").read_text()
        train_text = (tmp_path / "train.jsonl").read_text()

        test_lines = [json.loads(line) for line in test_text.strip().split("\n")]
        train_lines = [json.loads(line) for line in train_text.strip().split("\n")]

        test_contents = [line["messages"][1]["content"] for line in test_lines]
        train_contents = [line["messages"][1]["content"] for line in train_lines]

        assert test_contents == ["row-02", "row-04"]
        assert valid_text == ""
        assert train_contents == ["row-05"]


class TestMainNonAscii:
    def test_non_ascii_preserved(self, tmp_path: Path) -> None:
        module = _prep_module()
        monkeypatch = type("MP", (), {"setattr": lambda s, o, n, v: setattr(o, n, v)})()

        monkeypatch.setattr(module, "ROOT", tmp_path)
        monkeypatch.setattr(module, "SOURCE", tmp_path / "gold-corpus.jsonl")

        rows = [_row("cafe-row", positive=True)]
        rows[0]["messages"][1]["content"] = "café ✓"
        _write_source(tmp_path, rows)

        module.main()

        split_text = (tmp_path / "train.jsonl").read_text()
        assert "café ✓" in split_text
        assert "\\u00e9" not in split_text

        decoded = json.loads(split_text.strip())
        assert decoded["messages"][1]["content"] == "café ✓"


class TestMainInputValidation:
    def test_missing_messages(self, tmp_path: Path) -> None:
        module = _prep_module()
        monkeypatch = type("MP", (), {"setattr": lambda s, o, n, v: setattr(o, n, v)})()

        monkeypatch.setattr(module, "ROOT", tmp_path)
        monkeypatch.setattr(module, "SOURCE", tmp_path / "gold-corpus.jsonl")

        bad_row = {"id": "a", "messages": [{"role": "system", "content": "x"}]}
        source = tmp_path / "gold-corpus.jsonl"
        source.write_text(json.dumps(bad_row) + "\n")

        with pytest.raises(TypeError, match="Row a is missing the expected input messages"):
            module.main()

        assert sorted(p.name for p in tmp_path.iterdir()) == ["gold-corpus.jsonl"]

    def test_non_object_line(self, tmp_path: Path) -> None:
        module = _prep_module()
        monkeypatch = type("MP", (), {"setattr": lambda s, o, n, v: setattr(o, n, v)})()

        monkeypatch.setattr(module, "ROOT", tmp_path)
        monkeypatch.setattr(module, "SOURCE", tmp_path / "gold-corpus.jsonl")

        source = tmp_path / "gold-corpus.jsonl"
        source.write_text(json.dumps([1]) + "\n")

        with pytest.raises(TypeError, match="Expected an object in"):
            module.main()
