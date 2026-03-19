"""Tests for contract review tools."""

from __future__ import annotations

from pathlib import Path

from openagent.contract_tools import (
    review_contract,
    scan_document_pii,
    scan_pii,
    scan_risky_clauses,
)


class TestScanPii:
    """Tests for PII scanning."""

    def test_detects_email(self) -> None:
        findings = scan_pii("Contact john@example.com for details")
        assert len(findings) == 1
        assert findings[0]["type"] == "email"

    def test_detects_ssn(self) -> None:
        findings = scan_pii("SSN: 123-45-6789")
        assert any(f["type"] == "ssn" for f in findings)

    def test_detects_api_key(self) -> None:
        findings = scan_pii("key: sk-abcdefghijklmnopqrstuvwxyz1234")
        assert any(f["type"] == "api_key" for f in findings)

    def test_clean_text_no_findings(self) -> None:
        findings = scan_pii("This is a normal business document.")
        assert len(findings) == 0

    def test_multiple_pii_types(self) -> None:
        text = "Email: test@test.com, SSN: 999-88-7777"
        findings = scan_pii(text)
        types = {f["type"] for f in findings}
        assert "email" in types
        assert "ssn" in types


class TestScanRiskyClauses:
    """Tests for risky clause detection."""

    def test_detects_auto_renewal(self) -> None:
        text = "This agreement will automatically renew for successive one-year terms."
        findings = scan_risky_clauses(text)
        assert any(f["type"] == "auto_renewal" for f in findings)

    def test_detects_non_compete(self) -> None:
        text = "Employee agrees to a non-compete restriction for 2 years."
        findings = scan_risky_clauses(text)
        assert any(f["type"] == "non_compete" for f in findings)

    def test_detects_mandatory_arbitration(self) -> None:
        text = "Disputes shall be resolved through binding arbitration."
        findings = scan_risky_clauses(text)
        assert any(f["type"] == "arbitration" for f in findings)

    def test_detects_ip_assignment(self) -> None:
        text = "Contractor assigns all intellectual property rights to the Company."
        findings = scan_risky_clauses(text)
        assert any(f["type"] == "ip_assignment" for f in findings)

    def test_clean_text_no_clauses(self) -> None:
        text = "The parties agree to work together in good faith."
        findings = scan_risky_clauses(text)
        assert len(findings) == 0


class TestReviewContractTool:
    """Tests for the review_contract tool."""

    def test_tool_has_name(self) -> None:
        assert review_contract.name == "review_contract"

    def test_reviews_text_file(self, tmp_path: Path) -> None:
        contract = tmp_path / "contract.txt"
        contract.write_text(
            "This agreement automatically renews annually.\n"
            "Contact: john@acme.com\n"
            "SSN for verification: 123-45-6789\n"
        )
        result = review_contract.invoke({"file_path": str(contract)})
        assert "PII Findings" in result
        assert "Risky Clauses" in result
        assert "email" in result
        assert "auto_renewal" in result

    def test_missing_file(self) -> None:
        result = review_contract.invoke({"file_path": "/nonexistent.txt"})
        assert "not found" in result.lower()


class TestScanDocumentPiiTool:
    """Tests for the scan_document_pii tool."""

    def test_tool_has_name(self) -> None:
        assert scan_document_pii.name == "scan_document_pii"

    def test_scans_clean_file(self, tmp_path: Path) -> None:
        doc = tmp_path / "clean.txt"
        doc.write_text("No personal information here.")
        result = scan_document_pii.invoke({"file_path": str(doc)})
        assert "No PII" in result
