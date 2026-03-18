"""CLI entry point for OpenAgent."""

from __future__ import annotations

import argparse
import sys
import uuid

from langchain_core.messages import HumanMessage

from openagent.agent import create_openagent
from openagent.config import load_config
from openagent.memory import graph_stats


def _print_banner(config_path: str) -> None:
    print("\033[1m" + "OpenAgent — Private Coding Agent" + "\033[0m")
    print("Model: Nemotron 3 Super | Runtime: OpenShell | Harness: DeepAgents")
    print(f"Config: {config_path}")

    # Show knowledge graph status
    stats = graph_stats()
    if stats:
        n = stats["total_nodes"]
        e = stats["total_edges"]
        print(f"Memory: {n} nodes, {e} edges in knowledge graph")

    print("Type 'exit' to quit, 'clear' to reset context.\n")


def _extract_reply(result: dict) -> str:
    """Extract the final assistant text from agent result."""
    messages = result.get("messages", [])
    for msg in reversed(messages):
        if hasattr(msg, "type") and msg.type == "ai" and msg.content:
            return msg.content
    return "(no response)"


def run_task(config_path: str, task: str) -> None:
    """Run a single task and exit."""
    config = load_config(config_path)
    agent = create_openagent(config, task=task)
    thread_id = str(uuid.uuid4())

    result = agent.invoke(
        {"messages": [HumanMessage(content=task)]},
        config={"configurable": {"thread_id": thread_id}},
    )
    print(_extract_reply(result))


def run_interactive(config_path: str) -> None:
    """Run the interactive REPL."""
    config = load_config(config_path)
    agent = create_openagent(config)
    thread_id = str(uuid.uuid4())

    _print_banner(config_path)

    while True:
        try:
            user_input = input("\033[32m>>> \033[0m")
        except (EOFError, KeyboardInterrupt):
            print("\nGoodbye.")
            break

        stripped = user_input.strip().lower()
        if stripped in ("exit", "quit", "q"):
            print("Goodbye.")
            break

        if stripped == "clear":
            thread_id = str(uuid.uuid4())
            print("Context cleared.\n")
            continue

        if not user_input.strip():
            continue

        try:
            result = agent.invoke(
                {"messages": [HumanMessage(content=user_input)]},
                config={"configurable": {"thread_id": thread_id}},
            )
            print(_extract_reply(result))
            print()
        except KeyboardInterrupt:
            print("\n(interrupted)")
        except Exception as e:
            print(f"\033[31mError: {e}\033[0m\n")


def main() -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="OpenAgent — Private Coding Agent",
        epilog="Stack: Nemotron 3 Super + OpenShell + DeepAgents",
    )
    parser.add_argument(
        "--task",
        type=str,
        help="Task to execute (single-shot mode)",
    )
    parser.add_argument(
        "--config",
        type=str,
        default="config/agent-config.yaml",
        help="Path to agent config YAML (default: config/agent-config.yaml)",
    )
    args = parser.parse_args()

    if args.task:
        run_task(args.config, args.task)
    else:
        run_interactive(args.config)

    sys.exit(0)
