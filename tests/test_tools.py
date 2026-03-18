"""Tests for brainiac agent tools."""

from __future__ import annotations

from openagent.tools import memory_save, memory_search, memory_stats


class TestMemorySearchTool:
    """Tests for the memory_search tool."""

    def test_tool_has_name(self) -> None:
        assert memory_search.name == "memory_search"

    def test_tool_returns_string(self) -> None:
        result = memory_search.invoke({"query": "coding patterns"})
        assert isinstance(result, str)

    def test_tool_with_no_results(self) -> None:
        result = memory_search.invoke({"query": "xyzzy_nonexistent_12345"})
        assert isinstance(result, str)


class TestMemoryStatsTool:
    """Tests for the memory_stats tool."""

    def test_tool_has_name(self) -> None:
        assert memory_stats.name == "memory_stats"

    def test_tool_returns_stats(self) -> None:
        result = memory_stats.invoke({})
        assert isinstance(result, str)
        assert "nodes" in result.lower() or "not available" in result.lower()


class TestMemorySaveTool:
    """Tests for the memory_save tool."""

    def test_tool_has_name(self) -> None:
        assert memory_save.name == "memory_save"

    # NOTE: We don't test actual saving here to avoid polluting the graph.
    # Integration tests would cover that.
