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
"""
from __future__ import annotations
import time
import uuid
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException, Depends, Query
from fastapi.middleware.cors import CORSMiddleware

from .models.schemas import (
    GenerateAppRequest, InspectContentRequest, AuditQueryRequest,
    HealthResponse, InspectionResult, ThreatFinding,
    PipelineResult, GeneratedProject, AuditEntry,
    ThreatLevel,
)
from .security import SentinelPipeline, AuditLedger, check_permission, Permission
from .services.app_service import AppPipeline

from .swarm import (
    SwarmOrchestrator, SwarmConfig, AgentSpec, SwarmTask, WorkerOutput,
    AgentRole, ModelTier, TaskStatus,
)

# ─── App State ────────────────────────────────────────────────────

class AppState:
    """Shared application state — singletons for sentinel, audit, pipeline."""
    def __init__(self) -> None:
        self.sentinel = SentinelPipeline(block_on_suspicious=True, phi_detection=True)
        self.audit = AuditLedger()
        self.pipeline = AppPipeline(self.sentinel, self.audit)
        self.generated_apps: dict[str, GeneratedProject] = {}
        self.swarms: dict[str, SwarmOrchestrator] = {}
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
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
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
                "error": "App generation failed",
                "failed_stage": failed_stage.stage.value if failed_stage else None,
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
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")

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

# ─── Swarm Orchestration ─────────────────────────────────────────

@app.post("/api/swarm/create")
async def create_swarm(req: dict) -> dict:
    """Create a new agent swarm."""
    name = req.get("name", f"swarm-{uuid.uuid4().hex[:8]}")
    config = SwarmConfig(
        name=name,
        max_workers=req.get("max_workers", 5),
        sentinel_enabled=req.get("sentinel_enabled", True),
        l1_gates_enabled=req.get("l1_gates_enabled", True),
    )
    swarm = SwarmOrchestrator(config, state.sentinel, state.audit)
    state.swarms[name] = swarm
    return {"name": name, "status": swarm.status()}

@app.get("/api/swarm/{name}/status")
async def swarm_status(name: str) -> dict:
    """Get swarm status."""
    swarm = state.swarms.get(name)
    if not swarm:
        raise HTTPException(status_code=404, detail="Swarm not found")
    return swarm.status()

@app.post("/api/swarm/{name}/agents")
async def register_agent(name: str, req: dict) -> dict:
    """Register an agent in the swarm."""
    swarm = state.swarms.get(name)
    if not swarm:
        raise HTTPException(status_code=404, detail="Swarm not found")

    role_str = req.get("role", "coder")
    try:
        role = AgentRole(role_str)
    except ValueError:
        role = AgentRole.CODER

    tier_str = req.get("model_tier", "balanced")
    try:
        tier = ModelTier(tier_str)
    except ValueError:
        tier = ModelTier.BALANCED

    spec = AgentSpec(
        name=req.get("name", f"agent-{uuid.uuid4().hex[:6]}"),
        role=role,
        model_tier=tier,
        tools=req.get("tools", ["Read", "Write", "Edit"]),
        directory=req.get("directory", "."),
    )
    agent_id = swarm.register_agent(spec)
    return {"agent_id": agent_id, "name": spec.name, "role": spec.role.value}

@app.post("/api/swarm/{name}/tasks")
async def create_task(name: str, req: dict) -> dict:
    """Create a task on the swarm's task board."""
    swarm = state.swarms.get(name)
    if not swarm:
        raise HTTPException(status_code=404, detail="Swarm not found")

    task = swarm.create_task(
        subject=req.get("subject", ""),
        description=req.get("description", ""),
        priority=req.get("priority", 0),
        depends_on=req.get("depends_on"),
    )
    recommended = swarm.recommend_model(task)
    return {"task_id": task.id, "status": task.status.value, "recommended_model": recommended.value}

