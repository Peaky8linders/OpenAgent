"""
OpenHarness Security — Python port of VaultClaw's sentinel, RBAC, and audit.

Sentinel: content inspection before persistence
RBAC: role-based access control per endpoint
Audit: hash-chained tamper-proof logging
"""
from __future__ import annotations
import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

# ─── Sentinel Pipeline ────────────────────────────────────────────

INJECTION_PATTERNS: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(r"(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|system)\s+(?:instructions?|prompts?|rules?)", re.I),
     "prompt_injection", "Attempts to override system instructions"),
    (re.compile(r"you\s+are\s+now\s+(?:a|an|in)\s+(?:new|different|unrestricted|jailbreak)", re.I),
     "prompt_injection", "Persona override injection"),
    (re.compile(r"\[(?:system|admin|root|sudo)\]|\{\{(?:system|admin)\}\}", re.I),
     "system_override", "Fake system/admin tag"),
    (re.compile(r"(?:secretly|quietly|silently|without\s+(?:telling|informing))\s+(?:send|forward|email|post|upload|exfiltrate)", re.I),
     "hidden_instruction", "Hidden exfiltration instruction"),
    (re.compile(r"forward\s+(?:the\s+)?(?:contents?\s+of|all)\s+(?:~/|/home|/etc|\.ssh|\.env|\.aws|credentials?|secrets?|keys?)", re.I),
     "data_exfiltration", "File/credential exfiltration"),
    (re.compile(r"(?:I\s+am|this\s+is)\s+(?:the\s+)?(?:admin|administrator|system|root|owner|developer)", re.I),
     "authority_exploit", "False authority claim"),
    (re.compile(r"(?:remember|memorize|always)\s+(?:that|this|the\s+(?:following|rule))\s*:?\s*(?:always|never|from\s+now)", re.I),
     "memory_poisoning", "Persistent instruction injection"),
]

CREDENTIAL_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?:sk|pk|rk)-(?:[a-zA-Z0-9]+-)?[a-zA-Z0-9]{20,}"), "API key (sk-/pk-/rk- prefix)"),
    (re.compile(r"ghp_[a-zA-Z0-9]{36,}"), "GitHub PAT"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "AWS access key"),
    (re.compile(r"-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----"), "Private key"),
    (re.compile(r"eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}"), "JWT token"),
    (re.compile(r"(?:password|passwd|pwd)\s*[:=]\s*\S{6,}", re.I), "Plaintext password"),
]

PHI_PATTERNS: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), "pii_exposure", "SSN"),
    (re.compile(r"\bMRN\s*:?\s*\d{6,}", re.I), "phi_exposure", "Medical Record Number"),
    (re.compile(r"\b(?:4\d{3}|5[1-5]\d{2}|6011|3[47]\d{2})\s?\d{4}\s?\d{4}\s?\d{4}\b"), "pii_exposure", "Credit card"),
]

@dataclass
class Finding:
    category: str
    confidence: float
    description: str
    matched_pattern: Optional[str] = None

@dataclass
class SentinelResult:
    threat_level: str  # safe | suspicious | blocked
    findings: list[Finding]
    latency_ms: float

class SentinelPipeline:
    """Content inspection pipeline. Blocks injection, credential leaks, and PHI."""

    def __init__(self, *, block_on_suspicious: bool = True, phi_detection: bool = True):
        self.block_on_suspicious = block_on_suspicious
        self.phi_detection = phi_detection

    def inspect(self, content: str) -> SentinelResult:
        start = time.monotonic()
        findings: list[Finding] = []

        # Injection patterns
        normalized = re.sub(r"\s+", " ", content)
        for pattern, category, desc in INJECTION_PATTERNS:
            m = pattern.search(normalized)
            if m:
                findings.append(Finding(category, 85, desc, m.group()[:30]))

        # Credential patterns
        for pattern, desc in CREDENTIAL_PATTERNS:
            m = pattern.search(content)
            if m:
                findings.append(Finding("credential_leak", 90, desc, m.group()[:20] + "...[REDACTED]"))

        # PHI patterns
        if self.phi_detection:
            for pattern, category, desc in PHI_PATTERNS:
                m = pattern.search(content)
                if m:
                    findings.append(Finding(category, 75, desc))

        # Determine threat level
        threat_level = "safe"
        if findings:
            high_conf = any(f.confidence >= 85 for f in findings)
            critical = any(f.category in ("prompt_injection", "data_exfiltration", "credential_leak", "system_override") for f in findings)
            if high_conf and critical:
                threat_level = "blocked"
            elif self.block_on_suspicious:
                threat_level = "blocked" if high_conf else "suspicious"
            else:
                threat_level = "suspicious"

        elapsed = (time.monotonic() - start) * 1000
        return SentinelResult(threat_level, findings, round(elapsed, 2))

