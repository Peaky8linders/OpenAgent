"""Custom tools for OpenAgent — brainiac knowledge graph integration.

These tools give the agent the ability to:
- Search persistent memory for relevant patterns, solutions, decisions
- Save new learnings after completing tasks
- Check what knowledge is available
"""

from __future__ import annotations

from typing import Annotated

from langchain_core.tools import tool

from openagent.memory import graph_stats, save_learning, search_knowledge


@tool
def memory_search(
    query: Annotated[str, "Natural language search query"],
    top_k: Annotated[int, "Maximum results to return"] = 5,
) -> str:
    """Search the persistent knowledge graph for relevant patterns, solutions, and decisions.

    Use this when:
    - Starting a new task (check for relevant prior knowledge)
    - Debugging (search for known solutions to similar errors)
    - Making architecture decisions (check for prior decisions and patterns)
    - Looking for antipatterns to avoid

    Returns formatted search results with relevance scores.
    """
    results = search_knowledge(query, top_k=top_k)
    if not results:
        return "No relevant knowledge found in the memory graph."

    lines = []
    for r in results:
        lines.append(f"[{r['type']}] {r['id']} (score: {r['score']})")
        lines.append(f"  {r['content']}")
        if r["keywords"]:
            lines.append(f"  Keywords: {', '.join(r['keywords'])}")
        if r["path"]:
            lines.append(f"  Found via: {' → '.join(r['path'])}")
        lines.append("")

    return "\n".join(lines)


@tool
def memory_save(
    content: Annotated[str, "The knowledge or learning to save"],
    node_type: Annotated[
        str,
        "Type of knowledge: pattern, antipattern, workflow, hypothesis, solution, or decision",
    ] = "pattern",
    keywords: Annotated[
        list[str] | None,
        "Key concepts (max 8)",
    ] = None,
    tags: Annotated[
        list[str] | None,
        "Category tags for organization",
    ] = None,
) -> str:
    """Save a new learning or insight to the persistent knowledge graph.

    Use this when:
    - You discover a reusable pattern
    - You fix a bug and want to remember the solution
    - You make an architecture decision worth recording
    - You find an antipattern to avoid in the future

    The knowledge persists across sessions and projects.
    """
    node_id = save_learning(
        content=content,
        node_type=node_type,
        keywords=keywords or [],
        tags=tags or [],
    )
    if node_id:
        return f"Saved as {node_id} in knowledge graph. Auto-linked to related nodes."
    return "Knowledge graph not available. Learning not saved."


@tool
def memory_stats() -> str:
    """Show statistics about the persistent knowledge graph.

    Returns node counts by type, edge counts, and connectivity info.
    """
    stats = graph_stats()
    if not stats:
        return "Knowledge graph not available."

    lines = [
        f"Knowledge Graph: {stats['total_nodes']} nodes, {stats['total_edges']} edges",
        "",
        "Nodes by type:",
    ]
    for ntype, count in sorted(stats.get("nodes_by_type", {}).items()):
        lines.append(f"  {ntype}: {count}")

    lines.append("\nEdges by relation:")
    for rel, count in sorted(stats.get("edges_by_relation", {}).items()):
        lines.append(f"  {rel}: {count}")

    most = stats.get("most_connected", [])
    if most:
        lines.append("\nMost connected nodes:")
        for entry in most[:5]:
            nid = entry.get("id", entry) if isinstance(entry, dict) else entry[0]
            conns = entry.get("connections", "?") if isinstance(entry, dict) else entry[1]
            lines.append(f"  {nid}: {conns} connections")

    return "\n".join(lines)
