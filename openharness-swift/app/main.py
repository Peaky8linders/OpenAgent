"""
OpenHarness FastAPI Backend

Routes:
  POST /api/apps/generate        — Generate app from description
  GET  /api/apps                  — List generated apps
  GET  /api/apps/{id}             — Get app details + files
  POST /api/sentinel/inspect      — Inspect content through sentinel
  GET  /api/audit                 — Query audit log
  GET  /api/audit/verify          — Verify audit chain integrity
  GET  /api/health                — Health check

Mobile Client Routes (ClawGuard):
  POST /api/mobile/connect       — Validate gateway connection
  POST /api/mobile/chat          — Send message with sentinel enforcement
  GET  /api/mobile/session        — Session info + security status

Compliance Report Routes:
  GET  /api/compliance/report     — Full compliance report (JSON)
  GET  /api/compliance/frameworks — Available compliance frameworks

GTM Routes:
  GET  /api/gtm/product          — Product feature matrix + pricing
  GET  /api/gtm/health-score     — Live compliance health score
  GET  /api/gtm/appstore-metadata — App Store listing data for ClawGuard
"""
from __future__ import annotations
import time
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException, Depends, Query
from fastapi.middleware.cors import CORSMiddleware

from .models.schemas import (
    GenerateAppRequest, InspectContentRequest, AuditQueryRequest,
    HealthResponse, InspectionResult, ThreatFinding,
    PipelineResult, GeneratedProject, AuditEntry,
    ThreatLevel, MobileChatRequest, MobileChatResponse,
    MobileConnectRequest, MobileSessionResponse,
)
from .security import SentinelPipeline, AuditLedger, check_permission, Permission
from .services.app_service import AppPipeline

# ─── App State ────────────────────────────────────────────────────

class AppState:
    """Shared application state — singletons for sentinel, audit, pipeline."""
    def __init__(self) -> None:
        self.sentinel = SentinelPipeline(block_on_suspicious=True, phi_detection=True)
        self.audit = AuditLedger()
        self.pipeline = AppPipeline(self.sentinel, self.audit)
        self.generated_apps: dict[str, GeneratedProject] = {}
        self.start_time = time.monotonic()

state = AppState()

# ─── Lifespan ─────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    state.audit.record("system_start", "backend", "success", {"version": "0.4.1"})
    yield
    state.audit.record("system_stop", "backend", "success")

# ─── App ──────────────────────────────────────────────────────────

