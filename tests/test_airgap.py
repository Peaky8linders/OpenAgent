"""Tests for air-gap mode."""

from __future__ import annotations

from openagent.airgap import AIRGAP_CONFIG_OVERRIDES, check_ollama_available


class TestAirgapConfig:
    """Tests for air-gap configuration."""

    def test_config_uses_ollama_provider(self) -> None:
        assert AIRGAP_CONFIG_OVERRIDES["model"]["provider"] == "ollama"

    def test_config_enables_gpu(self) -> None:
        assert AIRGAP_CONFIG_OVERRIDES["runtime"]["gpu"] is True

    def test_config_has_local_api_base(self) -> None:
        assert "127.0.0.1" in AIRGAP_CONFIG_OVERRIDES["model"]["api_base"]


class TestOllamaCheck:
    """Tests for Ollama availability check."""

    def test_returns_bool(self) -> None:
        result = check_ollama_available()
        assert isinstance(result, bool)
