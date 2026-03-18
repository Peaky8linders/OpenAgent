"""Config models and YAML loader for OpenAgent."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field


class ModelConfig(BaseModel):
    """LLM model configuration."""

    provider: str = "nvidia"
    name: str = "nvidia/nemotron-3-super"
    api_base: str | None = "https://integrate.api.nvidia.com/v1"
    context_window: int = 1_000_000
    temperature: float = 0.1


class HarnessFeatures(BaseModel):
    """Feature flags for the agent harness."""

    planning: bool = True
    filesystem: bool = True
    subagents: bool = True
    code_execution: bool = True
    long_term_memory: bool = True
    human_in_the_loop: bool = False


class HarnessConfig(BaseModel):
    """Agent harness configuration."""

    framework: str = "deepagents"
    features: HarnessFeatures = Field(default_factory=HarnessFeatures)


class RuntimeConfig(BaseModel):
    """Sandbox runtime configuration."""

    sandbox: str = "openshell"
    policy: str = "config/sandbox-policy.yaml"
    gpu: bool = False
    isolation: str = "container"


class AgentMeta(BaseModel):
    """Agent metadata."""

    name: str = "OpenAgent"
    version: str = "0.1.0"
    description: str = ""


class OpenAgentConfig(BaseModel):
    """Root configuration for the agent."""

    agent: AgentMeta = Field(default_factory=AgentMeta)
    model: ModelConfig = Field(default_factory=ModelConfig)
    harness: HarnessConfig = Field(default_factory=HarnessConfig)
    runtime: RuntimeConfig = Field(default_factory=RuntimeConfig)
    compliance: Literal["none", "hipaa", "soc2", "pci", "gdpr"] = "none"


def load_config(path: str | Path = "config/agent-config.yaml") -> OpenAgentConfig:
    """Load and validate config from a YAML file.

    Args:
        path: Path to the YAML config file.

    Returns:
        Validated OpenAgentConfig.

    Raises:
        FileNotFoundError: If the config file doesn't exist.
        ValidationError: If the YAML doesn't match the schema.
    """
    config_path = Path(path)
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    raw: dict[str, Any] = yaml.safe_load(config_path.read_text()) or {}
    return OpenAgentConfig.model_validate(raw)
