"""Tests for backend factory."""

from __future__ import annotations

from pathlib import Path

from deepagents.backends.local_shell import LocalShellBackend

from openagent.backend import create_backend
from openagent.config import OpenAgentConfig


class TestCreateBackend:
    """Tests for backend creation."""

    def test_returns_local_shell_backend(self) -> None:
        config = OpenAgentConfig()
        backend = create_backend(config)
        assert isinstance(backend, LocalShellBackend)

    def test_uses_custom_root_dir(self, tmp_path: Path) -> None:
        config = OpenAgentConfig()
        backend = create_backend(config, root_dir=tmp_path)
        assert isinstance(backend, LocalShellBackend)
        assert backend.cwd == tmp_path

    def test_backend_can_execute(self, tmp_path: Path) -> None:
        config = OpenAgentConfig()
        backend = create_backend(config, root_dir=tmp_path)
        result = backend.execute("echo hello")
        assert result.exit_code == 0
        assert "hello" in result.output

    def test_backend_can_read_write(self, tmp_path: Path) -> None:
        config = OpenAgentConfig()
        backend = create_backend(config, root_dir=tmp_path)
        # With virtual_mode=False, paths are relative to cwd or absolute.
        # Use the tmp_path as an absolute path for the test file.
        test_file = str(tmp_path / "test.txt")
        backend.write(test_file, "hello world")
        content = backend.read(test_file)
        assert "hello world" in content
