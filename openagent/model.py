"""NVIDIA model factory for OpenAgent."""

from __future__ import annotations

import os
import sys

from langchain_core.language_models import BaseChatModel
from langchain_nvidia_ai_endpoints import ChatNVIDIA

from openagent.config import ModelConfig


def create_model(config: ModelConfig) -> BaseChatModel:
    """Create a ChatNVIDIA model from config.

    Uses langchain-nvidia-ai-endpoints directly for reliable
    NVIDIA API integration (more predictable than init_chat_model).

    Args:
        config: Model configuration with provider, name, api_base, etc.

    Returns:
        Configured BaseChatModel.

    Raises:
        SystemExit: If NVIDIA_API_KEY is not set.
    """
    api_key = os.environ.get("NVIDIA_API_KEY")
    if not api_key:
        print("Error: NVIDIA_API_KEY environment variable not set.")
        print("Get a free key at https://build.nvidia.com")
        sys.exit(1)

    return ChatNVIDIA(
        model=config.name,
        nvidia_api_key=api_key,
        temperature=config.temperature,
        base_url=config.api_base,
    )
