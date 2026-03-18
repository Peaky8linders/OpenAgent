"""Brainiac knowledge graph integration for persistent agent memory.

Provides the agent with:
- Semantic search across past learnings, patterns, solutions, decisions
- Ability to save new knowledge after completing tasks
- Context injection from relevant prior knowledge before tasks

Uses the brainiac knowledge graph at ~/.claude/knowledge/ with:
- Typed nodes: pattern, antipattern, workflow, hypothesis, solution, decision
- Typed edges: semantic, temporal, causal, entity
- Intent-aware multi-hop retrieval (A-MEM / MAGMA inspired)
- 384-dim sentence-transformer embeddings
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path
from typing import Any

# Add brainiac to import path
KNOWLEDGE_ROOT = Path.home() / ".claude" / "knowledge"
if str(KNOWLEDGE_ROOT) not in sys.path:
    sys.path.insert(0, str(KNOWLEDGE_ROOT))


def _graph_available() -> bool:
    """Check if brainiac graph is available."""
    return (KNOWLEDGE_ROOT / "brainiac" / "__init__.py").exists()


def search_knowledge(query: str, top_k: int = 5) -> list[dict[str, Any]]:
    """Search the knowledge graph for relevant nodes.

    Uses intent-aware multi-hop retrieval to find patterns,
    solutions, decisions, and other knowledge relevant to the query.

    Args:
        query: Natural language search query.
        top_k: Maximum results to return.

    Returns:
        List of dicts with keys: id, content, type, score, keywords, path.
        Empty list if brainiac is not available.
    """
    if not _graph_available():
        return []

    from brainiac.embeddings import load_embeddings
    from brainiac.graph import BrainiacGraph
    from brainiac.retriever import retrieve

    graph = BrainiacGraph()
    all_embs = load_embeddings()
    results = retrieve(graph, query, top_k=top_k, all_embeddings=all_embs)

    return [
        {
            "id": r.node.id,
            "content": r.node.content,
            "type": r.node.metadata.get("type", "unknown"),
            "score": round(r.score, 3),
            "keywords": r.node.keywords,
            "path": r.relations,
        }
        for r in results
    ]


def save_learning(
    content: str,
    node_type: str = "pattern",
    keywords: list[str] | None = None,
    tags: list[str] | None = None,
    project: str = "openagent",
    confidence: str = "medium",
) -> str | None:
    """Save a new learning to the knowledge graph.

    Args:
        content: The knowledge to save.
        node_type: One of: pattern, antipattern, workflow, hypothesis, solution, decision.
        keywords: Key concepts (max 8). Auto-extracted if not provided.
        tags: Category tags.
        project: Project name for linking.
        confidence: One of: high, medium, low.

    Returns:
        The new node ID, or None if brainiac is not available.
    """
    if not _graph_available():
        return None

    from brainiac.embeddings import embed, load_embeddings, save_embeddings
    from brainiac.graph import BrainiacGraph, MemoryNode
    from brainiac.linker import link_new_node

    graph = BrainiacGraph()
    node_id = graph.next_id(node_type)

    node = MemoryNode(
        id=node_id,
        content=content,
        timestamp=datetime.now().isoformat(timespec="seconds"),
        keywords=keywords or [],
        tags=tags or [],
        context=content[:200],
        metadata={
            "type": node_type,
            "projects": [project],
            "confidence": confidence,
            "status": "active",
            "source": "openagent",
        },
    )

    # Compute embedding from content + keywords + tags
    embed_text = " ".join([node.content] + node.keywords + node.tags)
    node.embedding = embed(embed_text)

    # Add to graph and auto-link
    graph.add_node(node)
    all_embs = load_embeddings()
    all_embs[node.id] = node.embedding
    link_new_node(graph, node, all_embs)

    # Persist
    save_embeddings(all_embs)
    graph.save()

    return node_id


def get_context_for_task(task: str, max_items: int = 3) -> str:
    """Get relevant knowledge context for a task.

    Searches the graph and formats results as a context block
    that can be injected into the agent's system prompt.

    Args:
        task: The task description.
        max_items: Maximum context items.

    Returns:
        Formatted context string, or empty string if no relevant knowledge.
    """
    results = search_knowledge(task, top_k=max_items)
    if not results:
        return ""

    lines = ["## Relevant Knowledge (from memory graph)"]
    for r in results:
        if r["score"] < 0.3:
            continue
        lines.append(f"\n**[{r['type']}] {r['id']}** (relevance: {r['score']})")
        lines.append(r["content"])
        if r["keywords"]:
            lines.append(f"Keywords: {', '.join(r['keywords'])}")

    return "\n".join(lines) if len(lines) > 1 else ""


def graph_stats() -> dict[str, Any] | None:
    """Get knowledge graph statistics.

    Returns:
        Dict with node/edge counts and type breakdowns, or None if unavailable.
    """
    if not _graph_available():
        return None

    from brainiac.graph import BrainiacGraph

    graph = BrainiacGraph()
    return graph.stats()