# ─── RBAC ─────────────────────────────────────────────────────────

class Permission(str, Enum):
    READ = "read"
    WRITE = "write"
    DELETE = "delete"
    SEARCH = "search"
    ADMIN = "admin"
    AUDIT_READ = "audit_read"

ROLE_PERMISSIONS: dict[str, set[Permission]] = {
    "admin": {Permission.READ, Permission.WRITE, Permission.DELETE, Permission.SEARCH, Permission.ADMIN, Permission.AUDIT_READ},
    "operator": {Permission.READ, Permission.WRITE, Permission.SEARCH},
    "auditor": {Permission.READ, Permission.SEARCH, Permission.AUDIT_READ},
    "user": {Permission.READ, Permission.SEARCH},
}

def check_permission(role: str, perm: Permission) -> bool:
    perms = ROLE_PERMISSIONS.get(role, set())
    return perm in perms

# ─── Audit Ledger ─────────────────────────────────────────────────

GENESIS_HASH = hashlib.sha256(b"OPENHARNESS_GENESIS_V1").hexdigest()

@dataclass
class AuditLogEntry:
    id: str
    sequence: int
    timestamp: str
    type: str
    user_id: Optional[str]
    target: str
    outcome: str
    details: dict
    previous_hash: str
    hash: str

class AuditLedger:
    """Append-only, hash-chained audit log."""

    def __init__(self) -> None:
        self._entries: list[AuditLogEntry] = []
        self._sequence = 0
        self._last_hash = GENESIS_HASH

    def record(
        self,
        entry_type: str,
        target: str,
        outcome: str,
        details: dict | None = None,
        user_id: str | None = None,
    ) -> AuditLogEntry:
        import uuid
        self._sequence += 1
        entry_id = str(uuid.uuid4())
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        # Redact sensitive values
        safe_details = self._redact(details or {})

        payload = json.dumps({
            "id": entry_id, "seq": self._sequence, "ts": ts,
            "type": entry_type, "prev": self._last_hash,
            "user": user_id, "target": target,
            "outcome": outcome, "details": safe_details,
        }, sort_keys=True)
        entry_hash = hashlib.sha256(payload.encode()).hexdigest()

        entry = AuditLogEntry(
            id=entry_id, sequence=self._sequence, timestamp=ts,
            type=entry_type, user_id=user_id, target=target,
            outcome=outcome, details=safe_details,
            previous_hash=self._last_hash, hash=entry_hash,
        )
        self._entries.append(entry)
        self._last_hash = entry_hash
        return entry

    def verify_chain(self) -> tuple[bool, Optional[str]]:
        if not self._entries:
            return True, None
        if self._entries[0].previous_hash != GENESIS_HASH:
            return False, "First entry doesn't chain from genesis"
        for i in range(1, len(self._entries)):
            if self._entries[i].previous_hash != self._entries[i - 1].hash:
                return False, f"Chain break at entry {i}"
        return True, None

    def query(
        self,
        since: str | None = None,
        before: str | None = None,
        type_filter: str | None = None,
        limit: int = 100,
    ) -> list[AuditLogEntry]:
        results = self._entries
        if type_filter:
            results = [e for e in results if e.type == type_filter]
        if since:
            results = [e for e in results if e.timestamp >= since]
        if before:
            results = [e for e in results if e.timestamp <= before]
        return results[-limit:]

    @property
    def count(self) -> int:
        return len(self._entries)

    @staticmethod
    def _redact(details: dict) -> dict:
        """Redact sensitive values without breaking JSON structure."""
        sensitive_keys = re.compile(r"(?:password|token|secret|key|credential|api_key|apikey)", re.I)
        value_patterns = [
            re.compile(r"(?:sk-|ghp_|AKIA)\S+"),
        ]

        def redact_value(v: object, key: str = "") -> object:
            if isinstance(v, str):
                # Redact if the key itself is sensitive
                if sensitive_keys.search(key):
                    return "[REDACTED]"
                result = v
                for p in value_patterns:
                    result = p.sub("[REDACTED]", result)
                return result
            if isinstance(v, dict):
                return {k: redact_value(val, k) for k, val in v.items()}
            if isinstance(v, list):
                return [redact_value(item) for item in v]
            return v

        return redact_value(details)  # type: ignore[return-value]
