"""Custom tools for OpenAgent — dual memory system.

Brainiac tools: cross-project knowledge graph (patterns, solutions, decisions)
LCM tools: per-session secure memory (encrypted, PII-aware, sentinel-protected, audit-trailed)
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


# ─── LCM Secure Memory Tools ─────────────────────────────────


def _get_lcm_client():
    """Lazy-init LCM client."""
    try:
        from openagent.lcm_client import LcmClient, _is_lcm_running

        if not _is_lcm_running():
            return None
        return LcmClient()
    except Exception:
        return None


@tool
def secure_store(
    content: Annotated[str, "Message content to store securely"],
    role: Annotated[str, "Message role: user, assistant, tool, or system"] = "assistant",
    conversation_id: Annotated[str, "Conversation identifier"] = "default",
) -> str:
    """Store a message in the encrypted, sentinel-protected LCM memory.

    Content is automatically:
    - Scanned by sentinel for prompt injection/exfiltration attempts
    - Checked for PII (emails, phone numbers, SSNs, API keys, etc.)
    - Compressed and topic-segmented
    - Stored with encryption at rest
    - Logged to tamper-proof audit trail

    Use this to persist important conversation context securely.
    """
    client = _get_lcm_client()
    if not client:
        return "LCM secure memory not available (server not running)."

    try:
        result = client.ingest(content, role=role, conversation_id=conversation_id)
        pii = "PII detected" if result.get("piiDetected") else "No PII"
        sentinel = "Sentinel cleared" if result.get("sentinelCleared") else "BLOCKED by sentinel"
        return f"Stored securely. {sentinel}. {pii}."
    except Exception as e:
        if "403" in str(e):
            return "BLOCKED by sentinel: content flagged as unsafe."
        return f"Error: {e}"


@tool
def secure_search(
    query: Annotated[str, "Search query for conversation history"],
    conversation_id: Annotated[str | None, "Filter to specific conversation"] = None,
    limit: Annotated[int, "Maximum results"] = 10,
) -> str:
    """Search past conversations in the encrypted LCM memory.

    Supports full-text search across all stored messages.
    Results are PII-aware and access-controlled via RBAC.
    """
    client = _get_lcm_client()
    if not client:
        return "LCM secure memory not available (server not running)."

    try:
        results = client.search(query, conversation_id=conversation_id, limit=limit)
        if not results:
            return "No matching messages found."

        lines = [f"Found {len(results)} results:"]
        for r in results:
            msg = r.get("message", r)
            lines.append(f"  [{msg.get('role', '?')}] {msg.get('content', '')[:200]}")
        return "\n".join(lines)
    except Exception as e:
        return f"Search error: {e}"


@tool
def audit_trail(
    limit: Annotated[int, "Maximum audit entries to return"] = 20,
) -> str:
    """Query the tamper-proof audit trail from LCM secure memory.

    Returns cryptographically hash-chained audit entries showing:
    - Every message stored, searched, or deleted
    - Every sentinel block or flag
    - Every RBAC check (success or failure)
    - Chain integrity verification status

    Use this for compliance reporting and security review.
    """
    client = _get_lcm_client()
    if not client:
        return "LCM secure memory not available (server not running)."

    try:
        data = client.audit(limit=limit)
        chain = data.get("chain", {})
        entries = data.get("entries", [])

        lines = [
            f"Audit Trail: {data.get('count', 0)} entries",
            f"Chain Integrity: {'VALID' if chain.get('valid') else 'BROKEN'}",
            "",
        ]
        for e in entries[-10:]:  # Show last 10
            ts = e.get("timestamp", "?")[:19]
            typ = e.get("type", "?")
            out = e.get("outcome", "?")
            lines.append(f"  [{ts}] {typ} -> {out}")

        return "\n".join(lines)
    except Exception as e:
        return f"Audit error: {e}"
