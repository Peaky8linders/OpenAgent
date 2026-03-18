"""Tests for agent factory."""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from openagent.agent import build_system_prompt
from openagent.config import OpenAgentConfig


class TestBuildSystemPrompt:
    """Tests for system prompt construction."""

    def test_includes_agent_name(self) -> None:
        config = OpenAgentConfig()
        prompt = build_system_prompt(config)
        assert "OpenAgent" in prompt

    def test_includes_version(self) -> None:
        config = OpenAgentConfig(agent={"name": "MyBot", "version": "2.0.0"})
        prompt = build_system_prompt(config)
        assert "MyBot" in prompt
        assert "2.0.0" in prompt


class TestCreateModel:
    """Tests for model creation."""

    def test_missing_api_key_exits(self) -> None:
        from openagent.config import ModelConfig
        from openagent.model import create_model

        with patch.dict(os.environ, {}, clear=True):
            # Remove NVIDIA_API_KEY if present
            os.environ.pop("NVIDIA_API_KEY", None)
            with pytest.raises(SystemExit):
                create_model(ModelConfig())
