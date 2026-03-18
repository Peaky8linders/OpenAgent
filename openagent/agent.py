"""Agent factory — wires model + backend + config + memory into a DeepAgent."""

from __future__ import annotations

from deepagents import create_deep_agent
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph.state import CompiledStateGraph

from openagent.backend import create_backend
from openagent.config import OpenAgentConfig
from openagent.memory import get_context_for_task
from openagent.model import create_model
from openagent.tools import memory_save, memory_search, memory_stats

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

## Persistent Memory
You have access to a knowledge graph that persists across sessions and projects.
Use `memory_search` at the start of tasks to check for relevant patterns and solutions.
Use `memory_save` when you discover reusable knowledge (patterns, solutions, decisions).
Knowledge types: pattern, antipattern, workflow, hypothesis, solution, decision.
{knowledge_context}"""


def build_system_prompt(config: OpenAgentConfig, task: str | None = None) -> str:
    """Build the system prompt from config, optionally with task-relevant knowledge.

    Args:
        config: Agent configuration.
        task: Optional task description to search for relevant context.

    Returns:
        Formatted system prompt string.
    """
    context = ""
    if task:
        ctx = get_context_for_task(task, max_items=3)
        if ctx:
            context = f"\n\n{ctx}"

    return SYSTEM_PROMPT.format(
        name=config.agent.name,
        version=config.agent.version,
        knowledge_context=context,
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

    return create_deep_agent(
        model=model,
        tools=[memory_search, memory_save, memory_stats],
        backend=backend,
        system_prompt=build_system_prompt(config, task=task),
        checkpointer=checkpointer,
        name=config.agent.name,
    )
