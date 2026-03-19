"""Tests for compliance dashboard API."""

from __future__ import annotations

from openagent.compliance import ComplianceFramework, ComplianceScore
from openagent.dashboard import (
    _scoring_history,
    export_audit_cef,
    export_audit_jsonl,
    get_compliance_summary,
    get_scoring_history,
    record_score,
)


def _clear_history() -> None:
    _scoring_history.clear()


class TestRecordScore:
    """Tests for score recording."""

    def setup_method(self) -> None:
        _clear_history()

    def test_records_score(self) -> None:
        score = ComplianceScore(
            score=0.95,
            framework=ComplianceFramework.HIPAA,
            action="read_file",
            findings=["All checks passed"],
        )
        record_score(score)
        assert len(_scoring_history) == 1
        assert _scoring_history[0]["score"] == 0.95

    def test_history_limit(self) -> None:
        for i in range(1100):
            score = ComplianceScore(
                score=0.5,
                framework=ComplianceFramework.SOC2,
                action=f"action_{i}",
            )
            record_score(score)
        assert len(_scoring_history) <= 1000


class TestGetScoringHistory:
    """Tests for history retrieval."""

    def setup_method(self) -> None:
        _clear_history()
        for fw in [ComplianceFramework.HIPAA, ComplianceFramework.SOC2]:
            score = ComplianceScore(score=0.8, framework=fw, action="test")
            record_score(score)
        blocked = ComplianceScore(
            score=0.0, framework=ComplianceFramework.HIPAA,
            action="blocked", blocked=True,
        )
        record_score(blocked)

    def test_returns_all(self) -> None:
        assert len(get_scoring_history()) == 3

    def test_filter_by_framework(self) -> None:
        hipaa = get_scoring_history(framework="hipaa")
        assert len(hipaa) == 2

    def test_filter_blocked_only(self) -> None:
        blocked = get_scoring_history(blocked_only=True)
        assert len(blocked) == 1
        assert blocked[0]["blocked"] is True


class TestComplianceSummary:
    """Tests for aggregate metrics."""

    def setup_method(self) -> None:
        _clear_history()

    def test_empty_summary(self) -> None:
        summary = get_compliance_summary()
        assert summary["total_actions"] == 0

    def test_with_data(self) -> None:
        for _ in range(5):
            record_score(ComplianceScore(
                score=0.9, framework=ComplianceFramework.HIPAA, action="test",
            ))
        record_score(ComplianceScore(
            score=0.0, framework=ComplianceFramework.HIPAA,
            action="blocked", blocked=True,
        ))
        summary = get_compliance_summary()
        assert summary["total_actions"] == 6
        assert summary["blocked_count"] == 1
        assert summary["blocked_rate"] > 0


class TestExport:
    """Tests for audit export formats."""

    def setup_method(self) -> None:
        _clear_history()
        record_score(ComplianceScore(
            score=0.95, framework=ComplianceFramework.HIPAA, action="read",
        ))

    def test_jsonl_export(self) -> None:
        data = export_audit_jsonl(get_scoring_history())
        assert '"score": 0.95' in data
        assert "\n" not in data  # Single entry = no newline

    def test_cef_export(self) -> None:
        data = export_audit_cef(get_scoring_history())
        assert "CEF:0|VaultClaw|OpenAgent" in data
        assert "score=0.95" in data
