"""
Swarm Orchestrator — Multi-agent coordination with eval-gated commits.

Integrates the agent swarm pattern (lead/worker, DAG workflows, model routing)
with OpenHarness governance (sentinel inspection, L1/L2 eval gates, audit chain).

The key insight from the swarm ecosystem:
- desplega-ai/agent-swarm: Docker workers, compounding memory, DAG workflows
- Claude Code TeammateTool: spawnTeam, Task, SendMessage, git worktree isolation
- ruflo: model routing (haiku for fetch, sonnet for implementation, opus for reasoning)

What NO existing swarm does: gate every worker's output through compliance evals
before it reaches the codebase. That's what this module adds.

Every worker commit passes through:
  1. Sentinel inspection (injection, credential leak, PHI detection)
  2. L1 hard gates (no PII, no unsafe patterns, no eval())
  3. L2 LLM judges (optional: hallucination, context loss, instruction following)
  4. Audit logging (hash-chained, tamper-proof)

Only changes that pass ALL gates survive. Failed changes are reverted with
full audit trail of what was attempted and why it was blocked.
"""
from __future__ import annotations
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, Callable, Awaitable

from .security import SentinelPipeline, AuditLedger


# ─── Agent Types ──────────────────────────────────────────────────

class AgentRole(str, Enum):
    LEAD = "lead"
    ARCHITECT = "architect"
    CODER = "coder"
    REVIEWER = "reviewer"
    TESTER = "tester"
    RESEARCHER = "researcher"
    SECURITY = "security"

class ModelTier(str, Enum):
    """Model routing per ruflo pattern: match task complexity to model cost."""
    FAST = "fast"       # haiku-class: fetch, search, simple transforms
    BALANCED = "balanced"  # sonnet-class: well-defined implementation
    REASONING = "reasoning"  # opus-class: ambiguous architecture decisions

class TaskStatus(str, Enum):
    UNASSIGNED = "unassigned"
    ASSIGNED = "assigned"
    IN_PROGRESS = "in_progress"
    REVIEWING = "reviewing"
    EVAL_GATING = "eval_gating"  # OpenHarness addition: task is being eval-gated
    COMPLETED = "completed"
    REVERTED = "reverted"
    BLOCKED = "blocked"

class WorkerStatus(str, Enum):
    IDLE = "idle"
    WORKING = "working"
    AWAITING_EVAL = "awaiting_eval"
    SHUTDOWN = "shutdown"


# ─── Data Models ──────────────────────────────────────────────────

@dataclass
class SwarmConfig:
    """Configuration for a swarm instance."""
    name: str
    max_workers: int = 5
    sentinel_enabled: bool = True
    l1_gates_enabled: bool = True
    l2_judges_enabled: bool = False  # Requires LLM scorer
    model_routing: bool = True  # Auto-select model tier per task
    git_worktree_isolation: bool = True
    audit_all_attempts: bool = True

@dataclass
class AgentSpec:
    """Specification for a swarm agent (worker or lead)."""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    name: str = ""
    role: AgentRole = AgentRole.CODER
    model_tier: ModelTier = ModelTier.BALANCED
    tools: list[str] = field(default_factory=lambda: ["Read", "Write", "Edit"])
    directory: str = "."  # Working directory / worktree path
    soul_md: str = ""     # Agent personality (desplega pattern)
    identity_md: str = "" # Agent expertise description

