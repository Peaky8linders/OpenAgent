"""CLI entry point for OpenAgent."""

from __future__ import annotations

import argparse
import sys
import uuid

from langchain_core.messages import HumanMessage

from openagent.agent import create_openagent
from openagent.compliance import get_policy
from openagent.config import load_config
from openagent.memory import graph_stats


def _print_banner(config_path: str, compliance: str = "none") -> None:
    print("\033[1m" + "OpenAgent — Private Coding Agent" + "\033[0m")
    print("Model: Nemotron 3 Super | Runtime: OpenShell | Harness: DeepAgents")
    print(f"Config: {config_path}")

    if compliance and compliance != "none":
        try:
            policy = get_policy(compliance)
            print(f"\033[33mCompliance: {policy.framework.value.upper()}"
                  f" — {policy.description}\033[0m")
        except ValueError as e:
            print(f"\033[31mCompliance error: {e}\033[0m")

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


def run_task(
    config_path: str, task: str, compliance: str | None = None,
) -> None:
    """Run a single task and exit."""
    config = load_config(config_path)
    if compliance is not None:
        config = config.model_copy(update={"compliance": compliance})
    agent = create_openagent(config, task=task)
    thread_id = str(uuid.uuid4())

    result = agent.invoke(
        {"messages": [HumanMessage(content=task)]},
        config={"configurable": {"thread_id": thread_id}},
    )
    print(_extract_reply(result))


def run_interactive(config_path: str, compliance: str | None = None) -> None:
    """Run the interactive REPL."""
    config = load_config(config_path)
    if compliance is not None:
        config = config.model_copy(update={"compliance": compliance})
    agent = create_openagent(config)
    thread_id = str(uuid.uuid4())

    _print_banner(config_path, config.compliance)

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
    parser.add_argument(
        "--compliance",
        type=str,
        default=None,
        choices=["none", "hipaa", "soc2", "pci", "gdpr"],
        help="Compliance mode (overrides YAML config if set)",
    )
    parser.add_argument(
        "--airgap",
        action="store_true",
        help="Air-gap mode: use local Ollama LLM, zero outbound network",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="qwen3:32b",
        help="Ollama model for air-gap mode (default: qwen3:32b)",
    )
    parser.add_argument(
        "--dashboard",
        action="store_true",
        help="Start compliance dashboard API on port 3200",
    )
    args = parser.parse_args()

    # Start dashboard if requested
    if args.dashboard:
        import threading

        from openagent.dashboard import start_dashboard

        dashboard = start_dashboard(port=3200)
        threading.Thread(target=dashboard.serve_forever, daemon=True).start()
        print("Dashboard: http://127.0.0.1:3200/dashboard/summary")

    # Air-gap mode banner
    if args.airgap:
        from openagent.airgap import print_airgap_banner

        print_airgap_banner(args.model)

    if args.task:
        run_task(args.config, args.task, args.compliance)
    else:
        run_interactive(args.config, args.compliance)

    sys.exit(0)
