"""Shared test fixtures."""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from openagent.config import OpenAgentConfig


@pytest.fixture
def sample_config_yaml(tmp_path: Path) -> Path:
    """Create a sample config YAML file for testing."""
    config_file = tmp_path / "agent-config.yaml"
    config_file.write_text(
        textwrap.dedent("""\
        agent:
          name: "TestAgent"
          version: "0.0.1"
          description: "Test agent"

        model:
          provider: "nvidia"
          name: "nvidia/nemotron-3-super"
          api_base: "https://integrate.api.nvidia.com/v1"
          context_window: 1000000
          temperature: 0.1

        harness:
          framework: "deepagents"
          features:
            planning: true
            filesystem: true
            subagents: true
            code_execution: true
            long_term_memory: true
            human_in_the_loop: false

        runtime:
          sandbox: "openshell"
          policy: "config/sandbox-policy.yaml"
          gpu: false
          isolation: "container"
        """)
    )
    return config_file


@pytest.fixture
def sample_config(sample_config_yaml: Path) -> OpenAgentConfig:
    """Load a sample config for testing."""
    from openagent.config import load_config

    return load_config(sample_config_yaml)