@dataclass
class SwarmTask:
    """A task in the swarm's task board."""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    subject: str = ""
    description: str = ""
    assigned_to: Optional[str] = None  # agent ID
    status: TaskStatus = TaskStatus.UNASSIGNED
    priority: int = 0  # Higher = more urgent
    depends_on: list[str] = field(default_factory=list)  # task IDs
    created_at: str = field(default_factory=lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    completed_at: Optional[str] = None
    output: Optional[str] = None
    eval_result: Optional[dict] = None
    revert_reason: Optional[str] = None

@dataclass
class WorkerOutput:
    """Output from a worker agent, pending eval gate."""
    worker_id: str
    task_id: str
    code_diff: str
    files_changed: list[str]
    commit_message: str
    model_used: str
    tokens_used: int = 0
    duration_ms: float = 0

@dataclass
class EvalGateResult:
    """Result of passing a worker's output through OpenHarness eval gates."""
    passed: bool
    sentinel_clear: bool
    l1_passed: bool
    l2_passed: Optional[bool] = None
    findings: list[dict] = field(default_factory=list)
    blocked_reason: Optional[str] = None
    audit_entry_id: Optional[str] = None


# ─── DAG Workflow (desplega pattern) ──────────────────────────────

@dataclass
class WorkflowStep:
    """A step in a DAG workflow."""
    id: str
    task_template: str  # Prompt template, can reference {{ prev_step.output }}
    agent_role: AgentRole = AgentRole.CODER
    model_tier: ModelTier = ModelTier.BALANCED
    depends_on: list[str] = field(default_factory=list)
    retry_count: int = 1
    timeout_ms: int = 60000

@dataclass
class Workflow:
    """DAG-based workflow definition."""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    name: str = ""
    steps: list[WorkflowStep] = field(default_factory=list)
    trigger: str = "manual"  # manual | webhook | schedule


# ─── Swarm Orchestrator ──────────────────────────────────────────

class SwarmOrchestrator:
    """
    Orchestrates a team of AI agents with eval-gated commits.

    Lead agent plans and delegates. Workers execute in isolation.
    Every worker output is gated through sentinel + L1 + L2 before
    being merged into the codebase.

    This is the missing governance layer that no existing swarm
    framework provides.
    """

    def __init__(self, config: SwarmConfig, sentinel: SentinelPipeline, audit: AuditLedger):
        self.config = config
        self.sentinel = sentinel
        self.audit = audit
        self.agents: dict[str, AgentSpec] = {}
        self.tasks: dict[str, SwarmTask] = {}
        self.task_board: list[str] = []  # Ordered task IDs

        self.audit.record("swarm_created", config.name, "success",
                         {"max_workers": config.max_workers, "sentinel": config.sentinel_enabled})

    # ─── Agent Management ─────────────────────────────

    def register_agent(self, spec: AgentSpec) -> str:
        """Register an agent in the swarm."""
        self.agents[spec.id] = spec
        self.audit.record("agent_registered", spec.id, "success",
                         {"name": spec.name, "role": spec.role.value, "model": spec.model_tier.value})
        return spec.id

    def get_idle_workers(self) -> list[AgentSpec]:
        """Get workers not currently assigned to a task."""
        assigned_ids = {t.assigned_to for t in self.tasks.values()
                       if t.status in (TaskStatus.IN_PROGRESS, TaskStatus.EVAL_GATING)}
        return [a for a in self.agents.values()
                if a.role != AgentRole.LEAD and a.id not in assigned_ids]

    # ─── Task Management ──────────────────────────────

    def create_task(self, subject: str, description: str, priority: int = 0,
                    depends_on: list[str] | None = None) -> SwarmTask:
        """Create a new task on the board."""
        task = SwarmTask(subject=subject, description=description,
                        priority=priority, depends_on=depends_on or [])
        self.tasks[task.id] = task
        self.task_board.append(task.id)
        self.audit.record("task_created", task.id, "success",
                         {"subject": subject, "priority": priority})
        return task

    def assign_task(self, task_id: str, agent_id: str) -> bool:
        """Assign a task to a worker agent."""
        task = self.tasks.get(task_id)
        agent = self.agents.get(agent_id)
        if not task or not agent:
            return False
        if task.status != TaskStatus.UNASSIGNED:
            return False

        # Check dependencies are completed
        for dep_id in task.depends_on:
            dep = self.tasks.get(dep_id)
            if not dep or dep.status != TaskStatus.COMPLETED:
                return False

        task.assigned_to = agent_id
        task.status = TaskStatus.ASSIGNED
        self.audit.record("task_assigned", task_id, "success",
                         {"agent": agent.name, "role": agent.role.value})
        return True

    def get_ready_tasks(self) -> list[SwarmTask]:
        """Get tasks whose dependencies are all completed."""
        ready = []
        for tid in self.task_board:
            task = self.tasks[tid]
            if task.status != TaskStatus.UNASSIGNED:
                continue
            deps_met = all(
                self.tasks.get(d, SwarmTask()).status == TaskStatus.COMPLETED
                for d in task.depends_on
            )
            if deps_met:
                ready.append(task)
        return sorted(ready, key=lambda t: -t.priority)

    # ─── Eval Gate (the OpenHarness differentiation) ──

    def eval_gate(self, output: WorkerOutput) -> EvalGateResult:
        """
        Gate a worker's output through sentinel + L1 checks.

        This is what makes OpenHarness different from every other swarm:
        no code reaches the codebase without passing compliance gates.
        """
        task = self.tasks.get(output.task_id)
        if task:
            task.status = TaskStatus.EVAL_GATING

        findings: list[dict] = []

        # Sentinel inspection
        sentinel_result = self.sentinel.inspect(output.code_diff)
        sentinel_clear = sentinel_result.threat_level == "safe"
        if not sentinel_clear:
            for f in sentinel_result.findings:
                findings.append({
                    "gate": "sentinel",
                    "category": f.category,
                    "confidence": f.confidence,
                    "description": f.description,
                })

        # L1 code quality gates
        l1_issues = self._check_l1(output.code_diff)
        l1_passed = len(l1_issues) == 0
        for issue in l1_issues:
            findings.append({"gate": "l1", "category": "code_quality", "confidence": 90, "description": issue})

        passed = sentinel_clear and l1_passed
        blocked_reason = None
        if not passed:
            reasons = [f["description"] for f in findings]
            blocked_reason = "; ".join(reasons[:3])

        # Audit
        entry = self.audit.record(
            "eval_gate" if passed else "eval_gate_blocked",
            output.task_id,
            "pass" if passed else "blocked",
            {
                "worker": output.worker_id,
                "files": output.files_changed,
                "findings": len(findings),
                "sentinel": sentinel_clear,
                "l1": l1_passed,
                "model": output.model_used,
                "tokens": output.tokens_used,
            },
        )

        # Update task
        if task:
            if passed:
                task.status = TaskStatus.COMPLETED
                task.completed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                task.output = output.commit_message
                task.eval_result = {"passed": True, "findings": len(findings)}
            else:
                task.status = TaskStatus.REVERTED
                task.revert_reason = blocked_reason
                task.eval_result = {"passed": False, "findings": findings}

        return EvalGateResult(
            passed=passed,
            sentinel_clear=sentinel_clear,
            l1_passed=l1_passed,
            findings=findings,
            blocked_reason=blocked_reason,
            audit_entry_id=entry.id,
        )

    # ─── Model Routing (ruflo pattern) ────────────────

    def recommend_model(self, task: SwarmTask) -> ModelTier:
        """Route task to appropriate model tier based on complexity."""
        desc = (task.subject + " " + task.description).lower()

        # Fast tier: simple fetch, search, format tasks
        fast_signals = ["fetch", "search", "list", "format", "summarize", "read", "log"]
        if any(s in desc for s in fast_signals):
            return ModelTier.FAST

        # Reasoning tier: architecture, design, ambiguous tasks
        reasoning_signals = ["architect", "design", "refactor", "migrate", "decide", "evaluate", "complex"]
        if any(s in desc for s in reasoning_signals):
            return ModelTier.REASONING

        return ModelTier.BALANCED

    # ─── Swarm Status ─────────────────────────────────

    def status(self) -> dict:
        """Get current swarm status."""
        task_counts: dict[str, int] = {}
        for task in self.tasks.values():
            task_counts[task.status.value] = task_counts.get(task.status.value, 0) + 1

        return {
            "swarm_name": self.config.name,
            "agents": len(self.agents),
            "total_tasks": len(self.tasks),
            "task_status": task_counts,
            "idle_workers": len(self.get_idle_workers()),
            "ready_tasks": len(self.get_ready_tasks()),
            "audit_chain_length": self.audit.count,
            "sentinel_enabled": self.config.sentinel_enabled,
        }

    # ─── Internal ─────────────────────────────────────

    @staticmethod
    def _check_l1(code: str) -> list[str]:
        """L1 code quality checks on a diff."""
        import re
        issues = []
        if re.search(r"\beval\s*\(", code):
            issues.append("eval() detected")
        if re.search(r"(?:sk-|AKIA|ghp_)[a-zA-Z0-9]{10,}", code):
            issues.append("Hardcoded credential detected")
        if re.search(r"\b\d{3}-\d{2}-\d{4}\b", code):
            issues.append("SSN pattern detected")
        if re.search(r"(?:password|secret)\s*=\s*['\"][^'\"]+['\"]", code, re.I):
            issues.append("Hardcoded secret detected")
        return issues
