"""Tests for compliance engine — policy packs and scoring."""

from __future__ import annotations

import pytest

from openagent.compliance import (
    ComplianceFramework,
    ComplianceScore,
    PiiHandling,
    get_policy,
    score_action,
)


class TestGetPolicy:
    """Tests for policy pack retrieval."""

    def test_hipaa_policy(self) -> None:
        policy = get_policy("hipaa")
        assert policy.framework == ComplianceFramework.HIPAA
        assert policy.requires_baa is True
        assert policy.requires_encryption_at_rest is True
        assert policy.pii_handling == PiiHandling.REDACT_ALL
        assert policy.network_loopback_only is True

    def test_soc2_policy(self) -> None:
        policy = get_policy("soc2")
        assert policy.framework == ComplianceFramework.SOC2
        assert policy.requires_encryption_at_rest is True
        assert policy.audit_retention_days == 365

    def test_pci_policy(self) -> None:
        policy = get_policy("pci")
        assert policy.framework == ComplianceFramework.PCI_DSS
        assert "credit_card" in policy.pii_types_blocked
        assert policy.network_loopback_only is True

    def test_gdpr_policy(self) -> None:
        policy = get_policy("gdpr")
        assert policy.framework == ComplianceFramework.GDPR
        assert policy.data_residency == "eu"
        assert policy.pii_retention_days == 90

    def test_none_policy(self) -> None:
        policy = get_policy("none")
        assert policy.framework == ComplianceFramework.NONE
        assert policy.sentinel_block_suspicious is False

    def test_invalid_framework_raises(self) -> None:
        with pytest.raises(ValueError):
            get_policy("invalid")

    def test_case_insensitive(self) -> None:
        policy = get_policy("HIPAA")
        assert policy.framework == ComplianceFramework.HIPAA

    def test_enum_input(self) -> None:
        policy = get_policy(ComplianceFramework.SOC2)
        assert policy.framework == ComplianceFramework.SOC2


class TestScoreAction:
    """Tests for compliance scoring."""

    def test_clean_action_scores_high(self) -> None:
        policy = get_policy("hipaa")
        score = score_action(policy, action="read_file")
        assert score.score >= 0.9
        assert not score.blocked

    def test_sentinel_flag_blocks(self) -> None:
        policy = get_policy("hipaa")
        score = score_action(
            policy, action="write_file", sentinel_flagged=True,
        )
        assert score.score == 0.0
        assert score.blocked is True

    def test_pii_reduces_score_hipaa(self) -> None:
        policy = get_policy("hipaa")
        score = score_action(policy, action="write_file", pii_found=True)
        assert score.score <= 0.3
        assert "PII detected" in score.findings[0]

    def test_pii_moderate_score_soc2(self) -> None:
        policy = get_policy("soc2")
        score = score_action(policy, action="write_file", pii_found=True)
        assert 0.5 <= score.score <= 0.8

    def test_missing_audit_reduces_score(self) -> None:
        policy = get_policy("hipaa")
        score = score_action(
            policy, action="execute", audit_logged=False,
        )
        assert score.score <= 0.5

    def test_none_mode_lenient(self) -> None:
        policy = get_policy("none")
        score = score_action(
            policy, action="execute",
            sentinel_flagged=True,
        )
        # None mode doesn't block on suspicious
        assert not score.blocked

    def test_score_returns_framework(self) -> None:
        policy = get_policy("pci")
        score = score_action(policy, action="read_file")
        assert score.framework == ComplianceFramework.PCI_DSS

    def test_score_model_validates(self) -> None:
        score = ComplianceScore(
            score=0.85,
            framework=ComplianceFramework.HIPAA,
            action="test",
            findings=["test finding"],
        )
        assert score.score == 0.85
