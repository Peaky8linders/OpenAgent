"""Tests for config loading and validation."""

from __future__ import annotations

from pathlib import Path

import pytest

from openagent.config import OpenAgentConfig, load_config


class TestLoadConfig:
    """Tests for YAML config loading."""

    def test_load_valid_config(self, sample_config_yaml: Path) -> None:
        config = load_config(sample_config_yaml)
        assert isinstance(config, OpenAgentConfig)
        assert config.agent.name == "TestAgent"
        assert config.agent.version == "0.0.1"

    def test_model_config_values(self, sample_config: OpenAgentConfig) -> None:
        assert sample_config.model.provider == "nvidia"
        assert sample_config.model.name == "nvidia/nemotron-3-super"
        assert sample_config.model.context_window == 1_000_000
        assert sample_config.model.temperature == 0.1

    def test_harness_features(self, sample_config: OpenAgentConfig) -> None:
        features = sample_config.harness.features
        assert features.planning is True
        assert features.filesystem is True
        assert features.subagents is True
        assert features.code_execution is True
        assert features.human_in_the_loop is False

    def test_runtime_config(self, sample_config: OpenAgentConfig) -> None:
        assert sample_config.runtime.sandbox == "openshell"
        assert sample_config.runtime.gpu is False

    def test_missing_file_raises(self) -> None:
        with pytest.raises(FileNotFoundError):
            load_config("/nonexistent/path.yaml")

    def test_empty_yaml_uses_defaults(self, tmp_path: Path) -> None:
        empty_file = tmp_path / "empty.yaml"
        empty_file.write_text("")
        config = load_config(empty_file)
        assert config.agent.name == "OpenAgent"
        assert config.model.provider == "nvidia"

    def test_partial_yaml_fills_defaults(self, tmp_path: Path) -> None:
        partial = tmp_path / "partial.yaml"
        partial.write_text("agent:\n  name: CustomAgent\n")
        config = load_config(partial)
        assert config.agent.name == "CustomAgent"
        assert config.model.temperature == 0.1  # default


class TestOpenAgentConfig:
    """Tests for Pydantic model validation."""

    def test_create_with_defaults(self) -> None:
        config = OpenAgentConfig()
        assert config.agent.name == "OpenAgent"
        assert config.model.context_window == 1_000_000

    def test_model_validate_dict(self) -> None:
        data = {
            "agent": {"name": "MyAgent", "version": "1.0.0"},
            "model": {"temperature": 0.5},
        }
        config = OpenAgentConfig.model_validate(data)
        assert config.agent.name == "MyAgent"
        assert config.model.temperature == 0.5
        assert config.runtime.sandbox == "openshell"  # default
