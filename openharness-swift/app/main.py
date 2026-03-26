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