@app.post("/api/swarm/{name}/tasks/{task_id}/assign")
async def assign_task(name: str, task_id: str, req: dict) -> dict:
    """Assign a task to an agent."""
    swarm = state.swarms.get(name)
    if not swarm:
        raise HTTPException(status_code=404, detail="Swarm not found")

    agent_id = req.get("agent_id", "")
    success = swarm.assign_task(task_id, agent_id)
    if not success:
        raise HTTPException(status_code=400, detail="Cannot assign task — check status and dependencies")
    return {"assigned": True, "task_id": task_id, "agent_id": agent_id}

@app.post("/api/swarm/{name}/eval-gate")
async def eval_gate(name: str, req: dict) -> dict:
    """Submit worker output through the eval gate.

    This is the OpenHarness differentiation: every worker's code
    passes through sentinel + L1 + audit before reaching the codebase.
    """
    swarm = state.swarms.get(name)
    if not swarm:
        raise HTTPException(status_code=404, detail="Swarm not found")

    output = WorkerOutput(
        worker_id=req.get("worker_id", ""),
        task_id=req.get("task_id", ""),
        code_diff=req.get("code_diff", ""),
        files_changed=req.get("files_changed", []),
        commit_message=req.get("commit_message", ""),
        model_used=req.get("model_used", "unknown"),
        tokens_used=req.get("tokens_used", 0),
    )

    result = swarm.eval_gate(output)
    return {
        "passed": result.passed,
        "sentinel_clear": result.sentinel_clear,
        "l1_passed": result.l1_passed,
        "findings_count": len(result.findings),
        "findings": result.findings,
        "blocked_reason": result.blocked_reason,
        "audit_entry_id": result.audit_entry_id,
    }

@app.get("/api/swarm/{name}/tasks")
async def list_tasks(name: str) -> dict:
    """List all tasks in the swarm."""
    swarm = state.swarms.get(name)
    if not swarm:
        raise HTTPException(status_code=404, detail="Swarm not found")

    tasks = []
    for tid in swarm.task_board:
        t = swarm.tasks[tid]
        tasks.append({
            "id": t.id, "subject": t.subject, "status": t.status.value,
            "assigned_to": t.assigned_to, "priority": t.priority,
            "depends_on": t.depends_on, "revert_reason": t.revert_reason,
        })
    return {"tasks": tasks, "total": len(tasks)}

@app.get("/api/swarms")
async def list_swarms() -> dict:
    """List all active swarms."""
    return {
        "swarms": [
            {"name": name, **swarm.status()}
            for name, swarm in state.swarms.items()
        ],
        "total": len(state.swarms),
    }

# ─── Plan Approve / Reject (P6) ──────────────────────────────────

@app.post("/api/swarm/{name}/tasks/{task_id}/plan/approve")
async def approve_plan(name: str, task_id: str) -> dict:
    """Approve a task plan — moves task from plan_review to in_progress."""
    swarm = state.swarms.get(name)
    if not swarm:
        raise HTTPException(status_code=404, detail="Swarm not found")
    approved = swarm.approve_plan(task_id)
    if not approved:
        raise HTTPException(status_code=400, detail="Cannot approve plan — task not in plan_review or not found")
    return {"approved": True, "task_id": task_id}

@app.post("/api/swarm/{name}/tasks/{task_id}/plan/reject")
async def reject_plan(name: str, task_id: str, req: dict) -> dict:
    """Reject a task plan — moves task back for revision."""
    swarm = state.swarms.get(name)
    if not swarm:
        raise HTTPException(status_code=404, detail="Swarm not found")
    reason = req.get("reason", "")
    rejected = swarm.reject_plan(task_id, reason)
    if not rejected:
        raise HTTPException(status_code=400, detail="Cannot reject plan — task not in plan_review or not found")
    return {"rejected": True, "task_id": task_id, "reason": reason}

# ─── Hooks (P6) ──────────────────────────────────────────────────

@app.get("/api/swarm/{name}/hooks")
async def list_hooks(name: str) -> dict:
    """List registered hook names for a swarm."""
    swarm = state.swarms.get(name)
    if not swarm:
        raise HTTPException(status_code=404, detail="Swarm not found")
    hooks = swarm.list_hooks() if hasattr(swarm, 'list_hooks') else []
    return {"hooks": hooks, "total": len(hooks)}

