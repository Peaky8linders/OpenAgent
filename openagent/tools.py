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

# Module-level policy ref — set by create_openagent() via set_active_policy()
_active_policy: object | None = None  # CompliancePolicy or None


def set_active_policy(policy: object | None) -> None:
    """Set the active compliance policy for LCM tools.

    Called by create_openagent() so tools enforce the correct policy.
    """
    global _active_policy  # noqa: PLW0603
    _active_policy = policy


def _get_lcm_client():
    """Lazy-init LCM client."""
    try:
        from openagent.lcm_client import LcmClient, _is_lcm_running

        if not _is_lcm_running():
            return None
        return LcmClient()
    except Exception:
        return None


def _check_policy_patterns(content: str) -> str | None:
    """Check content against active policy's sentinel_extra_patterns.

    Returns a block reason string if patterns match, None if clear.
    This enforces policy-specific patterns locally BEFORE sending
    to LCM, closing the gap where sentinel_extra_patterns were
    defined but never applied.
    """
    if _active_policy is None:
        return None

    import re

    patterns = getattr(_active_policy, "sentinel_extra_patterns", [])
    for p in patterns:
        pattern_str = p.get("pattern", "")
        category = p.get("category", "unknown")
        if pattern_str and re.search(pattern_str, content):
            return f"Policy pattern matched: {category}"
    return None


@tool
def secure_store(
    content: Annotated[str, "Message content to store securely"],
    role: Annotated[str, "Message role: user, assistant, tool, or system"] = "assistant",
    conversation_id: Annotated[str, "Conversation identifier"] = "default",
) -> str:
    """Store a message in the encrypted, sentinel-protected LCM memory.

    Content is automatically:
    - Scanned against active compliance policy patterns (PHI, PCI, etc.)
    - Scanned by LCM sentinel for prompt injection/exfiltration
    - Checked for PII (emails, phone numbers, SSNs, API keys, etc.)
    - Compressed and topic-segmented
    - Stored with encryption at rest
    - Logged to tamper-proof audit trail

    Use this to persist important conversation context securely.
    """
    # Local policy pattern check (enforces sentinel_extra_patterns)
    block_reason = _check_policy_patterns(content)
    if block_reason:
        return f"BLOCKED by compliance policy: {block_reason}"

    client = _get_lcm_client()
    if not client:
        return "LCM secure memory not available (server not running)."

    try:
        result = client.ingest(content, role=role, conversation_id=conversation_id)
        pii = "PII detected" if result.get("piiDetected") else "No PII"
        cleared = result.get("sentinelCleared", result.get("sentinel_cleared"))
        sentinel = "Sentinel cleared" if cleared else "BLOCKED by sentinel"
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
def eval_check(
    content: Annotated[str, "Content to check for security/compliance issues"],
    target_content: Annotated[str | None, "Source code to analyze for unsafe patterns"] = None,
) -> str:
    """Run L1 security assertions on content before committing.

    Checks for:
    - PII leakage (emails, SSNs, phone numbers, API keys, etc.)
    - Cross-tenant data isolation
    - Unsafe code patterns (eval(), any type, SQL injection)
    - Store health

    Under active compliance policy, also checks policy-specific patterns
    (PHI for HIPAA, cardholder data for PCI, credentials for SOC 2, etc.).

    Use BEFORE writing files or returning sensitive content.
    """
    # Local policy pattern check first
    block_reason = _check_policy_patterns(content)
    if block_reason:
        return f"BLOCKED: {block_reason}"

    client = _get_lcm_client()
    if not client:
        return "LCM not available — running local PII check only."

    try:
        result = client.run_l1(content, target_content=target_content)
        if result.get("passed"):
            count = len(result.get("assertions", []))
            ms = result.get("totalMs", 0)
            return f"All {count} security checks passed ({ms}ms)."

        failures = [
            a for a in result.get("assertions", []) if not a.get("passed")
        ]
        lines = [f"FAILED {len(failures)} check(s):"]
        for f in failures:
            lines.append(f"  - {f.get('name')}: {f.get('reason', 'no reason')}")
        return "\n".join(lines)
    except Exception as e:
        return f"Eval error: {e}"


@tool
def eval_quality(
    input_text: Annotated[str, "What was asked (the task/prompt)"],
    output_text: Annotated[str, "What was produced (the response/code)"],
    context: Annotated[str, "Relevant context the agent should have used"] = "",
) -> str:
    """Run L2 quality judges on agent work.

    Evaluates for failure modes:
    - Context loss: did the response use provided context correctly?
    - Hallucination: does it contain unsupported claims?
    - Instruction following: did it respect constraints?
    - PII leakage: does it expose personal information?
    - Prompt injection: was the agent manipulated?

    Use AFTER completing a task to validate quality.
    Note: Requires the agent's LLM to score each judge prompt.
    """
    client = _get_lcm_client()
    if not client:
        return "LCM not available — cannot run quality judges."

    try:
        judges = client.list_judges()
        lines = [f"Available judges: {len(judges)}"]
        for j in judges:
            lines.append(f"  - {j.get('name')} ({j.get('failureMode')})")
        lines.append("")
        lines.append("To run L2 judges, score each judge prompt via your LLM and submit results.")
        lines.append("Use eval_gate for the full automated pipeline (L1 + metric).")
        return "\n".join(lines)
    except Exception as e:
        return f"Eval error: {e}"


@tool
def eval_gate(
    hypothesis: Annotated[str, "What improvement this change makes"],
    output: Annotated[str, "The content/code produced"],
    primary_metric: Annotated[float, "Current quality metric (0.0-1.0)"],
    baseline_metric: Annotated[float, "Previous baseline metric to beat"],
    target_content: Annotated[str | None, "Source code to analyze for unsafe patterns"] = None,
) -> str:
    """Full eval gate: L1 security checks + metric comparison → commit/revert decision.

    Pipeline:
    1. L1 hard gates (PII, isolation, unsafe patterns) — any fail = REVERT
    2. Primary metric comparison — must improve over baseline
    3. Time budget check

    Returns a COMMIT or REVERT decision with explanation.

    Use BEFORE finalizing multi-step work to validate the overall change.
    """
    # Local policy check first
    block_reason = _check_policy_patterns(output)
    if block_reason:
        return f"REVERT: Compliance policy blocked — {block_reason}"

    client = _get_lcm_client()
    if not client:
        return "LCM not available — cannot run eval gate."

    try:
        result = client.run_eval(
            hypothesis=hypothesis,
            output=output,
            primary_metric=primary_metric,
            baseline_metric=baseline_metric,
            target_content=target_content,
        )
        decision = result.get("decision", "revert").upper()
        lines = [f"Decision: {decision}"]

        if result.get("revertReason"):
            lines.append(f"Reason: {result['revertReason']}")

        l1 = result.get("l1", {})
        l1_status = "PASSED" if l1.get("passed") else "FAILED"
        l1_fails = l1.get("failCount", 0)
        lines.append(f"L1 gates: {l1_status} ({l1_fails} failures)")

        metric_improved = result.get("metricImproved", False)
        cur = result.get("primaryMetric", 0)
        base = result.get("baselineMetric", 0)
        m_label = "improved" if metric_improved else "NOT improved"
        lines.append(f"Metric: {cur:.3f} vs baseline {base:.3f} ({m_label})")
        budget = "within" if result.get("withinBudget") else "OVER"
        lines.append(f"Time: {result.get('totalMs', 0)}ms ({budget} budget)")

        return "\n".join(lines)
    except Exception as e:
        return f"Eval gate error: {e}"


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
