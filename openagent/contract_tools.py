"""Contract review tools — document ingestion, PII scanning, clause analysis.

Targets legal/finance verticals where contract review is a $600M+ market.
These tools extend the agent with document-aware capabilities:
- Ingest PDF/DOCX/TXT files
- Scan for PII and sensitive data
- Extract and flag risky clauses
- Generate compliance-aware summaries
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Annotated

from langchain_core.tools import tool

# ─── PII patterns (mirrors LCM's pii-detector.ts) ────────────

PII_PATTERNS: list[tuple[str, str, re.Pattern]] = [
    ("email", "Email address", re.compile(
        r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"
    )),
    ("phone", "Phone number", re.compile(
        r"(?:\+1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b"
    )),
    ("ssn", "Social Security Number", re.compile(
        r"\b\d{3}-\d{2}-\d{4}\b"
    )),
    ("credit_card", "Credit card number", re.compile(
        r"\b(?:\d{4}[-\s]?){3,4}\d{1,4}\b"
    )),
    ("api_key", "API key", re.compile(
        r"\b(?:sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36})\b"
    )),
    ("ip_address", "IP address", re.compile(
        r"\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b"
    )),
]

# ─── Risky clause patterns ────────────────────────────────────

RISKY_CLAUSES: list[tuple[str, str, re.Pattern]] = [
    ("unlimited_liability", "Unlimited liability clause",
     re.compile(r"(?i)unlimited\s+liability|without\s+limitation\s+of\s+liability")),
    ("auto_renewal", "Auto-renewal clause",
     re.compile(r"(?i)auto(?:matic(?:ally)?)?[\s-]*renew")),
    ("non_compete", "Non-compete restriction",
     re.compile(r"(?i)non[\s-]*compet(?:e|ition)|restrictive\s+covenant")),
    ("indemnification", "Broad indemnification",
     re.compile(r"(?i)indemnif(?:y|ication).*(?:all|any)\s+(?:claims|losses|damages)")),
    ("termination_penalty", "Termination penalty",
     re.compile(r"(?i)(?:early\s+)?termination\s+(?:fee|penalty|charge)")),
    ("ip_assignment", "IP assignment clause",
     re.compile(r"(?i)assign(?:s|ment)?\s+(?:all|any)\s+(?:intellectual\s+property|ip|rights)")),
    ("data_retention", "Indefinite data retention",
     re.compile(r"(?i)retain.*(?:indefinite|perpetual|permanent)")),
    ("governing_law", "Governing law clause",
     re.compile(r"(?i)govern(?:ed|ing)\s+(?:by\s+the\s+)?law(?:s)?\s+of")),
    ("arbitration", "Mandatory arbitration",
     re.compile(r"(?i)(?:binding|mandatory)\s+arbitration")),
    ("confidentiality", "Confidentiality clause",
     re.compile(r"(?i)confidential(?:ity)?\s+(?:agreement|obligation|clause)")),
]


def _extract_text_from_file(file_path: str) -> str:
    """Extract plain text from a file. Supports .txt, .md, .py, .json."""
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")

    suffix = path.suffix.lower()

    if suffix in (".txt", ".md", ".py", ".json", ".yaml", ".yml", ".csv", ".log"):
        return path.read_text(encoding="utf-8", errors="replace")

    if suffix == ".pdf":
        # Try pdfplumber if available, else return error message
        try:
            import pdfplumber
            with pdfplumber.open(path) as pdf:
                return "\n".join(page.extract_text() or "" for page in pdf.pages)
        except ImportError:
            return f"[PDF extraction requires pdfplumber: pip install pdfplumber] {path}"

    if suffix in (".docx", ".doc"):
        # Try python-docx if available
        try:
            import xml.etree.ElementTree as ET
            import zipfile
            ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
            with zipfile.ZipFile(path) as z:
                tree = ET.parse(z.open("word/document.xml"))
                paragraphs = []
                for p in tree.findall(".//w:p", ns):
                    texts = [t.text for t in p.findall(".//w:t", ns) if t.text]
                    if texts:
                        paragraphs.append("".join(texts))
                return "\n".join(paragraphs)
        except Exception as e:
            return f"[DOCX extraction failed: {e}] {path}"

    return f"[Unsupported file type: {suffix}] {path}"


def scan_pii(text: str) -> list[dict[str, str | int]]:
    """Scan text for PII patterns."""
    findings = []
    for pii_type, description, pattern in PII_PATTERNS:
        for match in pattern.finditer(text):
            findings.append({
                "type": pii_type,
                "description": description,
                "start": match.start(),
                "end": match.end(),
                "value": match.group()[:20] + "..." if len(match.group()) > 20 else match.group(),
            })
    return findings


def scan_risky_clauses(text: str) -> list[dict[str, str | int]]:
    """Scan text for risky contract clauses."""
    findings = []
    for clause_type, description, pattern in RISKY_CLAUSES:
        for match in pattern.finditer(text):
            # Get surrounding context (±100 chars)
            start = max(0, match.start() - 100)
            end = min(len(text), match.end() + 100)
            context = text[start:end].strip()
            findings.append({
                "type": clause_type,
                "description": description,
                "context": context,
                "position": match.start(),
            })
    return findings


# ─── LangChain Tools ─────────────────────────────────────────


@tool
def review_contract(
    file_path: Annotated[str, "Path to the contract file (PDF, DOCX, or TXT)"],
) -> str:
    """Review a contract for PII exposure and risky clauses.

    Ingests a PDF, DOCX, or text file and scans for:
    - PII: emails, phone numbers, SSNs, credit cards, API keys, IPs
    - Risky clauses: unlimited liability, auto-renewal, non-compete,
      broad indemnification, termination penalties, IP assignment,
      indefinite data retention, mandatory arbitration

    Returns a structured compliance report.
    """
    try:
        text = _extract_text_from_file(file_path)
    except FileNotFoundError as e:
        return str(e)

    if text.startswith("["):
        return text  # Error message from extraction

    pii = scan_pii(text)
    clauses = scan_risky_clauses(text)

    lines = [
        f"# Contract Review: {Path(file_path).name}",
        f"Length: {len(text):,} chars | {len(text.split()):,} words",
        "",
    ]

    # PII section
    lines.append(f"## PII Findings ({len(pii)} detected)")
    if pii:
        for f in pii:
            lines.append(f"  - [{f['type']}] {f['description']}: {f['value']}")
    else:
        lines.append("  None detected.")

    # Clause section
    lines.append(f"\n## Risky Clauses ({len(clauses)} flagged)")
    if clauses:
        for c in clauses:
            lines.append(f"  - [{c['type']}] {c['description']}")
            lines.append(f"    Context: ...{c['context']}...")
    else:
        lines.append("  None flagged.")

    # Summary
    risk = "HIGH" if len(pii) > 3 or len(clauses) > 5 else "MEDIUM" if pii or clauses else "LOW"
    lines.append(f"\n## Risk Level: {risk}")

    return "\n".join(lines)


@tool
def scan_document_pii(
    file_path: Annotated[str, "Path to the document to scan"],
) -> str:
    """Scan a document for PII (personally identifiable information).

    Detects: emails, phone numbers, SSNs, credit card numbers,
    API keys, and IP addresses. Works with PDF, DOCX, and text files.
    """
    try:
        text = _extract_text_from_file(file_path)
    except FileNotFoundError as e:
        return str(e)

    if text.startswith("["):
        return text

    findings = scan_pii(text)
    if not findings:
        return f"No PII detected in {Path(file_path).name}."

    lines = [f"PII found in {Path(file_path).name} ({len(findings)} items):"]
    for f in findings:
        lines.append(f"  [{f['type']}] {f['description']}: {f['value']}")
    return "\n".join(lines)
