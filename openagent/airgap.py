"""Air-gap mode — fully offline operation with local LLMs.

Supports deployment with zero outbound network calls:
- Ollama for local model inference
- Local sentence-transformers for embeddings (already in brainiac)
- SQLite for storage (no external DB needed)
- All compliance features work offline

Usage:
    python main.py --airgap                    # Uses Ollama default model
    python main.py --airgap --model qwen3:32b  # Specify model
"""

from __future__ import annotations

import subprocess
import sys
from typing import Any

from langchain_core.language_models import BaseChatModel


def check_ollama_available() -> bool:
    """Check if Ollama is installed and running."""
    try:
        result = subprocess.run(
            ["ollama", "list"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def get_ollama_models() -> list[str]:
    """Get list of locally available Ollama models."""
    try:
        result = subprocess.run(
            ["ollama", "list"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return []
        lines = result.stdout.strip().split("\n")[1:]  # Skip header
        return [line.split()[0] for line in lines if line.strip()]
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []


def create_airgap_model(
    model_name: str = "qwen3:32b",
    temperature: float = 0.1,
) -> BaseChatModel:
    """Create a local LLM via Ollama for air-gapped deployment.

    Args:
        model_name: Ollama model name (e.g., qwen3:32b, deepseek-r1:14b).
        temperature: Sampling temperature.

    Returns:
        A LangChain chat model backed by Ollama.

    Raises:
        RuntimeError: If Ollama is not available.
    """
    if not check_ollama_available():
        print(
            "\033[31mError: Ollama not available for air-gap mode.\033[0m\n"
            "Install: https://ollama.com/download\n"
            "Then: ollama pull qwen3:32b",
            file=sys.stderr,
        )
        sys.exit(1)

    models = get_ollama_models()
    if model_name not in models:
        print(
            f"\033[33mModel '{model_name}' not found locally.\033[0m\n"
            f"Available: {', '.join(models) or 'none'}\n"
            f"Pull it: ollama pull {model_name}",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        from langchain_ollama import ChatOllama

        return ChatOllama(
            model=model_name,
            temperature=temperature,
        )
    except ImportError:
        # Fallback: try langchain-community
        try:
            from langchain_community.chat_models import ChatOllama as CommunityOllama

            return CommunityOllama(
                model=model_name,
                temperature=temperature,
            )
        except ImportError:
            print(
                "\033[31mError: Install langchain-ollama for air-gap mode:\033[0m\n"
                "  uv add langchain-ollama",
                file=sys.stderr,
            )
            sys.exit(1)


# ─── Air-gap config for the agent ─────────────────────────────


AIRGAP_CONFIG_OVERRIDES: dict[str, Any] = {
    "model": {
        "provider": "ollama",
        "name": "qwen3:32b",
        "api_base": "http://127.0.0.1:11434",
        "temperature": 0.1,
    },
    "runtime": {
        "sandbox": "openshell",
        "gpu": True,  # Local GPU for inference
        "isolation": "container",
    },
}


def print_airgap_banner(model_name: str) -> None:
    """Print air-gap mode banner."""
    print("\033[36;1m")
    print("  AIR-GAP MODE — Zero outbound network calls")
    print(f"  Model: {model_name} (via Ollama)")
    print("  Embeddings: local sentence-transformers")
    print("  Storage: local SQLite + brainiac")
    print("  Network: fully isolated")
    print("\033[0m")
