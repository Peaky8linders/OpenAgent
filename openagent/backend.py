"""Backend factory for OpenAgent."""

from __future__ import annotations

from pathlib import Path

from deepagents.backends.local_shell import LocalShellBackend
from deepagents.backends.protocol import BackendProtocol

from openagent.config import OpenAgentConfig


def create_backend(
    config: OpenAgentConfig,
    *,
    root_dir: str | Path | None = None,
) -> BackendProtocol:
    """Create the execution backend.

    Returns a LocalShellBackend that gives the agent:
    - Filesystem access (ls, read, write, edit, glob, grep)
    - Shell execution (execute tool)

    All tools are wired automatically by DeepAgents when this
    backend is passed to create_deep_agent().

    Args:
        config: Agent configuration.
        root_dir: Working directory. Defaults to cwd.

    Returns:
        Backend implementing SandboxBackendProtocol.
    """
    return LocalShellBackend(
        root_dir=root_dir or Path.cwd(),
        virtual_mode=False,
        inherit_env=True,
        timeout=120,
    )
