"""Tests for agent tools — brainiac + LCM secure memory."""

from __future__ import annotations

from openagent.compliance import get_policy
from openagent.tools import (
    _check_policy_patterns,
    memory_save,
    memory_search,
    memory_stats,
    secure_store,
    set_active_policy,
)


class TestMemorySearchTool:
    """Tests for the memory_search tool."""

    def test_tool_has_name(self) -> None:
        assert memory_search.name == "memory_search"

    def test_tool_returns_string(self) -> None:
        result = memory_search.invoke({"query": "coding patterns"})
        assert isinstance(result, str)

    def test_tool_with_no_results(self) -> None:
        result = memory_search.invoke({"query": "xyzzy_nonexistent_12345"})
        assert isinstance(result, str)


class TestMemoryStatsTool:
    """Tests for the memory_stats tool."""

    def test_tool_has_name(self) -> None:
        assert memory_stats.name == "memory_stats"

    def test_tool_returns_stats(self) -> None:
        result = memory_stats.invoke({})
        assert isinstance(result, str)
        assert "nodes" in result.lower() or "not available" in result.lower()


class TestMemorySaveTool:
    """Tests for the memory_save tool."""

    def test_tool_has_name(self) -> None:
        assert memory_save.name == "memory_save"


class TestSecureStoreTool:
    """Tests for the secure_store tool."""

    def test_tool_has_name(self) -> None:
        assert secure_store.name == "secure_store"


class TestPolicyPatternEnforcement:
    """Tests for local policy pattern enforcement in LCM tools."""

    def test_no_policy_allows_all(self) -> None:
        set_active_policy(None)
        result = _check_policy_patterns("patient name John Doe")
        assert result is None

    def test_hipaa_blocks_phi_patterns(self) -> None:
        policy = get_policy("hipaa")
        set_active_policy(policy)
        result = _check_policy_patterns("patient name John Doe MRN 12345")
        assert result is not None
        assert "phi_exposure" in result

    def test_hipaa_blocks_clinical_patterns(self) -> None:
        policy = get_policy("hipaa")
        set_active_policy(policy)
        result = _check_policy_patterns("diagnosis is stage 2 cancer")
        assert result is not None
        assert "phi_clinical" in result

    def test_pci_blocks_cardholder_data(self) -> None:
        policy = get_policy("pci")
        set_active_policy(policy)
        result = _check_policy_patterns("card CVV is 123")
        assert result is not None
        assert "card_security_code" in result

    def test_soc2_blocks_credentials(self) -> None:
        policy = get_policy("soc2")
        set_active_policy(policy)
        result = _check_policy_patterns("password: hunter2")
        assert result is not None
        assert "credential_exposure" in result

    def test_gdpr_flags_consent_issues(self) -> None:
        policy = get_policy("gdpr")
        set_active_policy(policy)
        result = _check_policy_patterns("consent not given by user")
        assert result is not None
        assert "consent_issue" in result

    def test_clean_content_passes(self) -> None:
        policy = get_policy("hipaa")
        set_active_policy(policy)
        result = _check_policy_patterns("Please review the code in main.py")
        assert result is None

    def test_none_policy_allows_all(self) -> None:
        policy = get_policy("none")
        set_active_policy(policy)
        result = _check_policy_patterns("patient name John Doe")
        assert result is None  # none policy has no extra patterns

    def teardown_method(self) -> None:
        """Reset policy after each test."""
        set_active_policy(None)
