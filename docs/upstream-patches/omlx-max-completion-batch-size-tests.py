import argparse

import pytest


class SchedulerConfig:
    def __init__(self, completion_batch_size):
        self.completion_batch_size = completion_batch_size


class SchedulerSettings:
    def __init__(self, max_completion_batch_size=None, max_concurrent_requests=4):
        self.max_completion_batch_size = max_completion_batch_size
        self.max_concurrent_requests = max_concurrent_requests

    def to_dict(self):
        return {
            "max_completion_batch_size": self.max_completion_batch_size,
            "max_concurrent_requests": self.max_concurrent_requests,
        }

    @classmethod
    def from_dict(cls, data):
        return cls(
            max_completion_batch_size=data.get("max_completion_batch_size"),
            max_concurrent_requests=data.get("max_concurrent_requests", 4),
        )


class Settings:
    def __init__(self):
        self.scheduler = SchedulerSettings()

    def to_scheduler_config(self):
        return SchedulerConfig(
            self.scheduler.max_completion_batch_size
            if self.scheduler.max_completion_batch_size is not None
            else self.scheduler.max_concurrent_requests
        )

    def apply_args(self, args):
        if args.max_concurrent_requests is not None:
            self.scheduler.max_concurrent_requests = args.max_concurrent_requests
        if getattr(args, "max_completion_batch_size", None) is not None:
            self.scheduler.max_completion_batch_size = args.max_completion_batch_size


def build_parser():
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-concurrent-requests", type=int, default=None)
    parser.add_argument("--max-completion-batch-size", type=int, default=None)
    return parser


def test_max_completion_batch_size_defaults_to_none():
    settings = SchedulerSettings()

    assert settings.max_completion_batch_size is None


def test_to_scheduler_config_falls_back_when_unset():
    settings = Settings()
    settings.scheduler.max_concurrent_requests = 4

    config = settings.to_scheduler_config()

    assert config.completion_batch_size == 4


def test_to_scheduler_config_uses_override_when_set():
    settings = Settings()
    settings.scheduler.max_concurrent_requests = 4
    settings.scheduler.max_completion_batch_size = 1

    config = settings.to_scheduler_config()

    assert config.completion_batch_size == 1


def test_from_dict_round_trip():
    original = SchedulerSettings(max_completion_batch_size=3, max_concurrent_requests=4)

    restored = SchedulerSettings.from_dict(original.to_dict())

    assert restored.max_completion_batch_size == 3
    assert restored.max_concurrent_requests == 4


def test_cli_flag_overrides_settings():
    parser = build_parser()
    args = parser.parse_args(["--max-completion-batch-size", "1"])
    settings = Settings()

    settings.apply_args(args)

    assert settings.scheduler.max_completion_batch_size == 1