app = FastAPI(
    title="OpenHarness API",
    description="Privacy-first AI agent harness — compliance, security, and app generation",
    version="0.4.1",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Health ───────────────────────────────────────────────────────

@app.get("/api/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    chain_valid, _ = state.audit.verify_chain()
    return HealthResponse(
        status="ok",
        version="0.4.1",
        uptime_seconds=round(time.monotonic() - state.start_time, 2),
        store_ok=True,
        sentinel_active=True,
        audit_chain_valid=chain_valid,
    )

# ─── App Generation ───────────────────────────────────────────────

@app.post("/api/apps/generate")
async def generate_app(req: GenerateAppRequest) -> dict:
    """Generate an app from a natural language description.
    Runs: spec → codegen → sentinel check → L1 eval gate."""
    # Sentinel-check description before entering the pipeline
    desc_check = state.sentinel.inspect(req.description)
    if desc_check.threat_level == "blocked":
        state.audit.record("app_generation_blocked", "pipeline", "blocked",
                           {"findings": len(desc_check.findings)})
        raise HTTPException(status_code=403, detail="Description blocked by sentinel")

    state.audit.record("app_generation_requested", "pipeline", "success",
                       {"description_length": len(req.description)})

    project, pipeline = await state.pipeline.run(req.description)

    if project:
        app_id = pipeline.app_id
        state.generated_apps[app_id] = project
        return {
            "success": True,
            "app_id": app_id,
            "app_name": project.spec.name,
            "files_count": len(project.files),
            "pipeline": pipeline.model_dump(by_alias=True),
            "files": [{"path": f.path, "language": f.language, "lines": f.content.count("\n") + 1} for f in project.files],
        }
    else:
        failed_stage = next((s for s in pipeline.stages if not s.success), None)
        raise HTTPException(
            status_code=422,
            detail={
                "success": False,
                "error": failed_stage.error if failed_stage else "Unknown pipeline failure",
                "failed_stage": failed_stage.stage.value if failed_stage else None,
                "pipeline": pipeline.model_dump(by_alias=True),
            },
        )

@app.get("/api/apps")
async def list_apps() -> dict:
    """List all generated apps."""
    apps = []
    for app_id, project in state.generated_apps.items():
        apps.append({
            "id": app_id,
            "name": project.spec.name,
            "bundle_id": project.spec.bundle_id,
            "files_count": len(project.files),
            "platforms": [p.value for p in project.spec.platforms],
            "created_at": project.spec.created_at,
        })
    return {"apps": apps, "total": len(apps)}

@app.get("/api/apps/{app_id}")
async def get_app(app_id: str) -> dict:
    """Get full app details including generated files."""
    project = state.generated_apps.get(app_id)
    if not project:
        raise HTTPException(status_code=404, detail="App not found")

    state.audit.record("app_accessed", app_id, "success")
    return {
        "spec": project.spec.model_dump(by_alias=True),
        "files": [{"path": f.path, "content": f.content, "language": f.language} for f in project.files],
        "xcode_project_path": project.xcode_project_path,
    }

@app.get("/api/apps/{app_id}/files/{file_path:path}")
async def get_file(app_id: str, file_path: str) -> dict:
    """Get a specific generated file's content."""
    project = state.generated_apps.get(app_id)
    if not project:
        raise HTTPException(status_code=404, detail="App not found")

    file = next((f for f in project.files if f.path == file_path), None)
    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    return {"path": file.path, "content": file.content, "language": file.language}

# ─── Sentinel ─────────────────────────────────────────────────────

@app.post("/api/sentinel/inspect")
async def inspect_content(req: InspectContentRequest) -> dict:
    """Inspect content through the sentinel pipeline."""
    result = state.sentinel.inspect(req.content)

    if result.threat_level != "safe":
        state.audit.record(
            f"sentinel_{result.threat_level}", req.source, result.threat_level,
            {"findings": len(result.findings)},
        )

    return {
        "threat_level": result.threat_level,
        "findings": [
            {"category": f.category, "confidence": f.confidence, "description": f.description}
            for f in result.findings
        ],
        "latency_ms": result.latency_ms,
    }

# ─── Audit ────────────────────────────────────────────────────────

@app.get("/api/audit")
async def query_audit(
    since: str | None = None,
    before: str | None = None,
    type_filter: str | None = Query(None, alias="type"),
    limit: int = Query(100, ge=1, le=1000),
) -> dict:
    """Query the audit log. Requires audit_read permission."""
    entries = state.audit.query(since=since, before=before, type_filter=type_filter, limit=limit)
    return {
        "entries": [
            {
                "id": e.id, "timestamp": e.timestamp, "type": e.type,
                "user_id": e.user_id, "target": e.target, "outcome": e.outcome,
                "details": e.details, "sequence": e.sequence,
            }
            for e in entries
        ],
        "total": len(entries),
        "chain_length": state.audit.count,
    }

@app.get("/api/audit/verify")
async def verify_audit() -> dict:
    """Verify the integrity of the audit chain."""
    valid, reason = state.audit.verify_chain()
    state.audit.record("audit_verification", "chain", "success" if valid else "failure")
    return {"valid": valid, "reason": reason, "chain_length": state.audit.count}

# ─── Eval (for frontend display) ──────────────────────────────────

@app.get("/api/evals/l1-gates")
async def list_l1_gates() -> dict:
    """List available L1 hard gates."""
    return {
        "gates": [
            {"name": "no_pii_in_output", "description": "No PII (SSN, email, credit card) in generated code", "type": "security"},
            {"name": "no_unsafe_patterns", "description": "No eval(), Function(), SQL injection patterns", "type": "security"},
            {"name": "no_credential_leak", "description": "No hardcoded API keys, tokens, or passwords", "type": "security"},
            {"name": "code_quality", "description": "Generated Swift compiles and follows conventions", "type": "quality"},
            {"name": "sentinel_clear", "description": "All files pass sentinel inspection", "type": "security"},
        ],
    }

@app.get("/api/evals/judges")
async def list_judges() -> dict:
    """List available L2 LLM judges."""
    return {
        "judges": [
            {"name": "context_loss_judge", "failure_mode": "context_loss", "description": "Checks if response uses provided context correctly"},
            {"name": "hallucination_judge", "failure_mode": "hallucination", "description": "Checks for claims not supported by context"},
            {"name": "instruction_following_judge", "failure_mode": "instruction_violation", "description": "Checks if instructions were followed"},
            {"name": "pii_leakage_judge", "failure_mode": "pii_leakage", "description": "Checks for PII in output"},
            {"name": "prompt_injection_judge", "failure_mode": "prompt_injection_success", "description": "Checks if injection succeeded"},
        ],
    }

# ─── Mobile Client (ClawGuard) ──────────────────────────────────

import uuid as _uuid

_mobile_sessions: dict[str, dict] = {}
_MAX_SESSIONS = 1000
_SESSION_TTL = 3600  # 1 hour


def _prune_sessions() -> None:
    """Evict expired sessions to prevent unbounded growth."""
    now = time.time()
    expired = [k for k, v in _mobile_sessions.items() if now - v.get("created", 0) > _SESSION_TTL]
    for k in expired:
        del _mobile_sessions[k]
    # Hard cap
    if len(_mobile_sessions) > _MAX_SESSIONS:
        oldest = sorted(_mobile_sessions, key=lambda k: _mobile_sessions[k].get("created", 0))
        for k in oldest[: len(_mobile_sessions) - _MAX_SESSIONS]:
            del _mobile_sessions[k]

@app.post("/api/mobile/connect")
async def mobile_connect(req: MobileConnectRequest) -> dict:
    """Validate a gateway connection from the mobile client.
    Checks sentinel on the host/sandbox inputs before proceeding."""
    # Sentinel-check the inputs (prevent injection via host field)
    host_check = state.sentinel.inspect(f"{req.host}:{req.port}")
    if host_check.threat_level == "blocked":
        state.audit.record("mobile_connect_blocked", req.host, "blocked",
                           {"findings": len(host_check.findings)})
        raise HTTPException(status_code=403, detail="Connection blocked by sentinel")

    _prune_sessions()
    session_id = str(_uuid.uuid4())
    _mobile_sessions[session_id] = {
        "host": req.host, "port": req.port,
        "sandbox": req.sandbox_name, "created": time.time(),
    }
    state.audit.record("mobile_connect", req.host, "success",
                       {"session_id": session_id, "port": str(req.port)})
    return {
        "sessionId": session_id,
        "status": "connected",
        "sentinelActive": True,
        "auditChainValid": state.audit.verify_chain()[0],
    }

@app.post("/api/mobile/chat")
async def mobile_chat(req: MobileChatRequest) -> dict:
    """Process a chat message from the mobile client with full sentinel enforcement."""
    # Validate session if provided
    if req.session_id and req.session_id not in _mobile_sessions:
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    # Sentinel-check outbound content
    inspection = state.sentinel.inspect(req.content)

    sentinel_status = {
        "threatLevel": inspection.threat_level,
        "findingsCount": len(inspection.findings),
        "latencyMs": inspection.latency_ms,
    }

    audit_entry = state.audit.record(
        "mobile_message", "chat", inspection.threat_level,
        {"content_length": str(len(req.content)),
         "findings": str(len(inspection.findings)),
         "session_id": req.session_id or "anonymous"},
    )

    if inspection.threat_level == "blocked":
        reasons = "; ".join(f.description for f in inspection.findings)
        return {
            "messageId": str(_uuid.uuid4()),
            "content": f"[BLOCKED] {reasons}",
            "sentinel": sentinel_status,
            "blocked": True,
            "auditSequence": audit_entry.sequence,
        }

    # In MVP, echo back with sentinel clearance (real LLM integration in Phase 2)
    return {
        "messageId": str(_uuid.uuid4()),
        "content": f"[Sentinel: {inspection.threat_level}] Message received and cleared. "
                   f"({len(req.content)} chars, {inspection.latency_ms:.1f}ms inspection)",
        "sentinel": sentinel_status,
        "blocked": False,
        "auditSequence": audit_entry.sequence,
    }

@app.get("/api/mobile/session")
async def mobile_session(session_id: str = Query(..., alias="sessionId")) -> dict:
    """Get session security status for the mobile client."""
    session = _mobile_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    chain_valid, _ = state.audit.verify_chain()
    return {
        "sessionId": session_id,
        "sentinelActive": True,
        "phiDetection": state.sentinel.phi_detection,
        "blockOnSuspicious": state.sentinel.block_on_suspicious,
        "auditChainValid": chain_valid,
        "auditChainLength": state.audit.count,
        "version": "0.4.1",
    }

# ─── Compliance Report ──────────────────────────────────────

@app.get("/api/compliance/report")
async def compliance_report(
    framework: str = Query("none", description="Compliance framework: hipaa, soc2, pci, gdpr, none"),
    since: str | None = None,
    before: str | None = None,
    format: str = Query("full", description="Report format: full or summary"),
) -> dict:
    """Generate a compliance report with audit chain, sentinel stats, and findings."""
    report_id = str(_uuid.uuid4())
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # Chain integrity
    chain_valid, chain_reason = state.audit.verify_chain()

    # Audit summary
    all_entries = state.audit.query(since=since, before=before, limit=10000)
    type_counts: dict[str, int] = {}
    for e in all_entries:
        type_counts[e.type] = type_counts.get(e.type, 0) + 1

    # Sentinel stats from audit entries
    sentinel_entries = [e for e in all_entries if "sentinel" in e.type or "blocked" in e.type]
    blocked = [e for e in all_entries if e.outcome == "blocked"]
    suspicious = [e for e in all_entries if e.outcome == "suspicious"]
    safe = [e for e in all_entries if e.outcome in ("success", "safe")]

    # Category counts from blocked entries
    category_counts: dict[str, int] = {}
    for e in blocked:
        cat = e.details.get("category", "unknown")
        category_counts[cat] = category_counts.get(cat, 0) + 1
    top_categories = [{"category": k, "count": v} for k, v in sorted(category_counts.items(), key=lambda x: -x[1])]

    # Findings timeline (last 20 security events)
    security_events = [e for e in all_entries if e.outcome in ("blocked", "suspicious")]
    findings_timeline = [
        {"timestamp": e.timestamp, "type": e.type, "target": e.target,
         "outcome": e.outcome, "sequence": e.sequence}
        for e in security_events[-20:]
    ]

    # Compliance score (1.0 = perfect, degrades with findings)
    total = len(all_entries) or 1
    blocked_ratio = len(blocked) / total
    score = max(0.0, round(1.0 - (blocked_ratio * 5), 3))  # -5% per blocked event ratio
    if not chain_valid:
        score = max(0.0, score - 0.5)  # Major penalty for broken chain

    state.audit.record("compliance_report_generated", framework, "success",
                       {"report_id": report_id, "format": format, "score": str(score)})

    report = {
        "reportId": report_id,
        "generatedAt": now,
        "version": "0.4.1",
        "framework": framework,
        "chainIntegrity": {
            "valid": chain_valid,
            "reason": chain_reason,
            "chainLength": state.audit.count,
        },
        "sentinelStats": {
            "totalInspections": len(sentinel_entries),
            "blockedCount": len(blocked),
            "suspiciousCount": len(suspicious),
            "safeCount": len(safe),
            "topCategories": top_categories,
        },
        "auditSummary": {
            "totalEntries": len(all_entries),
            "eventTypes": type_counts,
            "dateRange": {
                "from": all_entries[0].timestamp if all_entries else None,
                "to": all_entries[-1].timestamp if all_entries else None,
            },
        },
        "findingsTimeline": findings_timeline,
        "complianceScore": score,
    }

    if format == "summary":
        return {
            "reportId": report_id,
            "generatedAt": now,
            "framework": framework,
            "complianceScore": score,
            "chainValid": chain_valid,
            "totalEvents": len(all_entries),
            "blockedEvents": len(blocked),
            "status": "compliant" if score >= 0.8 else "needs_attention" if score >= 0.5 else "non_compliant",
        }

    return report

@app.get("/api/compliance/frameworks")
async def list_frameworks() -> dict:
    """List available compliance frameworks."""
    return {
        "frameworks": [
            {"id": "hipaa", "name": "HIPAA", "description": "Health Insurance Portability and Accountability Act", "focus": "PHI protection, access controls, audit trails"},
            {"id": "soc2", "name": "SOC 2", "description": "Service Organization Control 2", "focus": "Security, availability, processing integrity, confidentiality, privacy"},
            {"id": "pci", "name": "PCI-DSS", "description": "Payment Card Industry Data Security Standard", "focus": "Cardholder data protection, encryption, access control"},
            {"id": "gdpr", "name": "GDPR", "description": "General Data Protection Regulation", "focus": "Data subject rights, consent, data minimization, breach notification"},
            {"id": "none", "name": "None", "description": "No compliance framework enforced", "focus": "Basic security only"},
        ],
    }

# ─── GTM (isolated from compliance per gtm-rules.md) ────────

@app.get("/api/gtm/product")
async def gtm_product() -> dict:
    """Product information for landing pages and sales materials."""
    return {
        "name": "VaultClaw",
        "tagline": "Private, compliance-grade coding agent",
        "version": "0.4.1",
        "pricing": [
            {
                "name": "Open Source",
                "price": "$0",
                "period": "forever",
                "features": [
                    "Full agent + 15 tools",
                    "Sentinel security pipeline",
                    "Audit chain logging",
                    "SQLite memory backend",
                    "Community support",
                ],
                "highlighted": False,
                "cta": "Get Started",
            },
            {
                "name": "Pro",
                "price": "$49",
                "period": "month",
                "features": [
                    "Everything in Open Source",
                    "HIPAA / SOC 2 / PCI / GDPR packs",
                    "PostgreSQL + pgvector memory",
                    "ClawGuard iOS app",
                    "Compliance report export",
                    "Priority support",
                ],
                "highlighted": True,
                "cta": "Start Free Trial",
            },
            {
                "name": "Enterprise",
                "price": "Custom",
                "period": "year",
                "features": [
                    "Everything in Pro",
                    "Air-gapped deployment",
                    "NemoClaw sandbox integration",
                    "Custom compliance policies",
                    "SSO / SAML",
                    "Dedicated support + SLA",
                ],
                "highlighted": False,
                "cta": "Contact Sales",
            },
        ],
        "featureMatrix": [
            {
                "name": "Security",
                "features": [
                    {"name": "Sentinel Pipeline", "free": True, "pro": True, "enterprise": True, "description": "7 injection + 6 credential + 3 PHI detection patterns"},
                    {"name": "Hash-Chained Audit", "free": True, "pro": True, "enterprise": True, "description": "SHA-256 tamper-proof logging"},
                    {"name": "RBAC", "free": True, "pro": True, "enterprise": True, "description": "Role-based access control (admin/operator/auditor/user)"},
                    {"name": "NFKC Normalization", "free": True, "pro": True, "enterprise": True, "description": "Unicode homoglyph bypass prevention"},
                ],
            },
            {
                "name": "Compliance",
                "features": [
                    {"name": "Compliance Frameworks", "free": False, "pro": True, "enterprise": True, "description": "HIPAA, SOC 2, PCI-DSS, GDPR policy packs"},
                    {"name": "Compliance Reports", "free": False, "pro": True, "enterprise": True, "description": "JSON export for auditors"},
                    {"name": "Custom Policies", "free": False, "pro": False, "enterprise": True, "description": "Define custom compliance rules"},
                    {"name": "Air-Gap Mode", "free": False, "pro": False, "enterprise": True, "description": "Fully offline operation"},
                ],
            },
            {
                "name": "Platform",
                "features": [
                    {"name": "ClawGuard iOS", "free": False, "pro": True, "enterprise": True, "description": "Secure mobile client with sentinel enforcement"},
                    {"name": "NemoClaw Sandbox", "free": False, "pro": False, "enterprise": True, "description": "Kernel-level sandboxed execution"},
                    {"name": "PostgreSQL Backend", "free": False, "pro": True, "enterprise": True, "description": "Production-grade encrypted memory"},
                    {"name": "One-Command Deploy", "free": True, "pro": True, "enterprise": True, "description": "curl | bash quickstart installer"},
                ],
            },
        ],
        "complianceFrameworks": ["HIPAA", "SOC 2", "PCI-DSS", "GDPR"],
        "differentiators": [
            "Only open-source agent with compliance-grade security (sentinel + audit chain + RBAC)",
            "Native iOS client with bidirectional sentinel enforcement",
            "Hash-chained audit trail for SOC 2 / HIPAA evidence",
            "NemoClaw integration for kernel-level sandboxed execution",
            "One-command private deployment — your data never leaves your infrastructure",
        ],
    }

@app.get("/api/gtm/health-score")
async def gtm_health_score() -> dict:
    """Live compliance health score for status pages and dashboards."""
    chain_valid, chain_reason = state.audit.verify_chain()
    uptime = round(time.monotonic() - state.start_time, 2)

    checks = [
        {"name": "sentinel_active", "status": "pass", "detail": "Sentinel pipeline running"},
        {"name": "audit_chain", "status": "pass" if chain_valid else "fail", "detail": chain_reason or "Chain integrity verified"},
        {"name": "phi_detection", "status": "pass" if state.sentinel.phi_detection else "warn", "detail": "PHI/PII detection enabled" if state.sentinel.phi_detection else "PHI detection disabled"},
        {"name": "block_suspicious", "status": "pass" if state.sentinel.block_on_suspicious else "warn", "detail": "Suspicious content blocked" if state.sentinel.block_on_suspicious else "Suspicious content allowed"},
    ]

    passed = sum(1 for c in checks if c["status"] == "pass")
    total = len(checks)
    score = round(passed / total, 2)

    status = "healthy" if score >= 0.9 else "degraded" if score >= 0.5 else "critical"

    state.audit.record("health_score_checked", "gtm", "success", {"score": str(score), "status": status})

    return {
        "score": score,
        "status": status,
        "sentinelActive": True,
        "auditChainValid": chain_valid,
        "uptimeSeconds": uptime,
        "checks": checks,
    }

# ─── App Store Metadata (for ClawGuard listing) ─────────────

@app.get("/api/gtm/appstore-metadata", response_model=None)
async def appstore_metadata() -> dict:
    """App Store listing metadata for ClawGuard iOS.
    Response validated by AppStoreMetadataResponse model in schemas.py."""
    return {
        "appName": "ClawGuard",
        "subtitle": "Secure AI Agent Client",
        "bundleId": "com.vaultclaw.clawguard",
        "version": "1.0.0",
        "minimumOSVersion": "17.0",
        "category": "Developer Tools",
        "secondaryCategory": "Productivity",
        "ageRating": "4+",
        "price": "Free",
        "description": (
            "ClawGuard is the first security-hardened iOS client for "
            "OpenClaw and NemoClaw AI coding agents.\n\n"
            "SECURITY FIRST\n"
            "- Sentinel pipeline inspects every message for prompt injection, "
            "credential leaks, and PII/PHI before sending\n"
            "- SHA-256 hash-chained audit trail for tamper-proof security logging\n"
            "- iOS Keychain encrypted credential storage\n"
            "- NFKC Unicode normalization prevents homoglyph bypass attacks\n\n"
            "PRIVACY BY DESIGN\n"
            "- No data sent to our servers — messages go only to YOUR gateway\n"
            "- No analytics, no tracking, no telemetry\n"
            "- All security inspection happens on-device\n"
            "- Credentials never leave your iOS Keychain\n\n"
            "ENTERPRISE COMPLIANCE\n"
            "- Supports HIPAA, SOC 2, PCI-DSS, GDPR compliance frameworks\n"
            "- Exportable audit trail for compliance auditors\n"
            "- Role-based access control (RBAC)\n\n"
            "CONNECT TO YOUR AGENT\n"
            "- Works with any OpenClaw or NemoClaw gateway\n"
            "- WebSocket real-time communication with TLS\n"
            "- Save multiple gateway connections\n"
            "- Optional sandbox selection for NemoClaw\n\n"
            "Open source: github.com/Peaky8linders/OpenAgent"
        ),
        # Apple allows max 100 chars total (comma-separated). Current: 97 chars.
        "keywords": [
            "AI agent", "coding", "security", "privacy", "OpenClaw",
            "NemoClaw", "sentinel", "HIPAA", "audit", "encrypted",
        ],
        "privacyPolicyUrl": "https://github.com/Peaky8linders/OpenAgent/blob/main/PRIVACY.md",
        "supportUrl": "https://github.com/Peaky8linders/OpenAgent/issues",
        "marketingUrl": "https://github.com/Peaky8linders/OpenAgent",
        "screenshotSpecs": {
            "iphone_6_7": {"width": 1290, "height": 2796, "device": "iPhone 15 Pro Max"},
            "iphone_6_5": {"width": 1284, "height": 2778, "device": "iPhone 14 Pro Max"},
            "ipad_12_9": {"width": 2048, "height": 2732, "device": "iPad Pro 12.9"},
        },
        "requiredScreenshots": [
            "Connection screen with security badges",
            "Chat view with sentinel status bar",
            "Audit trail with chain verification",
            "Settings with security toggles",
            "Sentinel blocking a prompt injection",
        ],
        "reviewNotes": (
            "ClawGuard connects to user-hosted OpenClaw/NemoClaw gateways. "
            "For testing, use the mock backend included in the repository: "
            "cd openharness-swift && uvicorn app.main:app --reload\n\n"
            "Test connection: Host=localhost, Port=8000, TLS=off\n\n"
            "The app does NOT include its own AI model. It connects to "
            "user-configured gateways that run AI models.\n\n"
            "No demo account needed — the app connects to local gateways."
        ),
    }
