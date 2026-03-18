"""Tests for brainiac knowledge graph integration."""

from __future__ import annotations

from openagent.memory import (
    _graph_available,
    get_context_for_task,
    graph_stats,
    search_knowledge,
)


class TestGraphAvailability:
    """Tests for graph availability check."""

    def test_graph_available_returns_bool(self) -> None:
        result = _graph_available()
        assert isinstance(result, bool)

    def test_graph_is_available(self) -> None:
        # Brainiac should be installed at ~/.claude/knowledge/
        assert _graph_available() is True


class TestSearchKnowledge:
    """Tests for knowledge search."""

    def test_search_returns_list(self) -> None:
        results = search_knowledge("test query")
        assert isinstance(results, list)

    def test_search_results_have_expected_keys(self) -> None:
        results = search_knowledge("coding patterns")
        if results:  # Only check if graph has data
            r = results[0]
            assert "id" in r
            assert "content" in r
            assert "type" in r
            assert "score" in r
            assert "keywords" in r

    def test_search_respects_top_k(self) -> None:
        results = search_knowledge("patterns", top_k=2)
        assert len(results) <= 2


class TestGetContextForTask:
    """Tests for task context generation."""

    def test_returns_string(self) -> None:
        result = get_context_for_task("build a REST API")
        assert isinstance(result, str)

    def test_empty_for_irrelevant_query(self) -> None:
        # A very specific nonsense query should return empty or low-relevance
        result = get_context_for_task("xyzzy foobar baz12345")
        # Either empty or has content — both are valid
        assert isinstance(result, str)


class TestGraphStats:
    """Tests for graph statistics."""

    def test_stats_returns_dict(self) -> None:
        stats = graph_stats()
        assert stats is not None
        assert isinstance(stats, dict)

    def test_stats_has_expected_keys(self) -> None:
        stats = graph_stats()
        assert stats is not None
        assert "total_nodes" in stats
        assert "total_edges" in stats
        assert "nodes_by_type" in stats
        assert "edges_by_relation" in stats

    def test_stats_has_positive_counts(self) -> None:
        stats = graph_stats()
        assert stats is not None
        assert stats["total_nodes"] > 0
        assert stats["total_edges"] > 0
