"""Agent factory — wires model + backend + config + memory into a DeepAgent."""

from __future__ import annotations

from deepagents import create_deep_agent
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph.state import CompiledStateGraph

from openagent.backend import create_backend
from openagent.compliance import get_policy
from openagent.config import OpenAgentConfig
from openagent.memory import get_context_for_task
from openagent.model import create_model
from openagent.tools import (
    audit_trail,
    memory_save,
    memory_search,
    memory_stats,
    secure_search,
    secure_store,
    set_active_policy,
)

SYSTEM_PROMPT = """\
You are {name} v{version} — a private coding agent running on a fully open-source stack.

Stack: Nemotron 3 Super (model) + OpenShell (runtime) + DeepAgents (harness).

No code or data leaves the user's infrastructure. You run inside a policy-governed \
sandbox with deny-by-default network, filesystem, and process controls.

## How you work
- Read files, understand existing patterns before changing anything.
- Make changes, then verify them (run tests, lint, type-check).
- Use the todo list for multi-step tasks.
- Spawn sub-agents for parallel workstreams when it helps.
- Be concise. Don't narrate — just do.

## Dual Memory System
You have two memory systems:

### Brainiac (cross-project knowledge graph)
Use `memory_search` to check for patterns, solutions, and decisions from past sessions.
Use `memory_save` to record reusable knowledge (pattern, antipattern, etc.).

### LCM Secure Memory (per-session encrypted store)
Use `secure_store` to persist context with encryption, PII detection, and sentinel.
Use `secure_search` to search past conversations.
Use `audit_trail` to view the tamper-proof compliance audit chain.
LCM memory is HIPAA/SOC 2 ready: encrypted at rest, PII auto-detected, all access logged.
{compliance_context}{knowledge_context}"""


def _build_compliance_context(config: OpenAgentConfig) -> str:
    """Build compliance rules for the system prompt."""
    if config.compliance == "none":
        return ""

    policy = get_policy(config.compliance)
    lines = [
        f"\n\n## Active Compliance: {policy.framework.value.upper()}",
        f"{policy.description}",
        "",
        "**MANDATORY RULES — violations are logged and may be blocked:**",
    ]

    if policy.pii_handling.value != "annotate":
        lines.append(f"- PII handling: {policy.pii_handling.value}")
    if policy.pii_types_blocked:
        lines.append(
            f"- NEVER output these PII types: {', '.join(policy.pii_types_blocked)}"
        )
    if policy.requires_baa:
        lines.append("- BAA required for all third-party data processors")
    if policy.requires_encryption_at_rest:
        lines.append("- All data must be encrypted at rest")
    if policy.network_loopback_only:
        lines.append("- Network: loopback only (no external connections)")
    lines.append("- All actions are logged to tamper-proof audit trail")
    lines.append(f"- Audit retention: {policy.audit_retention_days} days")
    lines.append(
        "- Use `audit_trail` to verify compliance before completing tasks"
    )

    return "\n".join(lines)


def build_system_prompt(config: OpenAgentConfig, task: str | None = None) -> str:
    """Build the system prompt from config with compliance and knowledge context.

    Args:
        config: Agent configuration.
        task: Optional task description to search for relevant context.

    Returns:
        Formatted system prompt string.
    """
    knowledge = ""
    if task:
        ctx = get_context_for_task(task, max_items=3)
        if ctx:
            knowledge = f"\n\n{ctx}"

    compliance = _build_compliance_context(config)

    return SYSTEM_PROMPT.format(
        name=config.agent.name,
        version=config.agent.version,
        compliance_context=compliance,
        knowledge_context=knowledge,
    )


def create_openagent(
    config: OpenAgentConfig,
    *,
    task: str | None = None,
) -> CompiledStateGraph:
    """Create a fully-wired OpenAgent with persistent memory.

    This wires together:
    - Model: ChatNVIDIA (Nemotron 3 Super)
    - Backend: LocalShellBackend (filesystem + shell)
    - Checkpointer: MemorySaver (multi-turn memory)
    - Tools: memory_search, memory_save, memory_stats (brainiac knowledge graph)
    - All DeepAgents middleware (planning, filesystem, sub-agents, summarization)

    Args:
        config: Validated agent configuration.
        task: Optional initial task for context-aware prompt construction.

    Returns:
        Compiled LangGraph agent ready for invoke/stream.
    """
    model = create_model(config.model)
    backend = create_backend(config)
    checkpointer = MemorySaver()

    # Wire active compliance policy into LCM tools for enforcement
    if config.compliance != "none":
        policy = get_policy(config.compliance)
        set_active_policy(policy)
    else:
        set_active_policy(None)

    return create_deep_agent(
        model=model,
        tools=[
            memory_search, memory_save, memory_stats,  # Brainiac
            secure_store, secure_search, audit_trail,   # LCM
        ],
        backend=backend,
        system_prompt=build_system_prompt(config, task=task),
        checkpointer=checkpointer,
        name=config.agent.name,
    )
