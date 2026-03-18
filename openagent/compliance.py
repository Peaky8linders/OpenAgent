"""Compliance engine — policy packs, scoring, and enforcement.

Supports: HIPAA, SOC 2, PCI-DSS, GDPR.
Each pack configures sentinel rules, PII handling, audit requirements,
and network restrictions appropriate for the regulatory framework.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field


class ComplianceFramework(StrEnum):
    """Supported compliance frameworks."""

    HIPAA = "hipaa"
    SOC2 = "soc2"
    PCI_DSS = "pci"
    GDPR = "gdpr"
    NONE = "none"


class PiiHandling(StrEnum):
    """How to handle detected PII."""

    ANNOTATE = "annotate"  # Tag but don't modify
    REDACT_SUMMARIES = "redact_in_summaries"  # Redact in summaries only
    REDACT_ALL = "redact_everywhere"  # Redact everywhere


class CompliancePolicy(BaseModel):
    """A compliance policy pack with rules and thresholds."""

    framework: ComplianceFramework
    description: str

    # PII settings
    pii_handling: PiiHandling = PiiHandling.ANNOTATE
    pii_types_blocked: list[str] = Field(default_factory=list)
    pii_retention_days: int | None = None

    # Sentinel settings
    sentinel_enabled: bool = True
    sentinel_block_suspicious: bool = True
    sentinel_extra_patterns: list[dict[str, str]] = Field(default_factory=list)

    # Audit settings
    audit_enabled: bool = True
    audit_export_format: str = "jsonl"  # jsonl, cef, ocsf
    audit_retention_days: int = 365

    # Network settings
    network_loopback_only: bool = False
    network_allowed_hosts: list[str] = Field(default_factory=list)

    # RBAC defaults
    default_role: str = "operator"
    require_admin_for_delete: bool = True

    # Framework-specific
    requires_baa: bool = False
    requires_encryption_at_rest: bool = False
    data_residency: str | None = None


# ─── Pre-built Policy Packs ──────────────────────────────────


HIPAA_POLICY = CompliancePolicy(
    framework=ComplianceFramework.HIPAA,
    description="HIPAA compliance for protected health information (PHI)",
    pii_handling=PiiHandling.REDACT_ALL,
    pii_types_blocked=["ssn", "credit_card", "api_key", "aws_key"],
    pii_retention_days=2555,  # 7 years per HIPAA
    sentinel_enabled=True,
    sentinel_block_suspicious=True,
    sentinel_extra_patterns=[
        {"pattern": r"(?i)patient\s+(?:name|id|dob|mrn)", "category": "phi_exposure"},
        {"pattern": r"(?i)diagnosis|prognosis|treatment\s+plan", "category": "phi_clinical"},
        {"pattern": r"(?i)insurance\s+(?:id|number|policy)", "category": "phi_insurance"},
    ],
    audit_enabled=True,
    audit_export_format="jsonl",
    audit_retention_days=2555,
    network_loopback_only=True,
    network_allowed_hosts=["integrate.api.nvidia.com"],
    default_role="operator",
    require_admin_for_delete=True,
    requires_baa=True,
    requires_encryption_at_rest=True,
)


SOC2_POLICY = CompliancePolicy(
    framework=ComplianceFramework.SOC2,
    description="SOC 2 Type II trust service criteria compliance",
    pii_handling=PiiHandling.REDACT_SUMMARIES,
    pii_types_blocked=["ssn", "credit_card"],
    pii_retention_days=365,
    sentinel_enabled=True,
    sentinel_block_suspicious=True,
    sentinel_extra_patterns=[
        {"pattern": r"(?i)(?:password|secret|token)\s*[:=]", "category": "credential_exposure"},
        {"pattern": r"(?i)(?:BEGIN\s+(?:RSA|EC|DSA)\s+PRIVATE)", "category": "private_key"},
    ],
    audit_enabled=True,
    audit_export_format="jsonl",
    audit_retention_days=365,
    network_loopback_only=False,
    network_allowed_hosts=[],
    default_role="operator",
    require_admin_for_delete=True,
    requires_encryption_at_rest=True,
)


PCI_DSS_POLICY = CompliancePolicy(
    framework=ComplianceFramework.PCI_DSS,
    description="PCI-DSS compliance for cardholder data environments",
    pii_handling=PiiHandling.REDACT_ALL,
    pii_types_blocked=["credit_card", "ssn"],
    pii_retention_days=365,
    sentinel_enabled=True,
    sentinel_block_suspicious=True,
    sentinel_extra_patterns=[
        {"pattern": r"\b(?:\d{4}[-\s]?){3,4}\d{1,4}\b", "category": "cardholder_data"},
        {"pattern": r"(?i)cvv|cvc|security\s+code", "category": "card_security_code"},
        {"pattern": r"(?i)(?:track\s*[12]|magnetic\s+stripe)", "category": "track_data"},
    ],
    audit_enabled=True,
    audit_export_format="cef",
    audit_retention_days=365,
    network_loopback_only=True,
    network_allowed_hosts=["integrate.api.nvidia.com"],
    default_role="user",
    require_admin_for_delete=True,
    requires_encryption_at_rest=True,
)


GDPR_POLICY = CompliancePolicy(
    framework=ComplianceFramework.GDPR,
    description="GDPR compliance for EU personal data protection",
    pii_handling=PiiHandling.REDACT_SUMMARIES,
    pii_types_blocked=[],
    pii_retention_days=90,  # Minimize retention
    sentinel_enabled=True,
    sentinel_block_suspicious=True,
    sentinel_extra_patterns=[
        {"pattern": r"(?i)consent\s+(?:not\s+)?(?:given|obtained)", "category": "consent_issue"},
        {"pattern": r"(?i)right\s+to\s+(?:erasure|be\s+forgotten)", "category": "erasure_request"},
    ],
    audit_enabled=True,
    audit_export_format="jsonl",
    audit_retention_days=1825,  # 5 years
    network_loopback_only=False,
    network_allowed_hosts=[],
    default_role="operator",
    require_admin_for_delete=True,
    requires_encryption_at_rest=True,
    data_residency="eu",
)


NONE_POLICY = CompliancePolicy(
    framework=ComplianceFramework.NONE,
    description="No compliance restrictions (developer mode)",
    pii_handling=PiiHandling.ANNOTATE,
    sentinel_enabled=True,
    sentinel_block_suspicious=False,
    audit_enabled=True,
    audit_retention_days=30,
    requires_encryption_at_rest=False,
)


POLICY_PACKS: dict[ComplianceFramework, CompliancePolicy] = {
    ComplianceFramework.HIPAA: HIPAA_POLICY,
    ComplianceFramework.SOC2: SOC2_POLICY,
    ComplianceFramework.PCI_DSS: PCI_DSS_POLICY,
    ComplianceFramework.GDPR: GDPR_POLICY,
    ComplianceFramework.NONE: NONE_POLICY,
}


def get_policy(framework: str | ComplianceFramework) -> CompliancePolicy:
    """Get a compliance policy pack by framework name.

    Args:
        framework: Framework name (hipaa, soc2, pci, gdpr, none).

    Returns:
        The compliance policy pack.

    Raises:
        ValueError: If framework is not recognized.
    """
    if isinstance(framework, str):
        framework = ComplianceFramework(framework.lower())
    if framework not in POLICY_PACKS:
        valid = ", ".join(f.value for f in ComplianceFramework)
        raise ValueError(f"Unknown framework: {framework}. Valid: {valid}")
    return POLICY_PACKS[framework]


# ─── Compliance Scoring ──────────────────────────────────────


class ComplianceScore(BaseModel):
    """Real-time compliance score for an agent action."""

    score: float = Field(ge=0.0, le=1.0)
    framework: ComplianceFramework
    action: str
    findings: list[str] = Field(default_factory=list)
    blocked: bool = False


def score_action(
    policy: CompliancePolicy,
    action: str,
    content: str | None = None,
    pii_found: bool = False,
    sentinel_flagged: bool = False,
    audit_logged: bool = True,
) -> ComplianceScore:
    """Score an agent action against the active compliance policy.

    Returns a score from 0.0 (non-compliant) to 1.0 (fully compliant).

    Args:
        policy: Active compliance policy.
        action: The action being scored (e.g., "write_file", "execute").
        content: Optional content being processed.
        pii_found: Whether PII was detected in the content.
        sentinel_flagged: Whether sentinel flagged the content.
        audit_logged: Whether the action was logged to audit trail.

    Returns:
        ComplianceScore with score, findings, and blocked status.
    """
    score = 1.0
    findings: list[str] = []
    blocked = False

    # Sentinel check
    if sentinel_flagged and policy.sentinel_block_suspicious:
        score = 0.0
        findings.append("Sentinel flagged content as suspicious")
        blocked = True

    # PII check
    if pii_found:
        if policy.pii_handling == PiiHandling.REDACT_ALL:
            score = min(score, 0.3)
            findings.append("PII detected — requires full redaction")
        elif policy.pii_handling == PiiHandling.REDACT_SUMMARIES:
            score = min(score, 0.7)
            findings.append("PII detected — redaction in summaries required")
        else:
            score = min(score, 0.9)
            findings.append("PII detected — annotated only")

    # Audit check
    if not audit_logged and policy.audit_enabled:
        score = min(score, 0.5)
        findings.append("Action not logged to audit trail")

    # Encryption check
    if policy.requires_encryption_at_rest:
        score = min(score, 0.95)  # Slight deduction until verified

    # High-risk actions
    high_risk = {"execute", "delete", "write_file", "edit_file"}
    if action in high_risk and policy.framework != ComplianceFramework.NONE:
        if not audit_logged:
            score = min(score, 0.4)
            findings.append(f"High-risk action '{action}' without audit log")

    if not findings:
        findings.append("All compliance checks passed")

    return ComplianceScore(
        score=round(score, 2),
        framework=policy.framework,
        action=action,
        findings=findings,
        blocked=blocked,
    )