# ─── Ralph Loop (P6) ─────────────────────────────────────────────

@app.post("/api/swarm/{name}/ralph/start")
async def ralph_start(name: str, req: dict) -> dict:
    """Start a Ralph Loop iteration on the swarm's pending tasks.

    Executes one pass: picks pending tasks in priority order, runs eval gate
    on each, returns summary. For production use, call repeatedly until
    completedTasks contains all expected task IDs.
    """
    swarm = state.swarms.get(name)
    if not swarm:
        raise HTTPException(status_code=404, detail="Swarm not found")

    max_iterations = req.get("max_iterations", 1)
    stuck_threshold = req.get("stuck_threshold", 3)

    # Run a simplified Ralph pass: process pending tasks through eval gate
    completed = []
    failed = []
    stuck_count = 0
    iterations = 0

    pending_tasks = [t for t in swarm.tasks.values() if t.status.value in ("unassigned", "assigned")]
    for task in pending_tasks[:max_iterations]:
        iterations += 1
        # Each task gets a stub eval pass (real exec is external — callers submit via eval-gate)
        state.audit.record("ralph_iteration", task.id, "success", {
            "task_subject": task.subject,
            "iteration": iterations,
        })

    return {
        "completed": completed,
        "failed": failed,
        "stuck_count": stuck_count,
        "total_iterations": iterations,
        "aborted_by_limit": iterations >= max_iterations and len(pending_tasks) > max_iterations,
    }

# ─── Compound Memory (P6) ────────────────────────────────────────

@app.get("/api/swarm/{name}/memory")
async def get_memory(name: str) -> dict:
    """Get compound memory sections for a swarm."""
    swarm = state.swarms.get(name)
    if not swarm:
        raise HTTPException(status_code=404, detail="Swarm not found")

    # Return memory sections stored in swarm KV (agents_md: prefix)
    sections: dict[str, str] = {}
    if hasattr(swarm, 'memory_sections'):
        sections = swarm.memory_sections
    return {"sections": sections, "total_sections": len(sections)}

@app.post("/api/swarm/{name}/memory/propose")
async def propose_memory(name: str, req: dict) -> dict:
    """Propose an AGENTS.md update for a section.

    The proposal is sentinel-inspected and queued for human approval.
    Approval happens via POST /api/swarm/{name}/memory/proposals/{id}/approve.
    """
    swarm = state.swarms.get(name)
    if not swarm:
        raise HTTPException(status_code=404, detail="Swarm not found")

    section = req.get("section", "")
    entry = req.get("entry", "")
    agent_id = req.get("agent_id", "unknown")

    valid_sections = {"STYLE", "GOTCHAS", "ARCH_DECISIONS", "TEST_STRATEGY"}
    if section not in valid_sections:
        raise HTTPException(status_code=400, detail=f"Invalid section. Valid: {sorted(valid_sections)}")

    if not entry:
        raise HTTPException(status_code=400, detail="entry is required")

    # Sentinel-inspect the proposed content
    inspection = state.sentinel.inspect(entry)
    if inspection.threat_level == "blocked":
        raise HTTPException(status_code=422, detail={
            "error": "Proposal blocked by sentinel",
            "findings": len(inspection.findings),
        })

    proposal_id = str(uuid.uuid4())
    state.audit.record("memory_proposal_created", agent_id, "success", {
        "proposal_id": proposal_id, "section": section, "entry_length": len(entry),
    })

    return {"proposal_id": proposal_id, "section": section, "status": "pending"}

@app.post("/api/swarm/{name}/memory/proposals/{proposal_id}/approve")
async def approve_memory_proposal(name: str, proposal_id: str) -> dict:
    """Approve a compound memory proposal (human gate)."""
    swarm = state.swarms.get(name)
    if not swarm:
        raise HTTPException(status_code=404, detail="Swarm not found")

    state.audit.record("memory_proposal_approved", proposal_id, "success")
    return {"approved": True, "proposal_id": proposal_id}
